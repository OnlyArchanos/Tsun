const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType } = require('discord.js');

const {
  createChatSystem,
  isAllowedGuild,
  isAllowedChannel,
  extractCommandToken,
  extractPrompt,
  detectTrigger,
  splitDiscordResponse,
  createSafeReplyOptions,
} = require('../commands/chat');
const { createChatSessionStore, createSessionKey } = require('../utils/chatSessionStore');
const { createChatRequestQueue } = require('../utils/chatRequestQueue');

function makeConfig(overrides = {}) {
  return {
    CHANNELS: { MAIN: 'tsun', ALT: 'tsun-alt', GENERAL: 'general' },
    AI_CHAT: {
      ENABLED: true,
      REQUESTED_ENABLED: true,
      WARNINGS: [],
      GUILD_IDS: ['guild'],
      CHANNEL_IDS: ['channel'],
      MAX_INPUT_CHARS: 1500,
      USER_COOLDOWN_MS: 3000,
      SESSION_TTL_MS: 1800000,
      SESSION_MAX_MESSAGES: 12,
      MAX_CONCURRENCY: 3,
      MAX_QUEUE_SIZE: 20,
      MAX_QUEUE_WAIT_MS: 30000,
      OPENROUTER_API_KEY: 'hidden-router',
      MISTRAL_API_KEY: 'hidden-mistral',
      TARGETS: [
        { provider: 'mistral', model: 'ministral-14b-2512' },
        { provider: 'openrouter', model: 'stealth/space-bunny-alpha' },
      ],
      MAX_SESSIONS: 5000,
      MAX_PROVIDER_STARTS_PER_MINUTE: 18,
      MIN_PROVIDER_START_INTERVAL_MS: 1100,
      MISTRAL_MIN_START_INTERVAL_MS: 2100,
      ...overrides,
    },
  };
}

function makeMessage({
  content = '<@bot> hello',
  channelName = 'general',
  channelId = 'channel',
  guildId = 'guild',
  userId = 'user',
  mentioned = true,
  parsedMentioned = mentioned,
  nsfw = false,
  referenceAuthorId = null,
  referenceMessageId = 'reply-1',
  attachments = 0,
  webhookId = null,
  isThread = false,
  replyFails = false,
  sendFails = false,
  channelType = ChannelType.GuildText,
} = {}) {
  const replies = [];
  const sends = [];
  const reactions = [];
  let typingCount = 0;
  const message = {
    content,
    author: { id: userId, bot: false },
    webhookId,
    guild: guildId ? { id: guildId } : null,
    channel: {
      id: channelId,
      name: channelName,
      type: channelType,
      nsfw,
      isThread: () => isThread,
      async sendTyping() { typingCount += 1; },
      async send(options) {
        if (sendFails) throw new Error('discord follow-up failed');
        sends.push(options);
        return { id: 'follow-up-1', ...options };
      },
    },
    client: { user: { id: 'bot' } },
    mentions: {
      users: { has: (id) => id === 'bot' && mentioned },
      parsedUsers: { has: (id) => id === 'bot' && parsedMentioned },
    },
    reference: referenceAuthorId ? { messageId: referenceMessageId } : null,
    async fetchReference() { return { id: referenceMessageId, author: { id: referenceAuthorId } }; },
    attachments: { size: attachments },
    async reply(options) {
      if (replyFails) throw new Error('discord send failed');
      replies.push(options);
      return { id: 'reply-1', ...options };
    },
    async react(emoji) { reactions.push(emoji); },
  };
  return { message, replies, sends, reactions, getTypingCount: () => typingCount };
}

function makeUserModel(result = null, error = null) {
  return {
    findOne() {
      return {
        select() {
          return {
            async lean() {
              if (error) throw error;
              return result;
            },
          };
        },
      };
    },
  };
}

