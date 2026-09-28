const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildBotKnowledge,
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

test('bot knowledge describes chat without exposing credentials or Discord IDs', () => {
  const knowledge = buildBotKnowledge(config);

  assert.match(knowledge, /configured chat channels/i);
  assert.match(knowledge, /!help/);
  assert.doesNotMatch(knowledge, /must-not-appear|12345678901234567/);
});

test('persona requires human-character roleplay, extreme adult tone, and dense profanity', () => {
  const rules = buildPersonaRules();

  assert.match(rules, /human adult character/i);
  assert.match(rules, /one.*(?:profanity|insult).*5.?6 words/i);
  assert.match(rules, /sexual|domina|humiliat/i);
  assert.match(rules, /do not volunteer.*AI|never volunteer.*AI/i);
  assert.match(rules, /consenting adults|consensual adult/i);
  assert.match(rules, /minors/i);
  assert.match(rules, /self-harm/i);
  assert.match(rules, /brief.*in.character/i);
});

test('system prompt contains no API credentials from configuration', () => {
  const prompt = buildSystemPrompt({ config });

  assert.match(prompt, /tsundere/i);
  assert.doesNotMatch(prompt, /must-not-appear/);
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
