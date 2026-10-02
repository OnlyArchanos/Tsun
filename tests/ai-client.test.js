const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createAiClient,
  AiProviderError,
  normalizeResponseContent,
  MODEL_PROFILES,
  targetKey,
} = require('../utils/aiClient');

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    async json() { return body; },
  };
}

function makeConfig(overrides = {}) {
  return {
    MISTRAL_API_KEY: 'mistral-secret',
    OPENROUTER_API_KEY: 'router-secret',
    TARGETS: [
      { provider: 'mistral', model: 'ministral-14b-2512' },
      { provider: 'mistral', model: 'ministral-8b-2512' },
      { provider: 'openrouter', model: 'stealth/space-bunny-alpha' },
    ],
    MAX_OUTPUT_TOKENS: 300,
    TEMPERATURE: 0.85,
    REQUEST_TIMEOUT_MS: 50,
    TOTAL_DEADLINE_MS: 500,
    FALLBACK_QUOTA_RESERVE: 5,
    CIRCUIT_FAILURE_THRESHOLD: 2,
    CIRCUIT_OPEN_MS: 60000,
    MAX_STYLE_REWRITES: 0,
    ...overrides,
  };
}

const messages = [
  { role: 'system', content: 'system' },
  { role: 'user', content: 'hello' },
];

const denseReply = 'Fuck this damn shit, the answer fucking works.';

test('uses official Mistral first without mutating input', async () => {
  const calls = [];
  const input = structuredClone(messages);
  const client = createAiClient({
    config: makeConfig(),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, {
        choices: [{ message: { content: denseReply } }],
        usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
      });
    },
  });

  const result = await client.generate(input);
  const body = JSON.parse(calls[0].options.body);

  assert.equal(calls[0].url, 'https://api.mistral.ai/v1/chat/completions');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer mistral-secret');
  assert.equal(body.model, 'ministral-14b-2512');
  assert.equal(body.reasoning, undefined);
  assert.equal(result.provider, 'mistral');
  assert.equal(result.model, 'ministral-14b-2512');
  assert.deepEqual(result.usage, { promptTokens: 4, completionTokens: 6, totalTokens: 10 });
  assert.deepEqual(input, messages);
});

test('applies OpenRouter model profiles only to OpenRouter requests', async () => {
  const calls = [];
  const client = createAiClient({
    config: makeConfig({ TARGETS: [{ provider: 'openrouter', model: 'stealth/space-bunny-alpha' }] }),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, { choices: [{ message: { content: denseReply } }] });
    },
  });

  const result = await client.generate(messages);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer router-secret');
  assert.deepEqual(body.reasoning, { effort: 'low', exclude: true });
  assert.equal(result.provider, 'openrouter');
});

test('normalizes string and text-array content', () => {
  assert.equal(normalizeResponseContent(' hello '), 'hello');
  assert.equal(normalizeResponseContent([{ type: 'text', text: 'one' }, { type: 'text', text: ' two ' }]), 'one\ntwo');
  assert.equal(normalizeResponseContent([]), '');
});

test('falls through retryable failures in exact target order', async () => {
  const posts = [];
  const client = createAiClient({
    config: makeConfig(),
    fetchImpl: async (url, options) => {
      if (options.method === 'GET') return response(200, { data: { limit_remaining: 100 } });
      const body = JSON.parse(options.body);
      posts.push([url, body.model]);
      if (posts.length === 1) return response(429, {});
      if (posts.length === 2) return response(503, {});
      return response(200, { choices: [{ message: { content: denseReply } }] });
    },
    logger: { warn() {} },
  });

  const result = await client.generate(messages);
  assert.equal(result.provider, 'openrouter');
  assert.deepEqual(posts.map((entry) => entry[1]), [
    'ministral-14b-2512',
    'ministral-8b-2512',
    'stealth/space-bunny-alpha',
  ]);
});