function makeSystem({ config = makeConfig(), userResult = null, userError = null, generate, now } = {}) {
  const sessionStore = createChatSessionStore({
    maxMessages: config.AI_CHAT.SESSION_MAX_MESSAGES,
    ttlMs: config.AI_CHAT.SESSION_TTL_MS,
    now,
  });
  const requestQueue = createChatRequestQueue({
    maxConcurrency: config.AI_CHAT.MAX_CONCURRENCY,
    maxQueueSize: config.AI_CHAT.MAX_QUEUE_SIZE,
    maxQueueWaitMs: config.AI_CHAT.MAX_QUEUE_WAIT_MS,
  });
  const aiClient = {
    generate: generate || (async () => ({ text: 'H-Hmph. Fine, hello.', provider: 'openrouter', model: 'test', usage: null })),
    getHealth: () => ({
      targets: {
        'mistral:ministral-14b-2512': {
          provider: 'mistral', model: 'ministral-14b-2512', status: 'ok', lastAttemptAt: 1,
        },
        'openrouter:stealth/space-bunny-alpha': {
          provider: 'openrouter', model: 'stealth/space-bunny-alpha', status: 'unknown', lastAttemptAt: null,
        },
      },
      openRouterQuota: { remaining: null, checkedAt: null },
    }),
  };
  const logger = { warn() {}, error() {}, log() {} };
  return {
    sessionStore,
    requestQueue,
    system: createChatSystem({
      config,
      User: makeUserModel(userResult, userError),
      aiClient,
      sessionStore,
      requestQueue,
      logger,
      now,
    }),
  };
}

test('disabled chat does not start session cleanup work', () => {
  let cleanupStarts = 0;
  createChatSystem({
    config: makeConfig({ ENABLED: false }),
    User: makeUserModel(),
    aiClient: { generate() {}, getHealth() {} },
    sessionStore: { startCleanup() { cleanupStarts += 1; } },
    requestQueue: {},
  });

  assert.equal(cleanupStarts, 0);
});

test('scope helpers require an allowed guild, exact channel ID, and non-thread channel', () => {
  const { message } = makeMessage();
  assert.equal(isAllowedGuild(message, ['guild']), true);
  assert.equal(isAllowedChannel(message, ['channel']), true);
  assert.equal(isAllowedGuild(makeMessage({ guildId: 'other' }).message, ['guild']), false);
  assert.equal(isAllowedChannel(makeMessage({ channelId: 'other' }).message, ['channel']), false);
  assert.equal(isAllowedChannel(makeMessage({ isThread: true }).message, ['channel']), false);
  assert.equal(isAllowedChannel(makeMessage({ channelType: ChannelType.GuildVoice }).message, ['channel']), false);
});

test('extracts command tokens and removes both Discord bot mention forms', () => {
  assert.equal(extractCommandToken('  !HELP stuff'), '!help');
  assert.equal(extractCommandToken('<@bot> hello'), '<@bot>');
  assert.equal(extractPrompt('<@bot> hi <@!bot>', 'bot'), 'hi');
  assert.equal(extractPrompt('<@bot> ask <@123> in <#456> with <@&789>', 'bot'), 'ask [user mention] in [channel mention] with [role mention]');
});

test('detects mentions and only owned direct replies while ignoring inaccessible references', async () => {
  assert.equal(await detectTrigger(makeMessage().message, 'bot'), 'mention');
  assert.equal(await detectTrigger(makeMessage({ mentioned: false, content: 'again', referenceAuthorId: 'bot' }).message, 'bot', (id) => id === 'reply-1'), 'reply');
  assert.equal(await detectTrigger(makeMessage({ mentioned: false, content: 'again', referenceAuthorId: 'bot' }).message, 'bot', () => false), null);
  assert.equal(await detectTrigger(makeMessage({ mentioned: true, parsedMentioned: false, content: 'again', referenceAuthorId: 'bot' }).message, 'bot', () => false), null);
  assert.equal(await detectTrigger(makeMessage({ mentioned: false, content: 'again', referenceAuthorId: 'other' }).message, 'bot'), null);
  const broken = makeMessage({ mentioned: false, content: 'again', referenceAuthorId: 'bot' }).message;
  broken.fetchReference = async () => { throw new Error('deleted'); };
  assert.equal(await detectTrigger(broken, 'bot'), null);
});

test('reset prevents an in-flight response from restoring cleared memory', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const { system, sessionStore } = makeSystem({
    config: makeConfig({ USER_COOLDOWN_MS: 0 }),
    generate: async () => { await pending; return { text: 'late answer', provider: 'openrouter' }; },
  });
  const request = makeMessage();
  const running = system.handleMessage(request.message);
  await Promise.resolve();
  await Promise.resolve();

  const reset = makeMessage({ content: '!chat reset', mentioned: false });
  await system.handleCommand(reset.message);
  release();
  await running;

  const key = createSessionKey({ guildId: 'guild', channelId: 'channel', userId: 'user' });
  assert.equal(sessionStore.getStatus(key).turns, 0);
  assert.equal(request.replies.length, 0);
});

