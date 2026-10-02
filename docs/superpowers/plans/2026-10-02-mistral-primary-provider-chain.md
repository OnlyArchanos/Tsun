# Mistral-Primary Provider Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Tsun conversations through official Mistral 14B and 8B first, then through the existing OpenRouter models when Mistral cannot serve the request.

**Architecture:** Configuration produces explicit `{ provider, model }` targets. The AI client selects a provider adapter per target while sharing deadlines, response normalization, health, circuits, ordered fallback, and same-target style rewrites. Provider admission keeps a global rolling limit plus independent Mistral/OpenRouter spacing.

**Tech Stack:** Node.js 18+, CommonJS, built-in `fetch`/`AbortController`, `node:test`, discord.js.

## Global Constraints

- Default order is Mistral 14B, Mistral 8B, Space Bunny, then Nemotron Ultra.
- `MISTRAL_API_KEY` takes precedence over the compatibility alias `MISTRALOG_API_KEY`.
- Missing credentials remove only that provider's targets; at least one provider is required to enable chat.
- HTTP 400/422 fail globally; authentication skips the rest of the failed provider; retryable failures advance one target.
- OpenRouter quota reserve applies only when entering OpenRouter.
- Mistral starts are separated by at least 2,100 ms by default.
- Credentials, prompts, raw provider bodies, and conversation text never appear in status, logs, or thrown error messages.
- Automated tests perform no live network, Discord, or MongoDB work.

---

### Task 1: Provider Configuration

**Files:**
- Modify: `tests/chat-config.test.js`
- Modify: `config.js`
- Modify: `.env.example`

**Interfaces:**
- Produces: `AI_CHAT.MISTRAL_API_KEY`, `AI_CHAT.OPENROUTER_API_KEY`, `AI_CHAT.TARGETS`, `AI_CHAT.MISTRAL_MIN_START_INTERVAL_MS`.
- `TARGETS` is an ordered array of `{ provider: 'mistral'|'openrouter', model: string }`.

- [ ] **Step 1: Write failing configuration tests**

Add tests that call `buildAiChatConfig(env)` and assert canonical-key precedence, alias support, Mistral-only and OpenRouter-only enablement, no-provider disablement, ordered target construction, deduplicated CSV models, and warnings that name missing provider availability without containing key values.

```js
assert.deepEqual(config.TARGETS.slice(0, 2), [
  { provider: 'mistral', model: 'ministral-14b-2512' },
  { provider: 'mistral', model: 'ministral-8b-2512' },
]);
assert.equal(config.MISTRAL_API_KEY, 'canonical');
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test tests/chat-config.test.js`

Expected: failures because `buildAiChatConfig` is not exported and provider targets do not exist.

- [ ] **Step 3: Implement provider configuration**

Export `buildAiChatConfig`. Read the canonical/alias key, parse model CSV lists, build credential-filtered ordered targets, and base `ENABLED` on guild/channel validity plus at least one target.

```js
const mistralKey = env.MISTRAL_API_KEY || env.MISTRALOG_API_KEY || '';
const targets = [
  ...(mistralKey ? mistralModels.map((model) => ({ provider: 'mistral', model })) : []),
  ...(openRouterKey ? openRouterModels.map((model) => ({ provider: 'openrouter', model })) : []),
];
```

Document only example credential values and the three new environment settings in `.env.example`.

- [ ] **Step 4: Run tests and syntax checks for GREEN**

Run: `node --test tests/chat-config.test.js`

Run: `node --check config.js`

- [ ] **Step 5: Commit the configuration unit**

```bash
git add config.js .env.example tests/chat-config.test.js
git commit -m "feat: configure Mistral-first AI targets"
```

---

### Task 2: Provider-Aware Admission

**Files:**
- Modify: `tests/chat-request-queue.test.js`
- Modify: `utils/chatRequestQueue.js`
- Modify: `commands/chat.js`

**Interfaces:**
- Changes: `runProviderAttempt(task, { deadlineAt, provider })`.
- Changes: `getProviderStatus()` returns global counts plus per-provider spacing waits.

