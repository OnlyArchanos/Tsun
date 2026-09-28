class ChatQueueError extends Error {
  constructor(kind) {
    super(`Chat request rejected (${kind}).`);
    this.name = 'ChatQueueError';
    this.kind = kind;
  }
}

function createChatRequestQueue({
  maxConcurrency = 3,
  maxQueueSize = 20,
  maxQueueWaitMs = 30000,
  maxProviderStartsPerMinute = 18,
  minProviderStartIntervalMs = 1100,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const waiting = [];
  const occupiedSessions = new Set();
  let active = 0;
  let shuttingDown = false;
  let providerAdmission = Promise.resolve();
  const providerStarts = [];
  let lastProviderStartAt = null;

  function getStatus() {
    return { active, queued: waiting.length, occupiedSessions: occupiedSessions.size };
  }

  function removeWaiting(item) {
    const index = waiting.indexOf(item);
    if (index >= 0) waiting.splice(index, 1);
  }

  function drain() {
    while (!shuttingDown && active < maxConcurrency && waiting.length > 0) {
      start(waiting.shift());
    }
  }

  function start(item) {
    if (item.timer) clearTimeoutImpl(item.timer);
    active += 1;

    const release = () => {
      active -= 1;
      occupiedSessions.delete(item.sessionKey);
      drain();
    };

    Promise.resolve()
      .then(item.task)
      .then(
        (result) => {
          release();
          item.resolve(result);
        },
        (error) => {
          release();
          item.reject(error);
        },
      );
  }

  function run(sessionKey, task, { deadlineAt = null } = {}) {
    if (shuttingDown) return Promise.reject(new ChatQueueError('shutdown'));
    if (occupiedSessions.has(sessionKey)) return Promise.reject(new ChatQueueError('busy'));
    if (active >= maxConcurrency && waiting.length >= maxQueueSize) {
      return Promise.reject(new ChatQueueError('full'));
    }

    occupiedSessions.add(sessionKey);
    return new Promise((resolve, reject) => {
      const item = { sessionKey, task, resolve, reject, timer: null };
      if (active < maxConcurrency) {
        start(item);
        return;
      }

      const deadlineWait = deadlineAt === null ? maxQueueWaitMs : Math.max(0, deadlineAt - now());
      item.timer = setTimeoutImpl(() => {
        removeWaiting(item);
        occupiedSessions.delete(sessionKey);
        reject(new ChatQueueError('queue_timeout'));
      }, Math.min(maxQueueWaitMs, deadlineWait));
      waiting.push(item);
    });
  }

  function shutdown() {
    shuttingDown = true;
    while (waiting.length > 0) {
      const item = waiting.shift();
      if (item.timer) clearTimeoutImpl(item.timer);
      occupiedSessions.delete(item.sessionKey);
      item.reject(new ChatQueueError('shutdown'));
    }
  }

  function pruneProviderStarts() {
    const cutoff = now() - 60000;
    while (providerStarts.length > 0 && providerStarts[0] <= cutoff) providerStarts.shift();
  }

  function getProviderStatus() {
    pruneProviderStarts();
    const spacingWait = lastProviderStartAt === null
      ? 0
      : Math.max(0, minProviderStartIntervalMs - (now() - lastProviderStartAt));
    const windowWait = providerStarts.length >= maxProviderStartsPerMinute
      ? Math.max(0, providerStarts[0] + 60000 - now())
      : 0;
    return { startsLastMinute: providerStarts.length, nextStartInMs: Math.max(spacingWait, windowWait) };
  }

  async function admitProviderStart(deadlineAt) {
    if (shuttingDown) throw new ChatQueueError('shutdown');
    const waitMs = getProviderStatus().nextStartInMs;
    if (deadlineAt !== null && waitMs > 0 && now() + waitMs >= deadlineAt) {
      throw new ChatQueueError('provider_deadline');
    }
    if (waitMs > 0) await sleep(waitMs);
    if (shuttingDown) throw new ChatQueueError('shutdown');
    pruneProviderStarts();
    const startedAt = now();
    providerStarts.push(startedAt);
    lastProviderStartAt = startedAt;
  }

  function runProviderAttempt(task, { deadlineAt = null } = {}) {
    const admit = () => admitProviderStart(deadlineAt);
    const admission = providerAdmission.then(admit, admit);
    providerAdmission = admission.catch(() => {});
    return admission.then(task);
  }

  return { run, runProviderAttempt, getStatus, getProviderStatus, shutdown };
}

module.exports = { ChatQueueError, createChatRequestQueue };
