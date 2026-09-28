const test = require('node:test');
const assert = require('node:assert/strict');

const CONFIG_PATH = require.resolve('../config');

function loadConfig(env = {}) {
  const isAiKey = (key) => key.startsWith('TSUN_AI_') || key === 'OPENROUTER_API_KEY';
  const previous = new Map(Object.keys(process.env).filter(isAiKey).map((key) => [key, process.env[key]]));

  for (const key of Object.keys(process.env).filter(isAiKey)) delete process.env[key];
  Object.assign(process.env, env);
  delete require.cache[CONFIG_PATH];

  try {
    return require('../config');
  } finally {
    for (const key of Object.keys(process.env).filter(isAiKey)) delete process.env[key];
    for (const [key, value] of previous) process.env[key] = value;
    delete require.cache[CONFIG_PATH];
  }
}

test('parseBoolean accepts common true and false spellings', () => {
  const { parseBoolean } = loadConfig();

  for (const value of ['true', '1', 'yes', 'on', ' TRUE ']) assert.equal(parseBoolean(value, false), true);
  for (const value of ['false', '0', 'no', 'off', ' FALSE ']) assert.equal(parseBoolean(value, true), false);
  assert.equal(parseBoolean('unexpected', true), true);
  assert.equal(parseBoolean(undefined, false), false);
});

test('parseCsv trims, lowercases, removes blanks, and deduplicates', () => {
  const { parseCsv } = loadConfig();

  assert.deepEqual(parseCsv(' General,tsun-chat, GENERAL, ,Tsun-Chat '), ['general', 'tsun-chat']);
  assert.deepEqual(parseCsv(undefined), []);
});

test('parseBoundedInteger uses fallback outside the accepted range', () => {
  const { parseBoundedInteger } = loadConfig();

  assert.equal(parseBoundedInteger('12', 5, 1, 20), 12);
  assert.equal(parseBoundedInteger('0', 5, 1, 20), 5);
  assert.equal(parseBoundedInteger('21', 5, 1, 20), 5);
  assert.equal(parseBoundedInteger('nope', 5, 1, 20), 5);
  assert.equal(parseBoundedInteger('12oops', 5, 1, 20), 5);
});

test('valid numeric settings do not warn just because they equal the default', () => {
  const config = loadConfig({ TSUN_AI_MAX_CONCURRENCY: '03' });

  assert.equal(config.AI_CHAT.MAX_CONCURRENCY, 3);
  assert.doesNotMatch(config.AI_CHAT.WARNINGS.join(' '), /TSUN_AI_MAX_CONCURRENCY/);
});

test('AI chat stays disabled when requested OpenRouter configuration is incomplete', () => {
  const config = loadConfig({ TSUN_AI_ENABLED: 'true' });

  assert.equal(config.AI_CHAT.REQUESTED_ENABLED, true);
  assert.equal(config.AI_CHAT.ENABLED, false);
  assert.match(config.AI_CHAT.WARNINGS.join(' '), /OPENROUTER_API_KEY/);
  assert.match(config.AI_CHAT.WARNINGS.join(' '), /TSUN_AI_GUILD_IDS/);
  assert.match(config.AI_CHAT.WARNINGS.join(' '), /TSUN_AI_CHANNEL_IDS/);
});

test('AI chat enables with an OpenRouter key and deduplicated guild and channel IDs', () => {
  const config = loadConfig({
    TSUN_AI_ENABLED: 'yes',
    TSUN_AI_GUILD_IDS: '12345678901234567, 22345678901234567,12345678901234567',
    TSUN_AI_CHANNEL_IDS: '32345678901234567, 42345678901234567,32345678901234567',
    OPENROUTER_API_KEY: 'test-openrouter-secret',
    TSUN_AI_MAX_CONCURRENCY: '99'
  });

  assert.equal(config.AI_CHAT.ENABLED, true);
  assert.deepEqual(config.AI_CHAT.GUILD_IDS, ['12345678901234567', '22345678901234567']);
  assert.deepEqual(config.AI_CHAT.CHANNEL_IDS, ['32345678901234567', '42345678901234567']);
  assert.equal(config.AI_CHAT.OPENROUTER_API_KEY, 'test-openrouter-secret');
  assert.equal(config.AI_CHAT.PRIMARY_MODEL, 'stealth/space-bunny-alpha');
  assert.deepEqual(config.AI_CHAT.FALLBACK_MODELS, [
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'inclusionai/ling-3.0-flash-fin:free',
  ]);
  assert.equal(config.AI_CHAT.TOTAL_DEADLINE_MS, 25000);
  assert.equal(config.AI_CHAT.FALLBACK_QUOTA_RESERVE, 5);
  assert.equal(config.AI_CHAT.MAX_CONCURRENCY, 3);
  assert.match(config.AI_CHAT.WARNINGS.join(' '), /TSUN_AI_MAX_CONCURRENCY/);
});

test('invalid Discord IDs are discarded and prevent enablement', () => {
  const config = loadConfig({
    TSUN_AI_ENABLED: 'true',
    TSUN_AI_GUILD_IDS: 'general,123',
    TSUN_AI_CHANNEL_IDS: 'tsun-chat,456',
    OPENROUTER_API_KEY: 'secret',
  });

  assert.equal(config.AI_CHAT.ENABLED, false);
  assert.deepEqual(config.AI_CHAT.GUILD_IDS, []);
  assert.deepEqual(config.AI_CHAT.CHANNEL_IDS, []);
});
