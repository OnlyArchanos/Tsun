const test = require('node:test');
const assert = require('node:assert/strict');

const { createChatRequestQueue, ChatQueueError } = require('../utils/chatRequestQueue');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('runs up to the concurrency limit and then preserves FIFO order', async () => {
  const queue = createChatRequestQueue({ maxConcurrency: 2, maxQueueSize: 3, maxQueueWaitMs: 1000 });
  const first = deferred();
  const second = deferred();
  const starts = [];

  const one = queue.run('one', async () => { starts.push('one'); await first.promise; return 1; });
  const two = queue.run('two', async () => { starts.push('two'); await second.promise; return 2; });
  const three = queue.run('three', async () => { starts.push('three'); return 3; });
  const four = queue.run('four', async () => { starts.push('four'); return 4; });

  await Promise.resolve();
  assert.deepEqual(starts, ['one', 'two']);
  assert.deepEqual(queue.getStatus(), { active: 2, queued: 2, occupiedSessions: 4 });

  first.resolve();
  assert.equal(await one, 1);
  assert.equal(await three, 3);
  second.resolve();
  assert.deepEqual(await Promise.all([two, four]), [2, 4]);
  assert.deepEqual(starts, ['one', 'two', 'three', 'four']);
});

test('rejects a second request for an occupied session', async () => {
  const queue = createChatRequestQueue({ maxConcurrency: 1, maxQueueSize: 2, maxQueueWaitMs: 1000 });
  const gate = deferred();
  const running = queue.run('same', () => gate.promise);

  await assert.rejects(
    queue.run('same', async () => 'duplicate'),
    (error) => error instanceof ChatQueueError && error.kind === 'busy',
  );
  gate.resolve('done');
  assert.equal(await running, 'done');
});

test('rejects when the waiting queue is full', async () => {
  const queue = createChatRequestQueue({ maxConcurrency: 1, maxQueueSize: 1, maxQueueWaitMs: 1000 });
  const gate = deferred();
  const running = queue.run('one', () => gate.promise);
  const waiting = queue.run('two', async () => 'two');

  await assert.rejects(
    queue.run('three', async () => 'three'),
    (error) => error instanceof ChatQueueError && error.kind === 'full',
  );
  gate.resolve('one');
  assert.equal(await running, 'one');
  assert.equal(await waiting, 'two');
});

test('times out queued work and releases its session lock', async () => {
  const queue = createChatRequestQueue({ maxConcurrency: 1, maxQueueSize: 2, maxQueueWaitMs: 5 });
  const gate = deferred();
  const running = queue.run('one', () => gate.promise);

  await assert.rejects(
    queue.run('two', async () => 'late'),
    (error) => error instanceof ChatQueueError && error.kind === 'queue_timeout',
  );
  assert.equal(queue.getStatus().occupiedSessions, 1);
  gate.resolve('one');
  await running;
  assert.equal(await queue.run('two', async () => 'retry'), 'retry');
});