test('splits long responses into at most two Discord-safe chunks', () => {
  assert.deepEqual(splitDiscordResponse('short'), ['short']);
  const chunks = splitDiscordResponse(`${'a'.repeat(1800)}\n${'b'.repeat(2200)}`);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 1900));
  assert.match(chunks[1], /…$/);
});

test('safe reply options suppress generated mentions and link previews', () => {
  const options = createSafeReplyOptions('@everyone hello');
  assert.equal(options.content, '@everyone hello');
  assert.deepEqual(options.allowedMentions, { parse: [], repliedUser: false });
  assert.ok(options.flags);
});

test('mention chat sends a safe native reply and commits one exchange', async () => {
  let generatedMessages;
  const { system, sessionStore } = makeSystem({
    generate: async (messages) => {
      generatedMessages = messages;
      return { text: 'H-Hmph. Fine, hello.', provider: 'openrouter', model: 'test', usage: null };
    },
  });
  const { message, replies, getTypingCount } = makeMessage({ userId: 'discord-user-123' });

  assert.equal(await system.handleMessage(message), true);
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0].allowedMentions, { parse: [], repliedUser: false });
  assert.equal(getTypingCount(), 1);
  assert.equal(generatedMessages.at(-1).content, 'hello');
  assert.equal(JSON.stringify(generatedMessages).includes('discord-user-123'), false);
  const key = createSessionKey({ guildId: 'guild', channelId: 'channel', userId: 'discord-user-123' });
  assert.equal(sessionStore.getStatus(key).turns, 1);
});

test('a direct reply continues only the same user session history', async () => {
  const generatedCalls = [];
  const { system } = makeSystem({
    config: makeConfig({ USER_COOLDOWN_MS: 0 }),
    generate: async (messages) => {
      generatedCalls.push(messages);
      return { text: generatedCalls.length === 1 ? 'first answer' : 'second answer', provider: 'openrouter' };
    },
  });

  await system.handleMessage(makeMessage({ content: '<@bot> first question' }).message);
  await system.handleMessage(makeMessage({
    content: 'second question',
    mentioned: false,
    referenceAuthorId: 'bot',
  }).message);

  assert.deepEqual(generatedCalls[1].slice(1).map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' },
  ]);
});

test('ignores ordinary messages, commands, DMs, webhooks, wrong scope, and threads', async () => {
  let calls = 0;
  const { system } = makeSystem({ generate: async () => { calls += 1; return { text: 'no', provider: 'openrouter' }; } });
  const messages = [
    makeMessage({ mentioned: false, content: 'hello' }).message,
    makeMessage({ content: '!help <@bot>' }).message,
    makeMessage({ guildId: null }).message,
    makeMessage({ webhookId: 'hook' }).message,
    makeMessage({ guildId: 'other' }).message,
    makeMessage({ channelId: 'other' }).message,
    makeMessage({ isThread: true }).message,
  ];

  for (const message of messages) assert.equal(await system.handleMessage(message), false);
  assert.equal(calls, 0);
});

test('blocks bot-banned users and fails closed on ban lookup errors', async () => {
  for (const setup of [
    { userResult: { botBanExpiry: Date.now() + 60000 } },
    { userError: new Error('database unavailable') },
  ]) {
    let calls = 0;
    const { system } = makeSystem({ ...setup, generate: async () => { calls += 1; } });
    const { message, replies } = makeMessage();
    assert.equal(await system.handleMessage(message), true);
    assert.equal(calls, 0);
    assert.equal(replies.length, 1);
  }
});

test('rejects empty, oversized, and attachment-only prompts before provider use', async () => {
  let calls = 0;
  const { system } = makeSystem({ generate: async () => { calls += 1; } });
  const cases = [
    makeMessage({ content: '<@bot>' }),
    makeMessage({ content: `<@bot> ${'x'.repeat(1501)}` }),
    makeMessage({ content: '<@bot>', attachments: 1 }),
  ];

  for (const { message, replies } of cases) {
    assert.equal(await system.handleMessage(message), true);
    assert.equal(replies.length, 1);
  }
  assert.equal(calls, 0);
});

