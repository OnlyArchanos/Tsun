const {
  evaluateProfanityDensity,
  buildStyleRewriteInput,
  chooseDenserDraft,
} = require('./chatStyle');

const MISTRAL_CHAT_URL = 'https://api.mistral.ai/v1/chat/completions';
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

function targetKey({ provider, model }) {
  return `${provider}:${model}`;
}

class AiProviderError extends Error {
  constructor({ provider = null, model = null, kind, status = null, retryable = false }) {
    super(`AI provider ${provider || 'unknown'} failed (${kind}).`);
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

function classifyHttpStatus(target, response) {
  const details = { provider: target.provider, model: target.model, status: response.status };
  if (response.status === 401 || response.status === 403) {
    return new AiProviderError({ ...details, kind: 'auth' });
  }
  if (response.status === 400 || response.status === 422) {
    return new AiProviderError({ ...details, kind: 'bad_request' });
  }
  if (response.status === 402) {
    const retryAfter = response.headers?.get?.('retry-after');
    return new AiProviderError({
      ...details,
      kind: retryAfter ? 'quota_temporary' : 'quota',
      retryable: Boolean(retryAfter),
    });
  }
  if (response.status === 404) {
    return new AiProviderError({ ...details, kind: 'model_unavailable', retryable: true });
  }
  if (response.status === 429) {
    return new AiProviderError({ ...details, kind: 'rate_limit', retryable: true });
  }
  if (response.status >= 500) {
    return new AiProviderError({ ...details, kind: 'server', retryable: true });
  }
  return new AiProviderError({ ...details, kind: 'bad_response', retryable: true });
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

  const targets = Array.isArray(config.TARGETS)
    ? config.TARGETS
      .filter((target) => target && typeof target.provider === 'string' && typeof target.model === 'string')
      .map((target) => ({ provider: target.provider, model: target.model }))
    : [];
  const health = new Map(targets.map((target) => [targetKey(target), {
    provider: target.provider,
    model: target.model,
    status: 'unknown',
    lastAttemptAt: null,
    consecutiveFailures: 0,
    openUntil: null,
  }]));
  let openRouterQuota = { remaining: null, checkedAt: null };

  function getTargetHealth(target) {
    const key = targetKey(target);
    if (!health.has(key)) {
      health.set(key, {
        provider: target.provider,
        model: target.model,
        status: 'unknown',
        lastAttemptAt: null,
        consecutiveFailures: 0,
        openUntil: null,
      });
    }
    return health.get(key);
  }

  function recordSuccess(target) {
    health.set(targetKey(target), {
      provider: target.provider,
      model: target.model,
      status: 'ok',
      lastAttemptAt: now(),
      consecutiveFailures: 0,
      openUntil: null,
    });
  }

  function recordFailure(target, error) {
    const current = getTargetHealth(target);
    const consecutiveFailures = error.retryable
      ? current.consecutiveFailures + 1
      : current.consecutiveFailures;
    health.set(targetKey(target), {
      ...current,
      status: error.kind,
      lastAttemptAt: now(),
      consecutiveFailures,
      openUntil: error.retryable && consecutiveFailures >= config.CIRCUIT_FAILURE_THRESHOLD
        ? now() + config.CIRCUIT_OPEN_MS
        : current.openUntil,
    });
  }

  function assertCircuitClosed(target) {
    const state = getTargetHealth(target);
    if (state.openUntil && now() < state.openUntil) {
      throw new AiProviderError({ ...target, kind: 'circuit_open', retryable: true });
    }
    if (state.openUntil) {
      health.set(targetKey(target), { ...state, openUntil: null, consecutiveFailures: 0 });
    }
  }

  async function fetchJsonWithTimeout(url, options, timeoutMs, target) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal });
      if (!response?.ok) return { response, data: null };
      try {
        return { response, data: await response.json() };
      } catch (cause) {
        if (cause?.name === 'AbortError' || controller.signal.aborted) throw cause;
        throw new AiProviderError({ ...target, kind: 'bad_response', retryable: true });
      }
    } catch (cause) {
      if (cause instanceof AiProviderError) throw cause;
      throw new AiProviderError({
        ...target,
        kind: cause?.name === 'AbortError' || controller.signal.aborted ? 'timeout' : 'network',
        retryable: true,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  function buildProviderRequest(target, requestMessages) {
    const body = {
      model: target.model,
      messages: requestMessages.map((message) => ({ ...message })),
      max_tokens: config.MAX_OUTPUT_TOKENS,
      temperature: config.TEMPERATURE,
    };

    if (target.provider === 'mistral') {
      if (!config.MISTRAL_API_KEY) throw new AiProviderError({ ...target, kind: 'auth' });
      return {
        url: MISTRAL_CHAT_URL,
        options: {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.MISTRAL_API_KEY}`,
          },
          body: JSON.stringify(body),
        },
      };
    }

    if (target.provider === 'openrouter') {
      if (!config.OPENROUTER_API_KEY) throw new AiProviderError({ ...target, kind: 'auth' });
      Object.assign(body, MODEL_PROFILES[target.model] || {});
      return {
        url: OPENROUTER_CHAT_URL,
        options: {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
          },
          body: JSON.stringify(body),
        },
      };
    }

    throw new AiProviderError({ ...target, kind: 'bad_request' });
  }

  async function callTarget(target, requestMessages, deadlineAt) {
    try {
      assertCircuitClosed(target);
      const request = buildProviderRequest(target, requestMessages);
      const result = await runProviderAttempt(() => {
        const remainingMs = deadlineAt - now();
        if (remainingMs <= 0) {
          throw new AiProviderError({ ...target, kind: 'deadline', retryable: true });
        }
        return fetchJsonWithTimeout(
          request.url,
          request.options,
          Math.min(config.REQUEST_TIMEOUT_MS, remainingMs),
          target,
        );
      }, { deadlineAt, provider: target.provider });

      const response = result?.response;
      if (!response || typeof response.ok !== 'boolean' || typeof response.status !== 'number') {
        throw new AiProviderError({ ...target, kind: 'bad_response', retryable: true });
      }
      if (!response.ok) throw classifyHttpStatus(target, response);

      const text = normalizeResponseContent(result.data?.choices?.[0]?.message?.content);
      if (!text) throw new AiProviderError({ ...target, kind: 'bad_response', retryable: true });
      recordSuccess(target);
      return {
        text,
        provider: target.provider,
        model: target.model,
        usage: normalizeUsage(result.data?.usage),
      };
    } catch (cause) {
      const error = cause instanceof AiProviderError
        ? cause
        : new AiProviderError({
          ...target,
          kind: cause?.kind === 'provider_deadline' ? 'deadline' : 'network',
          retryable: true,
        });
      if (target.provider === 'openrouter' && error.kind === 'quota') {
        openRouterQuota = { remaining: 0, checkedAt: now() };
      }
      if (!['deadline', 'quota_temporary', 'circuit_open'].includes(error.kind)) {
        recordFailure(target, error);
      }
      throw error;
    }
  }

  async function refreshOpenRouterQuota(deadlineAt) {
    if (!config.OPENROUTER_API_KEY) return openRouterQuota;
    if (openRouterQuota.checkedAt !== null && now() - openRouterQuota.checkedAt < 60000) {
      return openRouterQuota;
    }
    if (deadlineAt - now() <= 0) return openRouterQuota;
    try {
      const result = await fetchJsonWithTimeout(OPENROUTER_KEY_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${config.OPENROUTER_API_KEY}` },
      }, Math.min(3000, deadlineAt - now()), { provider: 'openrouter', model: null });
      if (!result?.response?.ok) return openRouterQuota;
      const raw = result.data?.data?.limit_remaining ?? result.data?.limit_remaining;
      const remaining = raw === null || raw === undefined || raw === '' ? null : Number(raw);
      openRouterQuota = {
        remaining: Number.isFinite(remaining) ? remaining : null,
        checkedAt: now(),
      };
    } catch {
      openRouterQuota = { ...openRouterQuota, checkedAt: now() };
    }
    return openRouterQuota;
  }

  async function enforceOpenRouterReserve(deadlineAt) {
    const current = await refreshOpenRouterQuota(deadlineAt);
    if (current.remaining !== null && current.remaining <= config.FALLBACK_QUOTA_RESERVE) {
      throw new AiProviderError({ provider: 'openrouter', kind: 'quota_reserve' });
    }
  }

  async function applyStyle(result, target, requestMessages, deadlineAt) {
    if (config.MAX_STYLE_REWRITES < 1 || evaluateProfanityDensity(result.text).passes) return result;
    if (deadlineAt - now() <= 0) return result;
    const rewriteMessages = [
      ...requestMessages.map((message) => ({ ...message })),
      { role: 'assistant', content: result.text },
      { role: 'user', content: buildStyleRewriteInput(result.text) },
    ];
    try {
      const rewritten = await callTarget(target, rewriteMessages, deadlineAt);
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
    const failedProviders = new Set();
    let openRouterReserveChecked = false;
    let lastError = null;

    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      if (failedProviders.has(target.provider)) continue;

      if (target.provider === 'openrouter' && index > 0 && !openRouterReserveChecked) {
        openRouterReserveChecked = true;
        await enforceOpenRouterReserve(deadlineAt);
      }

      try {
        const result = await callTarget(target, requestMessages, deadlineAt);
        return await applyStyle(result, target, requestMessages, deadlineAt);
      } catch (error) {
        lastError = error;
        if (!(error instanceof AiProviderError)) throw error;
        if (error.kind === 'auth') {
          failedProviders.add(target.provider);
          logger.warn?.(`[AI] ${target.provider} authentication failed; trying next provider.`);
          continue;
        }
        if (!error.retryable) throw error;
        logger.warn?.(`[AI] ${target.provider}/${target.model} failed (${error.kind}); trying next target.`);
      }
    }
    throw lastError || new AiProviderError({ kind: 'model_unavailable', retryable: true });
  }

  function getHealth() {
    const targetStates = Object.fromEntries([...health].map(([key, state]) => [key, { ...state }]));
    return {
      targets: targetStates,
      openRouterQuota: { ...openRouterQuota },
      models: targetStates,
      quota: { ...openRouterQuota },
    };
  }

  return { generate, getHealth };
}

module.exports = {
  MODEL_PROFILES,
  AiProviderError,
  createAiClient,
  normalizeResponseContent,
  targetKey,
};
