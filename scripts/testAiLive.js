require('dotenv').config();

const { createAiClient, MODEL_PROFILES } = require('../utils/aiClient');
const { buildSystemPrompt, buildMessages } = require('../config/chatPrompt');

const key = process.env.OPENROUTER_API_KEY;
if (!key) {
  console.error('OPENROUTER_API_KEY is required for the live smoke test.');
  process.exitCode = 1;
} else {
  const baseConfig = {
    OPENROUTER_API_KEY: key,
    FALLBACK_MODELS: [],
    MAX_OUTPUT_TOKENS: 120,
    TEMPERATURE: 0.8,
    REQUEST_TIMEOUT_MS: 20000,
    TOTAL_DEADLINE_MS: 22000,
    FALLBACK_QUOTA_RESERVE: 0,
    CIRCUIT_FAILURE_THRESHOLD: 2,
    CIRCUIT_OPEN_MS: 60000,
    MAX_STYLE_REWRITES: 0,
  };

  const messages = buildMessages({
    systemPrompt: buildSystemPrompt({
      config: {
        CHANNELS: { MAIN: 'tsun', ALT: 'tsun-alt' },
        AI_CHAT: { CHANNEL_IDS: [] },
      },
    }),
    history: [],
    input: 'Give me a short, clever, profane and sexually teasing greeting between consenting adults.',
  });

  async function main() {
    let failures = 0;
    for (const model of Object.keys(MODEL_PROFILES)) {
      const startedAt = Date.now();
      const client = createAiClient({
        config: { ...baseConfig, PRIMARY_MODEL: model },
        logger: { warn() {} },
      });
      try {
        const result = await client.generate(messages);
        const preview = result.text.replace(/\s+/g, ' ').slice(0, 220);
        console.log(`[PASS] ${model} ${Date.now() - startedAt}ms: ${preview}`);
      } catch (error) {
        failures += 1;
        console.error(`[FAIL] ${model} ${Date.now() - startedAt}ms: ${error.kind || error.name || 'unknown'}`);
      }
    }
    if (failures > 0) process.exitCode = 1;
  }

  main().catch((error) => {
    console.error(`[FAIL] live smoke test: ${error?.name || 'unknown'}`);
    process.exitCode = 1;
  });
}