test('releases active slots and session locks when a task throws', async () => {
  const queue = createChatRequestQueue({ maxConcurrency: 1, maxQueueSize: 1, maxQueueWaitMs: 100 });

  await assert.rejects(queue.run('one', async () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(queue.getStatus(), { active: 0, queued: 0, occupiedSessions: 0 });
  assert.equal(await queue.run('one', async () => 'again'), 'again');
});

test('releases a successful session before resolving its caller', async () => {
  const queue = createChatRequestQueue({ maxConcurrency: 1, maxQueueSize: 1, maxQueueWaitMs: 100 });

  assert.equal(await queue.run('one', async () => 'done'), 'done');
  assert.deepEqual(queue.getStatus(), { active: 0, queued: 0, occupiedSessions: 0 });
  assert.equal(await queue.run('one', async () => 'again'), 'again');
});

test('shutdown rejects queued work while allowing active work to finish', async () => {
  const queue = createChatRequestQueue({ maxConcurrency: 1, maxQueueSize: 2, maxQueueWaitMs: 1000 });
  const gate = deferred();
  const running = queue.run('one', () => gate.promise);
  const waiting = queue.run('two', async () => 'two');

  queue.shutdown();
  await assert.rejects(waiting, (error) => error instanceof ChatQueueError && error.kind === 'shutdown');
  gate.resolve('one');
  assert.equal(await running, 'one');
  await assert.rejects(queue.run('three', async () => 'three'), (error) => error.kind === 'shutdown');
});

test('spaces provider starts and enforces the rolling per-minute cap', async () => {
  let now = 0;
  const waits = [];
  const queue = createChatRequestQueue({
    maxProviderStartsPerMinute: 2,
    minProviderStartIntervalMs: 100,
    now: () => now,
    sleep: async (ms) => { waits.push(ms); now += ms; },
  });

  await queue.runProviderAttempt(async () => 'one');
  await queue.runProviderAttempt(async () => 'two');
  await queue.runProviderAttempt(async () => 'three');

  assert.deepEqual(waits, [100, 59900]);
  assert.equal(queue.getProviderStatus().startsLastMinute, 2);
  assert.equal(queue.getProviderStatus().nextStartInMs, 100);
});

test('spaces providers independently while sharing the rolling start cap', async () => {
  let now = 0;
  const waits = [];
  const starts = [];
  const queue = createChatRequestQueue({
    maxProviderStartsPerMinute: 10,
    minProviderStartIntervalMs: 100,
    providerMinStartIntervals: { mistral: 2100, openrouter: 300 },
    now: () => now,
    sleep: async (ms) => { waits.push(ms); now += ms; },
  });

  await queue.runProviderAttempt(async () => { starts.push(['mistral', now]); }, { provider: 'mistral' });
  await queue.runProviderAttempt(async () => { starts.push(['openrouter', now]); }, { provider: 'openrouter' });
  await queue.runProviderAttempt(async () => { starts.push(['mistral', now]); }, { provider: 'mistral' });

  assert.deepEqual(starts, [
    ['mistral', 0],
    ['openrouter', 0],
    ['mistral', 2100],
  ]);
  assert.deepEqual(waits, [2100]);
  assert.deepEqual(queue.getProviderStatus().providers, {
    mistral: { nextStartInMs: 2100 },
    openrouter: { nextStartInMs: 0 },
  });
  assert.equal(queue.getProviderStatus().startsLastMinute, 3);
});

test('serializes simultaneous provider admissions without serializing request bodies', async () => {
  let now = 0;
  const starts = [];
  const queue = createChatRequestQueue({
    maxProviderStartsPerMinute: 18,
    minProviderStartIntervalMs: 10,
    now: () => now,
    sleep: async (ms) => { now += ms; },
  });
  await Promise.all([
    queue.runProviderAttempt(async () => { starts.push(now); }),
    queue.runProviderAttempt(async () => { starts.push(now); }),
    queue.runProviderAttempt(async () => { starts.push(now); }),
  ]);
  assert.deepEqual(starts, [0, 10, 20]);
});

test('rejects provider admission immediately when its wait exceeds the caller deadline', async () => {
  let now = 0;
  let slept = false;
  const queue = createChatRequestQueue({
    minProviderStartIntervalMs: 100,
    now: () => now,
    sleep: async () => { slept = true; },
  });
  await queue.runProviderAttempt(async () => 'first');
  await assert.rejects(
    queue.runProviderAttempt(async () => 'late', { deadlineAt: 50 }),
    (error) => error instanceof ChatQueueError && error.kind === 'provider_deadline',
  );
  assert.equal(slept, false);
});

test('caps ordinary queue waiting at the caller deadline', async () => {
  let now = 0;
  const timers = [];
  const queue = createChatRequestQueue({
    maxConcurrency: 1,
    maxQueueWaitMs: 30000,
    now: () => now,
    setTimeoutImpl(fn, ms) { timers.push({ fn, ms }); return timers.at(-1); },
    clearTimeoutImpl() {},
  });
  const gate = deferred();
  const running = queue.run('running', () => gate.promise);
  const waiting = queue.run('waiting', async () => 'late', { deadlineAt: 25000 });
  assert.equal(timers[0].ms, 25000);
  timers[0].fn();
  await assert.rejects(waiting, (error) => error.kind === 'queue_timeout');
  gate.resolve();
  await running;
});
