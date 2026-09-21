# Owner Cooldown Status in `!help owner` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide owners with immediate, dynamic visibility into their 1-hour command cooldown inside the secret `!help owner` manual using Discord live timestamps without mutating database state.

**Architecture:** A read-only helper `getOwnerCooldownRemaining(userId)` in `utils/helpers.js` queries `User.findOne().select('lastOwnerCommandAt').lean()` against `config.TIMING.OWNER_COMMAND_COOLDOWN`. In `commands/utility.js`, the `!help owner` handler awaits this helper and prefixes the manual embed description with a live status banner (`<t:unix:R>`) and tsundere dialog.

**Tech Stack:** Node.js 18+, discord.js v14, Mongoose / MongoDB.

## Global Constraints

- NEVER use direct `$inc` for reward coins — use `distributeIncome()` (irrelevant here as no coins are granted).
- NEVER call `.save()` or mutate User documents in read-only queries — use `.lean()` only.
- Match existing code style and tsundere voice (`(¬_¬)`, `>///<`, dismissive exterior / secretly invested).
- Preserve all existing command entries and structure in `!help owner`.

---

### Task 1: Create `getOwnerCooldownRemaining` Read-Only Helper

**Files:**
- Modify: `utils/helpers.js:195-209`

**Interfaces:**
- Consumes: `User` model, `config.TIMING.OWNER_COMMAND_COOLDOWN` (1 hour).
- Produces: `getOwnerCooldownRemaining(userId: string): Promise<{ onCooldown: boolean, remaining: number, expiryUnix: number }>`

- [ ] **Step 1: Implement `getOwnerCooldownRemaining` in `utils/helpers.js`**

Add the read-only function before `module.exports` and export it:

```javascript
/**
 * Read-only check for owner command cooldown without modifying DB state.
 * @param {string} userId - The owner's Discord user ID
 * @returns {Promise<{onCooldown: boolean, remaining: number, expiryUnix: number}>}
 */
async function getOwnerCooldownRemaining(userId) {
    const cooldown = config.TIMING.OWNER_COMMAND_COOLDOWN;
    const user = await User.findOne({ userId }).select('lastOwnerCommandAt').lean();
    if (!user || !user.lastOwnerCommandAt) {
        return { onCooldown: false, remaining: 0, expiryUnix: 0 };
    }

    const elapsed = Date.now() - user.lastOwnerCommandAt;
    if (elapsed >= cooldown) {
        return { onCooldown: false, remaining: 0, expiryUnix: 0 };
    }

    const remaining = cooldown - elapsed;
    const expiryUnix = Math.floor((user.lastOwnerCommandAt + cooldown) / 1000);
    return { onCooldown: true, remaining, expiryUnix };
}
```

Add `getOwnerCooldownRemaining` to `module.exports` in `utils/helpers.js`.

- [ ] **Step 2: Run syntax verification on `utils/helpers.js`**

Run: `node -c utils/helpers.js`  
Expected: Clean exit (code 0).

- [ ] **Step 3: Run standalone verification script**

Run: A scratch script verifying `getOwnerCooldownRemaining` handles:
1. User with no `lastOwnerCommandAt` -> `{ onCooldown: false, remaining: 0, expiryUnix: 0 }`
2. User with expired `lastOwnerCommandAt` -> `{ onCooldown: false, remaining: 0, expiryUnix: 0 }`
3. User with active `lastOwnerCommandAt` -> `{ onCooldown: true, remaining: > 0, expiryUnix: > 0 }`
4. Confirm zero DB writes occur.

---

### Task 2: Update `!help owner` in `commands/utility.js` with Live Dynamic Banner

**Files:**
- Modify: `commands/utility.js:8` (helpers import)
- Modify: `commands/utility.js:1260-1280` (`!help owner` handler)

**Interfaces:**
- Consumes: `getOwnerCooldownRemaining(userId)` from `utils/helpers.js`.
- Produces: Dynamic embed description with live Discord relative timestamp.

- [ ] **Step 1: Import `getOwnerCooldownRemaining` in `commands/utility.js`**

Update the import at line 8:
```javascript
const { checkOwnerCooldown, getOwnerCooldownRemaining } = require('../utils/helpers');
```

- [ ] **Step 2: Update `!help owner` handler in `commands/utility.js`**

Inside `if (helpArgs[1]?.toLowerCase() === 'owner')`:
1. Call `const cdStatus = await getOwnerCooldownRemaining(message.author.id);`
2. Build status banner:
   - If `cdStatus.onCooldown`:
     ```javascript
     const mins = Math.ceil(cdStatus.remaining / 60000);
     const statusBanner = `⏳ **Status:** **On Cooldown** — Ready <t:${cdStatus.expiryUnix}:R> (approx. **${mins}m**)\n*Don't even think about running anything right now, baka!* (¬_¬)\n\n`;
     ```
   - If not on cooldown:
     ```javascript
     const statusBanner = `🟢 **Status:** **Ready to Cast**\n*You can use one owner command right now. Choose wisely!* >///<\n\n`;
     ```
3. Inject `statusBanner` into embed description.

- [ ] **Step 3: Run syntax verification**

Run: `node -c commands/utility.js`  
Expected: Clean exit (code 0).

---

### Task 3: Comprehensive Verification

**Files:**
- Verify: `commands/utility.js`, `utils/helpers.js`, `index.js`, `commands/economy.js`

- [ ] **Step 1: Run project-wide syntax check**

Run: `node -c index.js; node -c commands/utility.js; node -c utils/helpers.js; node -c commands/economy.js`  
Expected: All exit with code 0.

- [ ] **Step 2: Verify `!help` regression testing**

Confirm regular `!help` without arguments still displays the select menu properly and is completely unaffected.