test('uses the configured character prompt consistently in configured channels', async () => {
  let prompt = '';
  const { system } = makeSystem({
    generate: async (messages) => {
      prompt = messages[0].content;
      return { text: 'reply', provider: 'openrouter' };
    },
  });
  await system.handleMessage(makeMessage().message);
  assert.match(prompt, /High-Functioning Tsundere Character/i);
});

test('does not commit invisible memory when Discord delivery fails', async () => {
  const { system, sessionStore } = makeSystem();
  const { message } = makeMessage({ replyFails: true });

  assert.equal(await system.handleMessage(message), true);
  const key = createSessionKey({ guildId: 'guild', channelId: 'channel', userId: 'user' });
  assert.equal(sessionStore.getStatus(key).turns, 0);
});

test('records only the first chunk when follow-up delivery fails', async () => {
  const longReply = `${'a'.repeat(1800)}\n${'b'.repeat(300)}`;
  const { system, sessionStore } = makeSystem({
    generate: async () => ({ text: longReply, provider: 'openrouter' }),
  });
  const { message, replies, sends } = makeMessage({ sendFails: true });

  assert.equal(await system.handleMessage(message), true);
  assert.equal(replies.length, 1);
  assert.equal(sends.length, 0);
  const key = createSessionKey({ guildId: 'guild', channelId: 'channel', userId: 'user' });
  assert.deepEqual(sessionStore.getHistory(key), [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: replies[0].content },
  ]);
});

test('reacts instead of sending another message for an occupied session', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const config = makeConfig({ USER_COOLDOWN_MS: 0, MAX_CONCURRENCY: 1 });
  const { system } = makeSystem({
    config,
    generate: async () => { await pending; return { text: 'done', provider: 'openrouter' }; },
  });
  const first = makeMessage();
  const second = makeMessage({ content: '<@bot> second' });
  const running = system.handleMessage(first.message);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(await system.handleMessage(second.message), true);
  assert.deepEqual(second.reactions, ['⏳']);
  release();
  await running;
});

test('chat reset and status operate only on the caller session and expose no secrets', async () => {
  const { system, sessionStore } = makeSystem();
  const key = createSessionKey({ guildId: 'guild', channelId: 'channel', userId: 'user' });
  sessionStore.appendExchange(key, 'hello', 'hi');
  const status = makeMessage({ content: '!chat status', mentioned: false });
  await system.handleCommand(status.message);
  assert.match(status.replies[0].content, /1 exchange/i);
  assert.match(status.replies[0].content, /mistral\/ministral-14b-2512: ok/i);
  assert.match(status.replies[0].content, /openrouter\/stealth\/space-bunny-alpha: unknown/i);
  assert.ok(status.replies[0].content.includes('**OpenRouter quota:** not reported'));
  assert.doesNotMatch(status.replies[0].content, /hidden-router/);
  assert.doesNotMatch(status.replies[0].content, /hidden-mistral/);

  const reset = makeMessage({ content: '!chat reset', mentioned: false });
  await system.handleCommand(reset.message);
  assert.equal(sessionStore.getStatus(key).turns, 0);
});

test('startup summary reports ordered targets and provider availability without secrets', () => {
  const config = makeConfig();
  const { system } = makeSystem({ config });
  const summary = system.getStartupSummary({
    guilds: {
      cache: new Map([['guild', {
        id: 'guild',
        name: 'Test Guild',
        channels: {
          cache: new Map([['channel', { id: 'channel', name: 'general', type: ChannelType.GuildText }]]),
        },
      }]]),
    },
  });

  assert.deepEqual(summary.targets, [
    'mistral/ministral-14b-2512',
    'openrouter/stealth/space-bunny-alpha',
  ]);
  assert.deepEqual(summary.providers, { mistral: true, openrouter: true });
  assert.deepEqual(summary.matchedChannels, ['Test Guild/#general']);
  assert.equal(
    summary.logMessage,
    'Enabled in Test Guild/#general. Provider chain: mistral/ministral-14b-2512 -> openrouter/stealth/space-bunny-alpha.'
  );
  assert.doesNotMatch(JSON.stringify(summary), /hidden-(?:router|mistral)/);
});
