const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPersonaRules,
  buildSystemPrompt,
  buildMessages,
} = require('../config/chatPrompt');

const config = {
  CHANNELS: { MAIN: 'tsun', ALT: 'tsun-alt', GENERAL: 'general' },
  AI_CHAT: {
    CHANNEL_IDS: ['12345678901234567'],
    OPENROUTER_API_KEY: 'must-not-appear',
  },
};

test('persona uses the configured tsundere style rules', () => {
  const rules = buildPersonaRules();

  assert.match(rules, /High-Functioning Tsundere Character/i);
  assert.match(rules, /one foul word every 5-6 words/i);
  assert.match(rules, /every response MUST start with a stutter/i);
  assert.match(rules, /end every response with one/i);
});

test('system prompt contains no API credentials from configuration', () => {
  const prompt = buildSystemPrompt({ config });

  assert.match(prompt, /tsundere/i);
  assert.doesNotMatch(prompt, /must-not-appear/);
  assert.equal(prompt, buildPersonaRules());
});

test('buildMessages preserves alternating history and appends the current user turn', () => {
  const history = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hmph' },
  ];

  const messages = buildMessages({ systemPrompt: 'system', history, input: 'again' });

  assert.deepEqual(messages, [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hmph' },
    { role: 'user', content: 'again' },
  ]);
  assert.deepEqual(history, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hmph' },
  ]);
});

test('buildMessages rejects malformed or non-alternating history', () => {
  assert.throws(
    () => buildMessages({
      systemPrompt: 'system',
      history: [{ role: 'assistant', content: 'orphaned' }],
      input: 'hello',
    }),
    /history/i,
  );
  assert.throws(
    () => buildMessages({
      systemPrompt: 'system',
      history: [{ role: 'user', content: '' }],
      input: 'hello',
    }),
    /history/i,
  );
});
