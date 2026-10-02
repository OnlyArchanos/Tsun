# Mistral-Primary Provider Chain Design

## Goal

Make official Mistral the primary conversational provider for Tsun while retaining the current OpenRouter models as operational fallbacks. Preserve the existing conversation routing, temporary memory, rate controls, deadlines, circuit breakers, response validation, and style rewrite behavior.

## Provider Order

The default ordered target chain is:

1. Mistral `ministral-14b-2512`
2. Mistral `ministral-8b-2512`
3. OpenRouter `stealth/space-bunny-alpha`
4. OpenRouter `nvidia/nemotron-3-ultra-550b-a55b:free`
5. OpenRouter `inclusionai/ling-3.0-flash-fin:free`

Each target is represented explicitly as `{ provider, model }`. Provider selection must never be inferred from the model name.

## Configuration

`MISTRAL_API_KEY` is the canonical official-Mistral credential. `MISTRALOG_API_KEY` remains a compatibility alias so an existing deployment can migrate without an immediate environment rename. If both are present, `MISTRAL_API_KEY` wins.

The AI feature is configured when guild IDs, channel IDs, and at least one provider credential are present. A missing Mistral key disables only Mistral targets; a missing OpenRouter key disables only OpenRouter targets. Chat remains disabled when no provider is configured.

Defaults:

- `TSUN_AI_MISTRAL_MODELS=ministral-14b-2512,ministral-8b-2512`
- `TSUN_AI_OPENROUTER_MODELS=stealth/space-bunny-alpha,nvidia/nemotron-3-ultra-550b-a55b:free,inclusionai/ling-3.0-flash-fin:free`
- `TSUN_AI_MISTRAL_MIN_START_INTERVAL_MS=2100`

The previous `TSUN_AI_PRIMARY_MODEL` and `TSUN_AI_FALLBACK_MODELS` variables are replaced in the documented configuration. They are not silently mixed into the new chain because ambiguous cross-provider model ownership is unsafe.

No real credentials are added to tracked files, logs, status responses, thrown errors, or tests.

## Client Architecture

`utils/aiClient.js` owns one ordered target list and provider adapters for Mistral and OpenRouter. Shared code continues to own:

- request deadlines and abort handling;
- response-content and usage normalization;
- sanitized error classification;
- per-target health and circuit state;
- ordered fallback;
- same-target style rewrites.

Provider adapters own only endpoint, authentication header, provider-specific request options, and provider-specific quota behavior. OpenRouter reasoning profiles are applied only to matching OpenRouter models. Official Mistral requests use the standard chat-completions schema without OpenRouter reasoning fields.

Health is keyed by `provider:model`, preventing two providers exposing similarly named models from sharing circuit state. Generated results continue to return separate `provider` and `model` fields.

## Failure Behavior

Retryable failures include timeout, network failure, rate limiting, server errors, unavailable models, malformed successful responses, temporary quota errors, and open circuits. These advance to the next target while the total request deadline permits.

Authentication failures are provider-scoped. An authentication failure skips all remaining targets belonging to that provider, records the failure in health, and continues at the next configured provider. This avoids repeating a known-invalid key while allowing OpenRouter to keep the bot available. `!chat status` must expose the provider health category without exposing credentials or raw response bodies.

HTTP 400 and 422 remain fatal for the whole request. They indicate a likely request-shape or implementation defect that fallback could hide.

OpenRouter quota-reserve checks run only before the first OpenRouter fallback target. They never run between Mistral targets and never make a request when OpenRouter is not configured. A depleted OpenRouter reserve stops the OpenRouter portion of the chain.

## Rate Control

The existing request queue remains responsible for user-level concurrency and waiting limits. Provider admission becomes provider-aware:

- all starts remain globally bounded by the existing starts-per-minute limit;
- Mistral starts additionally observe a 2,100 ms minimum interval;
- OpenRouter starts retain the existing configurable minimum interval;
- provider admission waits count against the existing total request deadline;
- style rewrites pass their provider identity through the same admission controls.

Provider-specific timing state must not cause one provider's spacing requirement to delay another provider unnecessarily.

## Discord Status and Startup Summary

`!chat status` shows each configured target with its provider, model, and sanitized health state. OpenRouter quota is labeled explicitly rather than appearing to apply to Mistral. The startup summary reports the ordered provider chain and whether each provider is configured, never credential values.

The ordinary user-facing chat behavior, command precedence, allowed guild/channel checks, session boundaries, reply suppression, and response formatting remain unchanged.

## Tests

Configuration tests cover canonical and compatibility Mistral keys, precedence when both exist, Mistral-only configuration, OpenRouter-only configuration, no-provider disabling, model-list parsing, and secret-free summaries.

AI-client tests cover:

- Mistral endpoint, bearer header, request body, response, and usage normalization;
- OpenRouter endpoint, profiles, and quota checks;
- exact five-target default ordering;
- Mistral retryable failure to second Mistral target;
- Mistral exhaustion to OpenRouter;
- provider-scoped authentication skipping;
- global 400/422 failure behavior;
- OpenRouter reserve isolation;
- independent provider/model circuits and health;
- style rewrite using the same provider and model;
- missing-provider-key filtering;
- input immutability and secret sanitization.

Queue tests cover independent provider spacing, the global rolling limit, admission deadlines, shutdown, and serialized admission without long real sleeps.

Chat-command tests cover provider-qualified status and startup output. The complete isolated test suite and syntax checks run after implementation; no automated test contacts live providers.

## Rollout

Deploy with both credentials configured and chat disabled, run the isolated suite, enable chat in the existing allowlisted guild/channels, and verify one real conversation. The previously tested Mistral credential belongs only in `.env`. OpenRouter remains available automatically when Mistral is rate-limited, unavailable, or misconfigured.