- [ ] **Step 1: Write failing queue tests**

Add deterministic fake-clock tests proving two Mistral starts are spaced 2,100 ms, an intervening OpenRouter start is not delayed by Mistral spacing, all providers share the rolling starts-per-minute cap, admission respects the total deadline, and shutdown rejects admission.

```js
await queue.runProviderAttempt(task, { provider: 'mistral' });
await queue.runProviderAttempt(task, { provider: 'openrouter' });
assert.deepEqual(starts, [
  ['mistral', 0],
  ['openrouter', 0],
]);
```

- [ ] **Step 2: Run queue tests and verify RED**

Run: `node --test tests/chat-request-queue.test.js`

Expected: provider spacing assertions fail because the queue owns one global `lastProviderStartAt`.

- [ ] **Step 3: Implement provider-aware spacing**

Replace the single last-start timestamp with a Map. Keep one global rolling `providerStarts` list and serialize admission decisions. Pass provider spacing from `commands/chat.js`:

```js
providerMinStartIntervals: {
  mistral: chatConfig.MISTRAL_MIN_START_INTERVAL_MS,
  openrouter: chatConfig.MIN_PROVIDER_START_INTERVAL_MS,
}
```

Unknown providers use the existing default interval so injected/custom callers remain bounded.

- [ ] **Step 4: Run focused queue and chat tests for GREEN**

Run: `node --test tests/chat-request-queue.test.js tests/chat-command.test.js`

Run: `node --check utils/chatRequestQueue.js`

- [ ] **Step 5: Commit the admission unit**

```bash
git add utils/chatRequestQueue.js commands/chat.js tests/chat-request-queue.test.js tests/chat-command.test.js
git commit -m "feat: add provider-aware AI request spacing"
```

---

### Task 3: Unified Mistral/OpenRouter Client

**Files:**
- Modify: `tests/ai-client.test.js`
- Modify: `utils/aiClient.js`

**Interfaces:**
- Consumes: `config.TARGETS`, both provider keys, and `runProviderAttempt(task, { deadlineAt, provider })`.
- Produces: `generate(messages, options)` results `{ text, provider, model, usage }`.
- Produces: `getHealth()` with target keys `provider:model` and `openRouterQuota`.

- [ ] **Step 1: Replace OpenRouter-only fixtures with explicit target fixtures**

Use this default test configuration:

```js
TARGETS: [
  { provider: 'mistral', model: 'ministral-14b-2512' },
  { provider: 'mistral', model: 'ministral-8b-2512' },
  { provider: 'openrouter', model: 'stealth/space-bunny-alpha' },
],
MISTRAL_API_KEY: 'mistral-secret',
OPENROUTER_API_KEY: 'router-secret',
```

- [ ] **Step 2: Add failing provider-routing tests**

Test Mistral endpoint/body/header, OpenRouter endpoint/profile, exact fallback order, retryable Mistral-to-Mistral fallback, exhausted Mistral-to-OpenRouter fallback, provider-scoped auth skipping, fatal 400/422, quota checking only on entry to OpenRouter, independent target circuits, and same-target style rewrite.

```js
assert.equal(calls[0].url, 'https://api.mistral.ai/v1/chat/completions');
assert.equal(calls[0].options.headers.Authorization, 'Bearer mistral-secret');
assert.equal(result.provider, 'mistral');
```

- [ ] **Step 3: Run AI-client tests and verify RED**

Run: `node --test tests/ai-client.test.js`

Expected: the client ignores `TARGETS`, calls OpenRouter, and cannot expose provider-qualified health.

- [ ] **Step 4: Implement target and adapter helpers**

Add pure helpers:

```js
function targetKey({ provider, model }) {
  return `${provider}:${model}`;
}

function buildProviderRequest(target, config, messages) {
  // Return { url, options } with provider-specific key and body.
}
```

Update `AiProviderError` to receive the explicit provider. Make `callTarget(target, messages, deadlineAt)` apply the target's provider adapter, pass provider identity into admission, validate responses, and update target-keyed health.

- [ ] **Step 5: Implement ordered fallback semantics**

