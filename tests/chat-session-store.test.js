const test = require('node:test');
const assert = require('node:assert/strict');

const { createChatSessionStore, createSessionKey } = require('../utils/chatSessionStore');

test('session keys isolate guild, channel, and user', () => {
  assert.equal(createSessionKey({ guildId: 'g', channelId: 'c', userId: 'u' }), 'g:c:u');
  assert.notEqual(
    createSessionKey({ guildId: 'g', channelId: 'c', userId: 'u' }),
    createSessionKey({ guildId: 'g', channelId: 'other', userId: 'u' }),
  );
});

test('stores complete exchanges and returns defensive history copies', () => {
  let now = 100;
  const store = createChatSessionStore({ maxMessages: 4, ttlMs: 1000, now: () => now });

  store.appendExchange('key', 'hello', 'hi', ['response-1']);
  const history = store.getHistory('key');
  history[0].content = 'mutated';
  history.push({ role: 'user', content: 'extra' });

  assert.deepEqual(store.getHistory('key'), [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ]);
  assert.deepEqual(store.getStatus('key'), { turns: 1, messages: 2, expiresAt: 1100 });
  assert.equal(store.ownsResponse('key', 'response-1'), true);
  assert.equal(store.ownsResponse('other', 'response-1'), false);
});

test('evicts the oldest session when the bounded store is full', () => {
  let now = 0;
  const store = createChatSessionStore({ maxSessions: 2, ttlMs: 1000, now: () => now });
  store.appendExchange('oldest', 'one', 'damn one', ['r1']);
  now += 1;
  store.appendExchange('middle', 'two', 'damn two', ['r2']);
  now += 1;
  store.appendExchange('newest', 'three', 'damn three', ['r3']);

  assert.deepEqual(store.getHistory('oldest'), []);
  assert.equal(store.ownsResponse('middle', 'r2'), true);
  assert.equal(store.getStatus('newest').turns, 1);
});

test('trimming history also removes response IDs from trimmed exchanges', () => {
  const store = createChatSessionStore({ maxMessages: 2, ttlMs: 1000 });
  store.appendExchange('key', 'one', 'damn one', ['old']);
  store.appendExchange('key', 'two', 'damn two', ['new-a', 'new-b']);
  assert.equal(store.ownsResponse('key', 'old'), false);
  assert.equal(store.ownsResponse('key', 'new-a'), true);
  assert.equal(store.ownsResponse('key', 'new-b'), true);
});

test('trims only complete oldest exchanges', () => {
  const store = createChatSessionStore({ maxMessages: 4, ttlMs: 1000 });

  store.appendExchange('key', 'one', 'a');
  store.appendExchange('key', 'two', 'b');
  store.appendExchange('key', 'three', 'c');

  assert.deepEqual(store.getHistory('key'), [
    { role: 'user', content: 'two' },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'three' },
    { role: 'assistant', content: 'c' },
  ]);
});

test('expires lazily without extending expiry on reads or status', () => {
  let now = 0;
  const store = createChatSessionStore({ maxMessages: 12, ttlMs: 100, now: () => now });
  store.appendExchange('key', 'hello', 'hi');

  now = 99;
  assert.equal(store.getHistory('key').length, 2);
  assert.equal(store.getStatus('key').expiresAt, 100);
  now = 100;
  assert.deepEqual(store.getHistory('key'), []);
  assert.deepEqual(store.getStatus('key'), { turns: 0, messages: 0, expiresAt: null });
});

test('clear and cleanupExpired remove only targeted or expired sessions', () => {
  let now = 0;
  const store = createChatSessionStore({ maxMessages: 12, ttlMs: 100, now: () => now });
  store.appendExchange('old', 'one', 'a');
  now = 50;
  store.appendExchange('new', 'two', 'b');
  assert.equal(store.clear('new'), true);
  assert.equal(store.clear('missing'), false);

  now = 100;
  assert.equal(store.cleanupExpired(), 1);
  assert.deepEqual(store.getHistory('old'), []);
});

test('cleanup timer is unrefd and can be stopped', () => {
  let callback;
  let cleared = null;
  const timer = { unrefCalled: false, unref() { this.unrefCalled = true; } };
  const store = createChatSessionStore({
    maxMessages: 12,
    ttlMs: 100,
    setIntervalImpl(fn) { callback = fn; return timer; },
    clearIntervalImpl(handle) { cleared = handle; },
  });

  store.startCleanup();
  assert.equal(typeof callback, 'function');
  assert.equal(timer.unrefCalled, true);
  store.stopCleanup();
  assert.equal(cleared, timer);
});
