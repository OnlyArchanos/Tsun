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
  providerMinStartIntervals = {},
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
  const lastProviderStarts = new Map();

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

  function getProviderInterval(provider) {
    const configured = providerMinStartIntervals[provider];
    return Number.isFinite(configured) && configured >= 0
      ? configured
      : minProviderStartIntervalMs;
  }

  function getSpacingWait(provider) {
    const lastStartAt = lastProviderStarts.get(provider);
    return lastStartAt === undefined
      ? 0
      : Math.max(0, getProviderInterval(provider) - (now() - lastStartAt));
  }

  function getProviderStatus() {
    pruneProviderStarts();
    const windowWait = providerStarts.length >= maxProviderStartsPerMinute
      ? Math.max(0, providerStarts[0] + 60000 - now())
      : 0;
    const providers = Object.fromEntries(Object.keys(providerMinStartIntervals).map((provider) => [
      provider,
      { nextStartInMs: Math.max(getSpacingWait(provider), windowWait) },
    ]));
    return {
      startsLastMinute: providerStarts.length,
      nextStartInMs: Math.max(getSpacingWait('default'), windowWait),
      providers,
    };
  }

  async function admitProviderStart(deadlineAt, provider) {
    if (shuttingDown) throw new ChatQueueError('shutdown');
    pruneProviderStarts();
    const windowWait = providerStarts.length >= maxProviderStartsPerMinute
      ? Math.max(0, providerStarts[0] + 60000 - now())
      : 0;
    const waitMs = Math.max(getSpacingWait(provider), windowWait);
    if (deadlineAt !== null && waitMs > 0 && now() + waitMs >= deadlineAt) {
      throw new ChatQueueError('provider_deadline');
    }
    if (waitMs > 0) await sleep(waitMs);
    if (shuttingDown) throw new ChatQueueError('shutdown');
    pruneProviderStarts();
    const startedAt = now();
    providerStarts.push(startedAt);
    lastProviderStarts.set(provider, startedAt);
  }

  function runProviderAttempt(task, { deadlineAt = null, provider = 'default' } = {}) {
    const admit = () => admitProviderStart(deadlineAt, provider);
    const admission = providerAdmission.then(admit, admit);
    providerAdmission = admission.catch(() => {});
    return admission.then(task);
  }

  return { run, runProviderAttempt, getStatus, getProviderStatus, shutdown };
}

module.exports = { ChatQueueError, createChatRequestQueue };