Track providers with failed authentication so later targets from that provider are skipped. Throw immediately on bad request. Before the first OpenRouter target, call the renamed OpenRouter quota-reserve helper exactly once. Continue only on retryable or provider-auth failures.

- [ ] **Step 6: Keep style rewrites on the successful target**

Pass the complete successful target into `applyStyle`; call that exact target for rewriting and preserve the denser result. The rewrite must not fall through to another target.

- [ ] **Step 7: Run focused and neighboring tests for GREEN**

Run: `node --test tests/ai-client.test.js tests/chat-request-queue.test.js tests/chat-command.test.js`

Run: `node --check utils/aiClient.js`

- [ ] **Step 8: Commit the client unit**

```bash
git add utils/aiClient.js tests/ai-client.test.js
git commit -m "feat: route AI through Mistral before OpenRouter"
```

---

### Task 4: Discord Status and Startup Reporting

**Files:**
- Modify: `tests/chat-command.test.js`
- Modify: `commands/chat.js`

**Interfaces:**
- Consumes: provider-qualified health and ordered `TARGETS`.
- Produces: secret-free `!chat status` and `getStartupSummary()` output.

- [ ] **Step 1: Write failing status tests**

Assert that status identifies `mistral/ministral-14b-2512` and `openrouter/space-bunny-alpha`, labels quota as OpenRouter-specific, reports provider configuration booleans, preserves target order, and contains neither configured key.

- [ ] **Step 2: Run chat-command tests and verify RED**

Run: `node --test tests/chat-command.test.js`

Expected: old model-only output and generic quota label fail assertions.

- [ ] **Step 3: Implement provider-qualified reporting**

Format health entries from their explicit provider/model data. Startup summary returns the ordered target display names and booleans only:

```js
providers: {
  mistral: Boolean(chatConfig.MISTRAL_API_KEY),
  openrouter: Boolean(chatConfig.OPENROUTER_API_KEY),
}
```

- [ ] **Step 4: Run focused tests and syntax checks for GREEN**

Run: `node --test tests/chat-command.test.js`

Run: `node --check commands/chat.js`

- [ ] **Step 5: Commit the Discord integration unit**

```bash
git add commands/chat.js tests/chat-command.test.js
git commit -m "feat: report AI provider chain status"
```

---

### Task 5: Complete Verification and Live Smoke Test

**Files:**
- Verify: all files changed above
- Local configuration: `.env` may receive the canonical variable name; `.env` remains ignored and uncommitted.

**Interfaces:**
- Verifies the complete provider chain without changing its public contract.

- [ ] **Step 1: Run the complete isolated test suite**

Run: `npm test`

Expected: zero failures and no live provider requests.

- [ ] **Step 2: Parse every project JavaScript file**

Run a PowerShell loop over `rg --files -g "*.js"` and execute `node --check` for every path.

Expected: zero syntax failures.

- [ ] **Step 3: Run repository hygiene checks**

Run: `git diff --check`

Search tracked files for real key prefixes and raw provider-body or authorization logging. Confirm `.env` is ignored and `tsun-old/` remains untouched.

- [ ] **Step 4: Run a live ordered-fallback smoke test**

Using keys only from process environment, instantiate the production client with style rewrites disabled for the smoke test. Verify a normal request returns provider `mistral` and model `ministral-14b-2512`. Then inject a retryable first-target failure while leaving the real second Mistral request intact and verify `ministral-8b-2512` serves it. Do not print credentials, prompts, or full response bodies.

- [ ] **Step 5: Review the final diff for logic errors**

Check every timeout cleanup, circuit key, auth-skip branch, OpenRouter quota transition, target ordering operation, and early return. Verify status output cannot leak credentials and style rewrites cannot switch providers.

- [ ] **Step 6: Commit verification corrections if the audit finds any**

For each discovered defect, add a failing regression test first, verify RED, make the smallest production correction, verify GREEN, and commit that test with its corresponding source file using `git commit -m "fix: harden AI provider fallback edge cases"`. Skip this step when the audit finds no defect.