test('provider authentication failure skips its remaining targets', async () => {
  const postModels = [];
  const client = createAiClient({
    config: makeConfig(),
    fetchImpl: async (_url, options) => {
      if (options.method === 'GET') return response(200, { data: { limit_remaining: 100 } });
      const model = JSON.parse(options.body).model;
      postModels.push(model);
      if (model === 'ministral-14b-2512') return response(401, { message: 'do not expose' });
      return response(200, { choices: [{ message: { content: denseReply } }] });
    },
    logger: { warn() {} },
  });

  const result = await client.generate(messages);
  assert.equal(result.provider, 'openrouter');
  assert.deepEqual(postModels, ['ministral-14b-2512', 'stealth/space-bunny-alpha']);
  assert.equal(client.getHealth().targets['mistral:ministral-14b-2512'].status, 'auth');
});

test('does not hide malformed-request failures behind another provider', async () => {
  for (const status of [400, 422]) {
    let posts = 0;
    const client = createAiClient({
      config: makeConfig(),
      fetchImpl: async () => {
        posts += 1;
        return response(status, { message: 'secret body text' });
      },
      logger: { warn() {} },
    });
    await assert.rejects(client.generate(messages), (error) =>
      error instanceof AiProviderError && error.kind === 'bad_request' && !error.message.includes('secret'));
    assert.equal(posts, 1);
  }
});

test('falls back on temporary HTTP 402 but not permanent quota exhaustion', async () => {
  let posts = 0;
  const temporary = createAiClient({
    config: makeConfig({ TARGETS: makeConfig().TARGETS.slice(0, 2) }),
    fetchImpl: async () => {
      posts += 1;
      if (posts === 1) return response(402, {}, { 'retry-after': '2' });
      return response(200, { choices: [{ message: { content: denseReply } }] });
    },
    logger: { warn() {} },
  });
  assert.equal((await temporary.generate(messages)).model, 'ministral-8b-2512');

  const permanent = createAiClient({
    config: makeConfig(),
    fetchImpl: async () => response(402, { message: 'credits' }),
    logger: { warn() {} },
  });
  await assert.rejects(permanent.generate(messages), (error) => error.kind === 'quota' && !error.retryable);
});

test('classifies malformed successful JSON as a retryable bad response', async () => {
  const client = createAiClient({
    config: makeConfig({ TARGETS: [makeConfig().TARGETS[0]] }),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() { throw new SyntaxError('invalid json'); },
    }),
    logger: { warn() {} },
  });
  await assert.rejects(client.generate(messages), (error) => error.kind === 'bad_response');
});

test('times out while reading a stalled successful response body', async () => {
  let signal;
  const client = createAiClient({
    config: makeConfig({ REQUEST_TIMEOUT_MS: 10, TARGETS: [makeConfig().TARGETS[0]] }),
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return {
        ok: true,
        status: 200,
        json: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true })),
      };
    },
    logger: { warn() {} },
  });
  await assert.rejects(client.generate(messages), (error) => error.kind === 'timeout');
});

test('passes provider identity to admission and does not circuit local deadlines', async () => {
  const admissions = [];
  const client = createAiClient({
    config: makeConfig({ TARGETS: [makeConfig().TARGETS[0]] }),
    fetchImpl: async () => { throw new Error('must not fetch'); },
    runProviderAttempt: async (_task, options) => {
      admissions.push(options.provider);
      const error = new Error('local deadline');
      error.kind = 'provider_deadline';
      throw error;
    },
    logger: { warn() {} },
  });
  await assert.rejects(client.generate(messages), (error) => error.kind === 'deadline');
  assert.deepEqual(admissions, ['mistral']);
  assert.equal(client.getHealth().targets['mistral:ministral-14b-2512'].consecutiveFailures, 0);
});

test('rewrites once with the same provider and model when style density is low', async () => {
  const calls = [];
  const client = createAiClient({
    config: makeConfig({ MAX_STYLE_REWRITES: 1, TARGETS: [makeConfig().TARGETS[0]] }),
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      const content = calls.length === 1 ? 'That answer is clear and useful for everyone.' : denseReply;
      return response(200, { choices: [{ message: { content } }] });
    },
  });

  const result = await client.generate(messages);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://api.mistral.ai/v1/chat/completions');
  assert.equal(calls[1].body.model, 'ministral-14b-2512');
  assert.match(calls[1].body.messages.at(-1).content, /preserve all facts/i);
  assert.equal(result.provider, 'mistral');
  assert.equal(result.text, denseReply);
});

