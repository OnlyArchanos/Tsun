const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createAiClient,
  AiProviderError,
  normalizeResponseContent,
  MODEL_PROFILES,
} = require('../utils/aiClient');

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

function makeConfig(overrides = {}) {
  return {
    OPENROUTER_API_KEY: 'router-secret',
    PRIMARY_MODEL: 'stealth/space-bunny-alpha',
    FALLBACK_MODELS: [
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'inclusionai/ling-3.0-flash-fin:free',
    ],
    MAX_OUTPUT_TOKENS: 300,
    TEMPERATURE: 0.85,
    REQUEST_TIMEOUT_MS: 50,
    TOTAL_DEADLINE_MS: 500,
    FALLBACK_QUOTA_RESERVE: 5,
    CIRCUIT_FAILURE_THRESHOLD: 2,
    CIRCUIT_OPEN_MS: 60000,
    MAX_STYLE_REWRITES: 1,
    ...overrides,
  };
}

const messages = [
  { role: 'system', content: 'system' },
  { role: 'user', content: 'hello' },
];

test('uses OpenRouter and applies Space Bunny reasoning settings without mutating input', async () => {
  const calls = [];
  const input = structuredClone(messages);
  const client = createAiClient({
    config: makeConfig(),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, {
        choices: [{ message: { content: 'Fuck, that damn answer works.' } }],
        usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
      });
    },
    logger: { warn() {} },
  });

  const result = await client.generate(input);
  const body = JSON.parse(calls[0].options.body);

  assert.equal(result.provider, 'openrouter');
  assert.equal(result.model, 'stealth/space-bunny-alpha');
  assert.deepEqual(result.usage, { promptTokens: 4, completionTokens: 6, totalTokens: 10 });
  assert.deepEqual(body.reasoning, { effort: 'low', exclude: true });
  assert.equal(calls[0].options.headers.Authorization, 'Bearer router-secret');
  assert.deepEqual(input, messages);
});

test('normalizes string and text-array content', () => {
  assert.equal(normalizeResponseContent(' hello '), 'hello');
  assert.equal(normalizeResponseContent([{ type: 'text', text: 'one' }, { type: 'text', text: ' two ' }]), 'one\ntwo');
  assert.equal(normalizeResponseContent([]), '');
});

test('falls through retryable failures in model order', async () => {
  const models = [];
  const client = createAiClient({
    config: makeConfig(),
    fetchImpl: async (url, options) => {
      if (options.method === 'GET') return response(200, { data: { limit_remaining: 100 } });
      const body = JSON.parse(options.body);
      models.push(body.model);
      if (models.length < 3) return response(models.length === 1 ? 429 : 503, {});
      return response(200, { choices: [{ message: { content: 'Damn, this shit works now.' } }] });
    },
    logger: { warn() {} },
  });

  const result = await client.generate(messages);
  assert.equal(result.model, 'inclusionai/ling-3.0-flash-fin:free');
  assert.deepEqual(models, [
    'stealth/space-bunny-alpha',
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'inclusionai/ling-3.0-flash-fin:free',
  ]);
});

test('does not hide authentication or malformed-request failures', async () => {
  for (const status of [400, 401, 403, 422]) {
    let posts = 0;
    const client = createAiClient({
      config: makeConfig(),
      fetchImpl: async (_url, options) => {
        if (options.method === 'POST') posts += 1;
        return response(status, { error: { message: 'secret body text' } });
      },
      logger: { warn() {} },
    });
    await assert.rejects(client.generate(messages), (error) =>
      error instanceof AiProviderError && !error.retryable && !error.message.includes('secret'));
    assert.equal(posts, 1);
  }
});

test('classifies HTTP 402 as non-retryable quota exhaustion', async () => {
  let posts = 0;
  const client = createAiClient({
    config: makeConfig(),
    fetchImpl: async () => { posts += 1; return response(402, { error: { message: 'credits' } }); },
    logger: { warn() {} },
  });
  await assert.rejects(client.generate(messages), (error) => error.kind === 'quota' && !error.retryable);
  assert.equal(posts, 1);
});

test('falls back on temporary HTTP 402 responses with Retry-After', async () => {
  let posts = 0;
  const client = createAiClient({
    config: makeConfig(),
    fetchImpl: async (_url, options) => {
      if (options.method === 'GET') return response(200, { data: { limit_remaining: null } });
      posts += 1;
      if (posts === 1) {
        return {
          ...response(402, {}),
          headers: { get: (name) => name.toLowerCase() === 'retry-after' ? '2' : null },
        };
      }
      return response(200, { choices: [{ message: { content: 'Damn, temporary quota fallback works.' } }] });
    },
    logger: { warn() {} },
  });
  const result = await client.generate(messages);
  assert.equal(result.model, 'nvidia/nemotron-3-ultra-550b-a55b:free');
  assert.notEqual(client.getHealth().quota.remaining, 0);
  assert.equal(client.getHealth().models['stealth/space-bunny-alpha'].consecutiveFailures, 0);
});

