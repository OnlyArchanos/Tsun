const {
  evaluateProfanityDensity,
  buildStyleRewriteInput,
  chooseDenserDraft,
} = require('./chatStyle');

const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key';

const MODEL_PROFILES = Object.freeze({
  'stealth/space-bunny-alpha': Object.freeze({
    reasoning: Object.freeze({ effort: 'low', exclude: true }),
  }),
  'nvidia/nemotron-3-ultra-550b-a55b:free': Object.freeze({
    reasoning: Object.freeze({ effort: 'low', exclude: true }),
  }),
  'inclusionai/ling-3.0-flash-fin:free': Object.freeze({}),
});

class AiProviderError extends Error {
  constructor({ provider = 'openrouter', model = null, kind, status = null, retryable = false }) {
    super(`AI provider ${provider} failed (${kind}).`);
    this.name = 'AiProviderError';
    this.provider = provider;
    this.model = model;
    this.kind = kind;
    this.status = status;
    this.retryable = retryable;
  }
}

function normalizeResponseContent(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n');
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const values = [usage.prompt_tokens, usage.completion_tokens, usage.total_tokens].map(Number);
  if (!values.every(Number.isFinite)) return null;
  return { promptTokens: values[0], completionTokens: values[1], totalTokens: values[2] };
}

function classifyHttpStatus(model, response) {
  const status = response.status;
  if (status === 401 || status === 403) {
    return new AiProviderError({ model, kind: 'auth', status });
  }
  if (status === 400 || status === 422) {
    return new AiProviderError({ model, kind: 'bad_request', status });
  }
  if (status === 402) {
    const retryAfter = response.headers?.get?.('retry-after');
    return new AiProviderError({
      model,
      kind: retryAfter ? 'quota_temporary' : 'quota',
      status,
      retryable: Boolean(retryAfter),
    });
  }
  if (status === 404) {
    return new AiProviderError({ model, kind: 'model_unavailable', status, retryable: true });
  }
  if (status === 429) {
    return new AiProviderError({ model, kind: 'rate_limit', status, retryable: true });
  }
  if (status >= 500) {
    return new AiProviderError({ model, kind: 'server', status, retryable: true });
  }
  return new AiProviderError({ model, kind: 'bad_response', status, retryable: true });
}

