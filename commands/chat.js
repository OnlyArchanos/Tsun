const { ChannelType, MessageFlags } = require('discord.js');
const { buildSystemPrompt, buildMessages } = require('../config/chatPrompt');
const { createAiClient } = require('../utils/aiClient');
const { createChatSessionStore, createSessionKey } = require('../utils/chatSessionStore');
const { createChatRequestQueue, ChatQueueError } = require('../utils/chatRequestQueue');

function isAllowedGuild(message, guildIds) {
  return Boolean(message.guild?.id && guildIds.includes(String(message.guild.id).toLowerCase()));
}

function isAllowedChannel(message, channelIds) {
  if (!message.channel || message.channel.type !== ChannelType.GuildText || message.channel.isThread?.()) return false;
  return channelIds.includes(String(message.channel.id));
}

function extractCommandToken(content) {
  return String(content || '').trim().split(/\s+/)[0].toLowerCase();
}

function extractPrompt(content, botId) {
  const mentionPattern = new RegExp(`<@!?${String(botId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`, 'g');
  return String(content || '')
    .replace(mentionPattern, '')
    .replace(/<@!?\d+>/g, '[user mention]')
    .replace(/<@&\d+>/g, '[role mention]')
    .replace(/<#\d+>/g, '[channel mention]')
    .trim();
}

async function detectTrigger(message, botId, ownsResponse = () => true) {
  const escapedBotId = String(botId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const contentMention = new RegExp(`<@!?${escapedBotId}>`).test(String(message.content || ''));
  const explicitlyMentioned = message.mentions?.parsedUsers?.has
    ? message.mentions.parsedUsers.has(botId)
    : contentMention;
  if (explicitlyMentioned) return 'mention';
  if (!message.reference?.messageId || typeof message.fetchReference !== 'function') return null;
  try {
    const referenced = await message.fetchReference();
    return referenced?.author?.id === botId && ownsResponse(String(referenced.id || message.reference.messageId))
      ? 'reply'
      : null;
  } catch {
    return null;
  }
}

function splitDiscordResponse(text, limit = 1900) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  if (normalized.length <= limit) return [normalized];

  let splitAt = Math.max(normalized.lastIndexOf('\n', limit), normalized.lastIndexOf(' ', limit));
  if (splitAt < Math.floor(limit * 0.5)) splitAt = limit;
  const first = normalized.slice(0, splitAt).trim();
  let second = normalized.slice(splitAt).trim();
  if (second.length > limit) second = `${second.slice(0, limit - 1).trimEnd()}…`;
  return [first, second].filter(Boolean);
}

function createSafeReplyOptions(content, extra = {}) {
  return {
    ...extra,
    content,
    allowedMentions: { parse: [], repliedUser: false },
    flags: MessageFlags.SuppressEmbeds,
  };
}

function createChatSystem({
  config,
  User,
  aiClient,
  sessionStore,
  requestQueue,
  logger = console,
  now = Date.now,
} = {}) {
  if (!config?.AI_CHAT) throw new TypeError('AI chat configuration is required.');
  if (!User) throw new TypeError('User model is required.');

  const chatConfig = config.AI_CHAT;
  const sessions = sessionStore || createChatSessionStore({
    maxMessages: chatConfig.SESSION_MAX_MESSAGES,
    ttlMs: chatConfig.SESSION_TTL_MS,
    maxSessions: chatConfig.MAX_SESSIONS,
  });
  const queue = requestQueue || createChatRequestQueue({
    maxConcurrency: chatConfig.MAX_CONCURRENCY,
    maxQueueSize: chatConfig.MAX_QUEUE_SIZE,
    maxQueueWaitMs: chatConfig.MAX_QUEUE_WAIT_MS,
    maxProviderStartsPerMinute: chatConfig.MAX_PROVIDER_STARTS_PER_MINUTE,
    minProviderStartIntervalMs: chatConfig.MIN_PROVIDER_START_INTERVAL_MS,
    providerMinStartIntervals: {
      mistral: chatConfig.MISTRAL_MIN_START_INTERVAL_MS,
      openrouter: chatConfig.MIN_PROVIDER_START_INTERVAL_MS,
    },
  });
  const client = aiClient || createAiClient({
    config: chatConfig,
    logger,
    runProviderAttempt: queue.runProviderAttempt,
  });
  const cooldowns = new Map();
  const sessionGenerations = new Map();
  if (chatConfig.ENABLED) sessions.startCleanup();

  function sessionKeyFor(message) {
    return createSessionKey({
      guildId: message.guild.id,
      channelId: message.channel.id,
      userId: message.author.id,
    });
  }

  function getCooldownRemaining(key) {
    const lastRequestAt = cooldowns.get(key);
    if (lastRequestAt === undefined) return 0;
    const remaining = chatConfig.USER_COOLDOWN_MS - (now() - lastRequestAt);
    if (remaining <= 0) {
      cooldowns.delete(key);
      return 0;
    }
    return remaining;
  }

  function markCooldown(key) {
    cooldowns.set(key, now());
    if (cooldowns.size <= 1000) return;
    for (const [storedKey] of cooldowns) {
      if (getCooldownRemaining(storedKey) === 0) cooldowns.delete(storedKey);
    }
    while (cooldowns.size > 5000) cooldowns.delete(cooldowns.keys().next().value);
  }

  function getSessionGeneration(key) {
    return sessionGenerations.get(key) || 0;
  }

  function invalidateSession(key) {
    const nextGeneration = getSessionGeneration(key) + 1;
    sessionGenerations.delete(key);
    sessionGenerations.set(key, nextGeneration);
    while (sessionGenerations.size > chatConfig.MAX_SESSIONS) {
      sessionGenerations.delete(sessionGenerations.keys().next().value);
    }
  }

  async function isBotBanned(userId) {
    const user = await User.findOne({ userId }).select('botBanExpiry').lean();
    return Boolean(user?.botBanExpiry && Number(user.botBanExpiry) > now());
  }

  async function reactBusy(message) {
    try {
      await message.react('⏳');
    } catch {
      // Reactions are a quiet hint only; missing permissions should not add a message.
    }
  }

  async function beginTyping(channel) {
    try {
      await channel.sendTyping();
    } catch {
      // Typing is presentation only.
    }
    const timer = setInterval(() => {
      channel.sendTyping().catch(() => {});
    }, 8000);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  async function sendGeneratedReply(message, text) {
    const chunks = splitDiscordResponse(text);
    const delivered = [];
    if (chunks.length === 0) throw new Error('AI response was empty after formatting.');

    const firstMessage = await message.reply(createSafeReplyOptions(chunks[0]));
    delivered.push({ id: firstMessage?.id, content: chunks[0] });

    if (chunks[1]) {
      try {
        const followUp = await message.channel.send(createSafeReplyOptions(chunks[1]));
        delivered.push({ id: followUp?.id, content: chunks[1] });
      } catch {
        logger.warn?.('[AI Chat] Follow-up chunk delivery failed.');
      }
    }
    return delivered;
  }

  async function handleMessage(message) {
    if (!chatConfig.ENABLED) return false;
    if (!message?.guild || message.author?.bot || message.webhookId) return false;
    if (!isAllowedGuild(message, chatConfig.GUILD_IDS)) return false;
    if (!isAllowedChannel(message, chatConfig.CHANNEL_IDS)) return false;
    if (extractCommandToken(message.content).startsWith('!')) return false;

    const botId = message.client?.user?.id;
    if (!botId) return false;
    const key = sessionKeyFor(message);
    const generation = getSessionGeneration(key);
    const deadlineAt = now() + chatConfig.TOTAL_DEADLINE_MS;
    if (!(await detectTrigger(message, botId, (responseId) => sessions.ownsResponse(key, responseId)))) return false;

    try {
      if (await isBotBanned(message.author.id)) {
        await message.reply(createSafeReplyOptions("You're currently banned from using Tsun commands or chat. (¬_¬)"));
        return true;
      }
    } catch {
      logger.error?.('[AI Chat] Bot-ban lookup failed.');
      await message.reply(createSafeReplyOptions('I-I cannot check your access right now. Try again later.'));
      return true;
    }

    const prompt = extractPrompt(message.content, botId);
    if (!prompt) {
      const text = message.attachments?.size > 0
        ? "I can't read attachments yet. Add a text question for me, okay?"
        : 'H-Hah? Ask me something first!';
      await message.reply(createSafeReplyOptions(text));
      return true;
    }
    if (prompt.length > chatConfig.MAX_INPUT_CHARS) {
      await message.reply(createSafeReplyOptions(`Keep it under ${chatConfig.MAX_INPUT_CHARS.toLocaleString('en-US')} characters, chatterbox.`));
      return true;
    }

    if (getCooldownRemaining(key) > 0) {
      await reactBusy(message);
      return true;
    }
    markCooldown(key);

    try {
      await queue.run(key, async () => {
        if (getSessionGeneration(key) !== generation) return;
        const stopTyping = await beginTyping(message.channel);
        try {
          const systemPrompt = buildSystemPrompt({ config });
          const providerMessages = buildMessages({
            systemPrompt,
            history: sessions.getHistory(key),
            input: prompt,
          });
          const result = await client.generate(providerMessages, { deadlineAt });
          if (getSessionGeneration(key) !== generation) return;
          const delivered = await sendGeneratedReply(message, result.text);
          if (delivered.length > 0 && getSessionGeneration(key) === generation) {
            sessions.appendExchange(
              key,
              prompt,
              delivered.map((item) => item.content).join('\n\n'),
              delivered.map((item) => item.id).filter(Boolean),
            );
          }
        } finally {
          stopTyping();
        }
      }, { deadlineAt });
    } catch (error) {
      if (error instanceof ChatQueueError) {
        await reactBusy(message);
        return true;
      }
      const category = error?.kind || error?.name || 'unknown';
      logger.error?.(`[AI Chat] Request failed (${category}).`);
      try {
        await message.reply(createSafeReplyOptions("Tch... my brain tripped over itself. Try again in a moment."));
      } catch {
        // If Discord itself is unavailable there is nowhere else to report the failure.
      }
    }
    return true;
  }

  async function handleCommand(message) {
    if (!message?.guild) {
      await message.reply(createSafeReplyOptions('AI chat controls are available only inside a server.'));
      return true;
    }

    const subcommand = String(message.content || '').trim().split(/\s+/)[1]?.toLowerCase();
    const key = sessionKeyFor(message);
    if (subcommand === 'reset') {
      const cleared = sessions.clear(key);
      invalidateSession(key);
      cooldowns.delete(key);
      await message.reply(createSafeReplyOptions(cleared
        ? 'F-Fine, I forgot this conversation. Happy now?'
        : "There's no conversation here to forget."));
      return true;
    }

    if (subcommand === 'status') {
      const session = sessions.getStatus(key);
      const health = client.getHealth();
      const queueStatus = queue.getStatus();
      const eligible = chatConfig.ENABLED &&
        isAllowedGuild(message, chatConfig.GUILD_IDS) &&
        isAllowedChannel(message, chatConfig.CHANNEL_IDS);
      const exchangeLabel = session.turns === 1 ? 'exchange' : 'exchanges';
      const content = [
        `**Tsun Chat:** ${eligible ? 'available here' : 'unavailable here'}`,
        `**Memory:** ${session.turns} ${exchangeLabel}${session.expiresAt ? `, expires <t:${Math.floor(session.expiresAt / 1000)}:R>` : ''}`,
        `**Cooldown:** ${Math.ceil(getCooldownRemaining(key) / 1000)}s`,
        `**Models:** ${Object.entries(health.models || {}).map(([model, state]) => `${model.split('/').at(-1)}: ${state.status}`).join('; ') || 'unknown'}`,
        `**Quota:** ${health.quota?.remaining ?? 'not reported'}`,
        `**Load:** ${queueStatus.active} active, ${queueStatus.queued} queued`,
      ].join('\n');
      await message.reply(createSafeReplyOptions(content));
      return true;
    }

    await message.reply(createSafeReplyOptions('Use `!chat status` or `!chat reset`.'));
    return true;
  }

  function getStartupSummary(discordClient) {
    const matched = [];
    for (const guild of discordClient?.guilds?.cache?.values?.() || []) {
      if (!chatConfig.GUILD_IDS.includes(String(guild.id).toLowerCase())) continue;
      for (const channel of guild.channels?.cache?.values?.() || []) {
        if (channel.type === ChannelType.GuildText && chatConfig.CHANNEL_IDS.includes(String(channel.id))) {
          matched.push(`${guild.name || guild.id}/#${channel.name}`);
        }
      }
    }
    return {
      enabled: chatConfig.ENABLED,
      requestedEnabled: chatConfig.REQUESTED_ENABLED,
      matchedChannels: matched,
      warnings: [...chatConfig.WARNINGS],
      models: [chatConfig.PRIMARY_MODEL, ...(chatConfig.FALLBACK_MODELS || [])],
    };
  }

  return { handleMessage, handleCommand, getStartupSummary };
}

module.exports = {
  createChatSystem,
  isAllowedGuild,
  isAllowedChannel,
  extractCommandToken,
  extractPrompt,
  detectTrigger,
  splitDiscordResponse,
  createSafeReplyOptions,
};