test('classifies malformed successful JSON as a bad response', async () => {
  const client = createAiClient({
    config: makeConfig({ FALLBACK_MODELS: [] }),
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
    config: makeConfig({ REQUEST_TIMEOUT_MS: 10, FALLBACK_MODELS: [] }),
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

test('local admission deadlines do not increment model circuit failures', async () => {
  const client = createAiClient({
    config: makeConfig({ FALLBACK_MODELS: [] }),
    fetchImpl: async () => { throw new Error('must not fetch'); },
    runProviderAttempt: async () => {
      const error = new Error('local deadline');
      error.kind = 'provider_deadline';
      throw error;
    },
    logger: { warn() {} },
  });
  await assert.rejects(client.generate(messages), (error) => error.kind === 'deadline');
  assert.equal(client.getHealth().models['stealth/space-bunny-alpha'].consecutiveFailures, 0);
});

test('rewrites once with the same model when profanity density is too low', async () => {
  const bodies = [];
  const client = createAiClient({
    config: makeConfig(),
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      const content = bodies.length === 1
        ? 'That answer is clear and useful for everyone.'
        : 'That damn answer is fucking clear and useful.';
      return response(200, { choices: [{ message: { content } }] });
    },
    logger: { warn() {} },
  });

  const result = await client.generate(messages);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].model, bodies[0].model);
  assert.match(bodies[1].messages.at(-1).content, /preserve all facts/i);
  assert.equal(result.text, 'That damn answer is fucking clear and useful.');
});

test('keeps the denser draft when the rewrite is still below target', async () => {
  let calls = 0;
  const client = createAiClient({
    config: makeConfig(),
    fetchImpl: async () => {
      calls += 1;
      const content = calls === 1
        ? 'This damn answer contains several otherwise ordinary words.'
        : 'This answer has no useful profanity at all today.';
      return response(200, { choices: [{ message: { content } }] });
    },
    logger: { warn() {} },
  });
  const result = await client.generate(messages);
  assert.equal(result.text, 'This damn answer contains several otherwise ordinary words.');
  assert.equal(calls, 2);
});

test('skips fallback when reported remaining quota is at reserve', async () => {
  let posts = 0;
  const client = createAiClient({
    config: makeConfig(),
    fetchImpl: async (_url, options) => {
      if (options.method === 'GET') return response(200, { data: { limit_remaining: 5 } });
      posts += 1;
      return response(429, {});
    },
    logger: { warn() {} },
  });
  await assert.rejects(client.generate(messages), (error) => error.kind === 'quota_reserve');
  assert.equal(posts, 1);
});

test('allows fallback when OpenRouter does not report a finite credit limit', async () => {
  let posts = 0;
  const client = createAiClient({
    config: makeConfig(),
    fetchImpl: async (_url, options) => {
      if (options.method === 'GET') return response(200, { data: { limit_remaining: null } });
      posts += 1;
      if (posts === 1) return response(429, {});
      return response(200, { choices: [{ message: { content: 'Damn, fallback works.' } }] });
    },
    logger: { warn() {} },
  });
  const result = await client.generate(messages);
  assert.equal(result.model, 'nvidia/nemotron-3-ultra-550b-a55b:free');
  assert.equal(posts, 2);
});

test('opens a per-model circuit after consecutive retryable failures', async () => {
  const posts = [];
  let now = 100;
  const client = createAiClient({
    config: makeConfig({ FALLBACK_MODELS: [], MAX_STYLE_REWRITES: 0 }),
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
  now += 60001;
  await assert.rejects(client.generate(messages));
  assert.equal(posts.length, 3);
});

test('does not start network work when provider admission exhausts the total deadline', async () => {
  let now = 0;
  let fetches = 0;
  const client = createAiClient({
    config: makeConfig({ TOTAL_DEADLINE_MS: 25, FALLBACK_MODELS: [] }),
    now: () => now,
    runProviderAttempt: async (task) => {
      now = 26;
      return task();
    },
    fetchImpl: async () => {
      fetches += 1;
      return response(200, { choices: [{ message: { content: 'Damn, this works.' } }] });
    },
    logger: { warn() {} },
  });

  await assert.rejects(client.generate(messages), (error) => error.kind === 'deadline');
  assert.equal(fetches, 0);
});

test('exports explicit profiles for every configured model', () => {
  assert.deepEqual(Object.keys(MODEL_PROFILES), [
    'stealth/space-bunny-alpha',
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'inclusionai/ling-3.0-flash-fin:free',
  ]);
  assert.deepEqual(MODEL_PROFILES['nvidia/nemotron-3-ultra-550b-a55b:free'].reasoning, {
    effort: 'low',
    exclude: true,
  });
});