function createAiClient({
  config,
  fetchImpl = global.fetch,
  logger = console,
  now = Date.now,
  runProviderAttempt = (task) => task(),
} = {}) {
  if (!config) throw new TypeError('AI client config is required.');
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');

  const models = [config.PRIMARY_MODEL, ...(config.FALLBACK_MODELS || [])].filter(Boolean);
  const health = new Map(models.map((model) => [model, {
    status: 'unknown', lastAttemptAt: null, consecutiveFailures: 0, openUntil: null,
  }]));
  let quota = { remaining: null, checkedAt: null };

  function getModelHealth(model) {
    if (!health.has(model)) {
      health.set(model, { status: 'unknown', lastAttemptAt: null, consecutiveFailures: 0, openUntil: null });
    }
    return health.get(model);
  }

  function recordSuccess(model) {
    health.set(model, { status: 'ok', lastAttemptAt: now(), consecutiveFailures: 0, openUntil: null });
  }

  function recordFailure(model, error) {
    const current = getModelHealth(model);
    const consecutiveFailures = error.retryable ? current.consecutiveFailures + 1 : current.consecutiveFailures;
    health.set(model, {
      status: error.kind,
      lastAttemptAt: now(),
      consecutiveFailures,
      openUntil: error.retryable && consecutiveFailures >= config.CIRCUIT_FAILURE_THRESHOLD
        ? now() + config.CIRCUIT_OPEN_MS
        : current.openUntil,
    });
  }

  function assertCircuitClosed(model) {
    const state = getModelHealth(model);
    if (state.openUntil && now() < state.openUntil) {
      throw new AiProviderError({ model, kind: 'circuit_open', retryable: true });
    }
    if (state.openUntil) {
      health.set(model, { ...state, openUntil: null, consecutiveFailures: 0 });
    }
  }

  async function fetchJsonWithTimeout(url, options, timeoutMs, model) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal });
      if (!response?.ok) return { response, data: null };
      try {
        return { response, data: await response.json() };
      } catch (cause) {
        if (cause?.name === 'AbortError' || controller.signal.aborted) throw cause;
        throw new AiProviderError({ model, kind: 'bad_response', retryable: true });
      }
    } catch (cause) {
      if (cause instanceof AiProviderError) throw cause;
      throw new AiProviderError({
        model,
        kind: cause?.name === 'AbortError' || controller.signal.aborted ? 'timeout' : 'network',
        retryable: true,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function callModel(model, requestMessages, deadlineAt) {
    assertCircuitClosed(model);
    if (!config.OPENROUTER_API_KEY) {
      throw new AiProviderError({ model, kind: 'auth' });
    }
    const profile = MODEL_PROFILES[model] || {};
    const body = {
      model,
      messages: requestMessages.map((message) => ({ ...message })),
      max_tokens: config.MAX_OUTPUT_TOKENS,
      temperature: config.TEMPERATURE,
      ...profile,
    };

    try {
      const result = await runProviderAttempt(() => {
        const remainingMs = deadlineAt - now();
        if (remainingMs <= 0) {
          throw new AiProviderError({ model, kind: 'deadline', retryable: true });
        }
        return fetchJsonWithTimeout(
          OPENROUTER_CHAT_URL,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
            },
            body: JSON.stringify(body),
          },
          Math.min(config.REQUEST_TIMEOUT_MS, remainingMs),
          model,
        );
      }, { deadlineAt });

      const response = result?.response;
      if (!response || typeof response.ok !== 'boolean' || typeof response.status !== 'number') {
        throw new AiProviderError({ model, kind: 'bad_response', retryable: true });
      }
      if (!response.ok) throw classifyHttpStatus(model, response);

      const data = result.data;
      const text = normalizeResponseContent(data?.choices?.[0]?.message?.content);
      if (!text) throw new AiProviderError({ model, kind: 'bad_response', retryable: true });
      recordSuccess(model);
      return { text, provider: 'openrouter', model, usage: normalizeUsage(data.usage) };
    } catch (cause) {
      const error = cause instanceof AiProviderError
        ? cause
        : new AiProviderError({
          model,
          kind: cause?.kind === 'provider_deadline' ? 'deadline' : 'network',
          retryable: true,
        });
      if (error.kind === 'quota') quota = { remaining: 0, checkedAt: now() };
      if (error.kind !== 'deadline' && error.kind !== 'quota_temporary') recordFailure(model, error);
      throw error;
    }
  }

  async function refreshQuota(deadlineAt) {
    if (quota.checkedAt !== null && now() - quota.checkedAt < 60000) return quota;
    if (deadlineAt - now() <= 0) return quota;
    try {
      const result = await fetchJsonWithTimeout(OPENROUTER_KEY_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${config.OPENROUTER_API_KEY}` },
      }, Math.min(3000, deadlineAt - now()), null);
      if (!result?.response?.ok) return quota;
      const body = result.data;
      const raw = body?.data?.limit_remaining ?? body?.limit_remaining;
      const remaining = raw === null || raw === undefined || raw === '' ? null : Number(raw);
      quota = { remaining: Number.isFinite(remaining) ? remaining : null, checkedAt: now() };
    } catch {
      quota = { ...quota, checkedAt: now() };
    }
    return quota;
  }

  async function enforceFallbackReserve(deadlineAt) {
    const current = await refreshQuota(deadlineAt);
    if (current.remaining !== null && current.remaining <= config.FALLBACK_QUOTA_RESERVE) {
      throw new AiProviderError({ kind: 'quota_reserve' });
    }
  }

  async function applyStyle(result, requestMessages, deadlineAt) {
    if (config.MAX_STYLE_REWRITES < 1 || evaluateProfanityDensity(result.text).passes) return result;
    if (deadlineAt - now() <= 0) return result;
    const rewriteMessages = [
      ...requestMessages.map((message) => ({ ...message })),
      { role: 'assistant', content: result.text },
      { role: 'user', content: buildStyleRewriteInput(result.text) },
    ];
    try {
      const rewritten = await callModel(result.model, rewriteMessages, deadlineAt);
      return { ...rewritten, text: chooseDenserDraft(result.text, rewritten.text) };
    } catch (error) {
      logger.warn?.(`[AI] Style rewrite failed (${error.kind || 'unknown'}).`);
      return result;
    }
  }

  async function generate(requestMessages, options = {}) {
    if (!Array.isArray(requestMessages)) throw new TypeError('Messages must be an array.');
    const deadlineAt = Number.isFinite(options.deadlineAt)
      ? Math.min(options.deadlineAt, now() + config.TOTAL_DEADLINE_MS)
      : now() + config.TOTAL_DEADLINE_MS;
    let lastError = null;

    for (let index = 0; index < models.length; index += 1) {
      const model = models[index];
      if (index > 0) await enforceFallbackReserve(deadlineAt);
      try {
        const result = await callModel(model, requestMessages, deadlineAt);
        return await applyStyle(result, requestMessages, deadlineAt);
      } catch (error) {
        lastError = error;
        if (!(error instanceof AiProviderError) || !error.retryable) throw error;
        logger.warn?.(`[AI] ${model} failed (${error.kind}); trying next model.`);
      }
    }
    throw lastError || new AiProviderError({ kind: 'model_unavailable', retryable: true });
  }

  function getHealth() {
    return {
      models: Object.fromEntries([...health].map(([model, state]) => [model, { ...state }])),
      quota: { ...quota },
    };
  }

  return { generate, getHealth };
}

module.exports = {
  MODEL_PROFILES,
  AiProviderError,
  createAiClient,
  normalizeResponseContent,
};