test('checks OpenRouter reserve only when entering its fallback portion', async () => {
  let quotaGets = 0;
  const posts = [];
  const client = createAiClient({
    config: makeConfig(),
    fetchImpl: async (_url, options) => {
      if (options.method === 'GET') {
        quotaGets += 1;
        return response(200, { data: { limit_remaining: 5 } });
      }
      posts.push(JSON.parse(options.body).model);
      return response(429, {});
    },
    logger: { warn() {} },
  });

  await assert.rejects(client.generate(messages), (error) => error.kind === 'quota_reserve');
  assert.deepEqual(posts, ['ministral-14b-2512', 'ministral-8b-2512']);
  assert.equal(quotaGets, 1);
});

test('allows OpenRouter fallback when its endpoint reports no finite credit limit', async () => {
  const posts = [];
  const client = createAiClient({
    config: makeConfig(),
    fetchImpl: async (_url, options) => {
      if (options.method === 'GET') return response(200, { data: { limit_remaining: null } });
      const model = JSON.parse(options.body).model;
      posts.push(model);
      if (model.startsWith('ministral-')) return response(503, {});
      return response(200, { choices: [{ message: { content: denseReply } }] });
    },
    logger: { warn() {} },
  });
  assert.equal((await client.generate(messages)).provider, 'openrouter');
  assert.equal(posts.length, 3);
});

test('opens circuits independently for provider-qualified targets', async () => {
  let now = 100;
  const posts = [];
  const client = createAiClient({
    config: makeConfig({ TARGETS: [makeConfig().TARGETS[0]] }),
    fetchImpl: async (_url, options) => {
      posts.push(JSON.parse(options.body).model);
      return response(503, {});
    },
    logger: { warn() {} },
    now: () => now,
  });
  await assert.rejects(client.generate(messages));
  await assert.rejects(client.generate(messages));
  await assert.rejects(client.generate(messages), (error) => error.kind === 'circuit_open');
  assert.equal(posts.length, 2);
  assert.equal(client.getHealth().targets['mistral:ministral-14b-2512'].status, 'server');
  now += 60001;
  await assert.rejects(client.generate(messages));
  assert.equal(posts.length, 3);
});

test('does not start network work when provider admission exhausts the total deadline', async () => {
  let now = 0;
  let fetches = 0;
  const client = createAiClient({
    config: makeConfig({ TOTAL_DEADLINE_MS: 25, TARGETS: [makeConfig().TARGETS[0]] }),
    now: () => now,
    runProviderAttempt: async (task) => {
      now = 26;
      return task();
    },
    fetchImpl: async () => {
      fetches += 1;
      return response(200, { choices: [{ message: { content: denseReply } }] });
    },
    logger: { warn() {} },
  });

  await assert.rejects(client.generate(messages), (error) => error.kind === 'deadline');
  assert.equal(fetches, 0);
});

test('missing provider credentials skip that provider without a network request', async () => {
  const posts = [];
  const client = createAiClient({
    config: makeConfig({ MISTRAL_API_KEY: '' }),
    fetchImpl: async (_url, options) => {
      if (options.method === 'GET') return response(200, { data: { limit_remaining: 100 } });
      posts.push(JSON.parse(options.body).model);
      return response(200, { choices: [{ message: { content: denseReply } }] });
    },
    logger: { warn() {} },
  });

  const result = await client.generate(messages);
  assert.equal(result.provider, 'openrouter');
  assert.deepEqual(posts, ['stealth/space-bunny-alpha']);
});

test('exports target keys and explicit profiles for configured OpenRouter models', () => {
  assert.equal(targetKey({ provider: 'mistral', model: 'ministral-14b-2512' }), 'mistral:ministral-14b-2512');
  assert.deepEqual(Object.keys(MODEL_PROFILES), [
    'stealth/space-bunny-alpha',
    'nvidia/nemotron-3-ultra-550b-a55b:free',
  ]);
});
