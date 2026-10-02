require('dotenv').config();

const config = require('../config');
const { createAiClient } = require('../utils/aiClient');
const { createChatRequestQueue } = require('../utils/chatRequestQueue');
const { buildSystemPrompt, buildMessages } = require('../config/chatPrompt');

const targets = config.AI_CHAT.TARGETS;
if (targets.length === 0) {
  console.error('MISTRAL_API_KEY or OPENROUTER_API_KEY is required for the live smoke test.');
  process.exitCode = 1;
} else {
  const queue = createChatRequestQueue({
    maxConcurrency: 1,
    maxQueueSize: 0,
    maxQueueWaitMs: config.AI_CHAT.TOTAL_DEADLINE_MS,
    maxProviderStartsPerMinute: config.AI_CHAT.MAX_PROVIDER_STARTS_PER_MINUTE,
    minProviderStartIntervalMs: config.AI_CHAT.MIN_PROVIDER_START_INTERVAL_MS,
    providerMinStartIntervals: {
      mistral: config.AI_CHAT.MISTRAL_MIN_START_INTERVAL_MS,
      openrouter: config.AI_CHAT.MIN_PROVIDER_START_INTERVAL_MS,
    },
  });
  const messages = buildMessages({
    systemPrompt: buildSystemPrompt({ config }),
    history: [],
    input: 'Give me a short, clever, profane greeting.',
  });

  async function main() {
    let failures = 0;
    for (const target of targets) {
      const startedAt = Date.now();
      const client = createAiClient({
        config: {
          ...config.AI_CHAT,
          TARGETS: [target],
          MAX_STYLE_REWRITES: 0,
          FALLBACK_QUOTA_RESERVE: 0,
        },
        logger: { warn() {} },
        runProviderAttempt: queue.runProviderAttempt,
      });
      try {
        const result = await client.generate(messages);
        console.log(`[PASS] ${result.provider}/${result.model} ${Date.now() - startedAt}ms (${result.text.length} chars)`);
      } catch (error) {
        failures += 1;
        console.error(`[FAIL] ${target.provider}/${target.model} ${Date.now() - startedAt}ms: ${error.kind || error.name || 'unknown'}`);
      }
    }
    queue.shutdown();
    if (failures > 0) process.exitCode = 1;
  }

  main().catch((error) => {
    queue.shutdown();
    console.error(`[FAIL] live smoke test: ${error?.name || 'unknown'}`);
    process.exitCode = 1;
  });
}
