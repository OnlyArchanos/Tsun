function createSessionKey({ guildId, channelId, userId }) {
  if (!guildId || !channelId || !userId) throw new TypeError('Guild, channel, and user IDs are required.');
  return `${guildId}:${channelId}:${userId}`;
}

function createChatSessionStore({
  maxMessages = 12,
  ttlMs = 30 * 60 * 1000,
  cleanupIntervalMs = 5 * 60 * 1000,
  maxSessions = 5000,
  now = Date.now,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  const sessions = new Map();
  const messageLimit = Math.max(2, Math.floor(maxMessages / 2) * 2);
  let cleanupTimer = null;

  function isExpired(session) {
    return now() >= session.expiresAt;
  }

  function getLiveSession(key) {
    const session = sessions.get(key);
    if (!session) return null;
    if (isExpired(session)) {
      sessions.delete(key);
      return null;
    }
    return session;
  }

  function getHistory(key) {
    const session = getLiveSession(key);
    return session ? session.history.map((message) => ({ ...message })) : [];
  }

  function appendExchange(key, userText, assistantText, responseMessageIds = []) {
    if (typeof userText !== 'string' || !userText.trim()) throw new TypeError('User text is required.');
    if (typeof assistantText !== 'string' || !assistantText.trim()) throw new TypeError('Assistant text is required.');

    if (!Array.isArray(responseMessageIds)) throw new TypeError('Response message IDs must be an array.');
    const existing = getLiveSession(key);
    const history = existing?.history || [];
    const exchanges = existing?.exchanges || [];
    history.push(
      { role: 'user', content: userText.trim() },
      { role: 'assistant', content: assistantText.trim() },
    );
    exchanges.push(responseMessageIds.map(String));
    while (history.length > messageLimit) {
      history.splice(0, 2);
      exchanges.shift();
    }
    if (!sessions.has(key) && sessions.size >= maxSessions) {
      cleanupExpired();
      if (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value);
    }
    sessions.delete(key);
    sessions.set(key, { history, exchanges, expiresAt: now() + ttlMs });
  }

  function ownsResponse(key, messageId) {
    const session = getLiveSession(key);
    if (!session || !messageId) return false;
    return session.exchanges.some((ids) => ids.includes(String(messageId)));
  }

  function clear(key) {
    return sessions.delete(key);
  }

  function getStatus(key) {
    const session = getLiveSession(key);
    if (!session) return { turns: 0, messages: 0, expiresAt: null };
    return {
      turns: session.history.length / 2,
      messages: session.history.length,
      expiresAt: session.expiresAt,
    };
  }

  function cleanupExpired() {
    let removed = 0;
    for (const [key, session] of sessions.entries()) {
      if (isExpired(session)) {
        sessions.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  function startCleanup() {
    if (cleanupTimer) return;
    cleanupTimer = setIntervalImpl(cleanupExpired, cleanupIntervalMs);
    cleanupTimer?.unref?.();
  }

  function stopCleanup() {
    if (!cleanupTimer) return;
    clearIntervalImpl(cleanupTimer);
    cleanupTimer = null;
  }

  return {
    getHistory,
    appendExchange,
    ownsResponse,
    clear,
    getStatus,
    cleanupExpired,
    startCleanup,
    stopCleanup,
  };
}

module.exports = { createSessionKey, createChatSessionStore };
