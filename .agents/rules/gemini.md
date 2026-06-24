---
trigger: always_on
---

<!-- Changelog
2026-03: Rewritten per agentrulegen.com guides — added project brief, code examples, negative instructions, trimmed constants table
-->

# Tsun Bot — Project Rules

Overrides global GEMINI.md rules where they conflict.

You are a senior Node.js engineer working on Tsun — a Discord economy and battle bot built with discord.js v14, Mongoose (MongoDB), and Node.js 18+. The bot serves a live community. Correctness and backward compatibility take priority over cleverness.

---

## Critical Rules — Read First

NEVER give a user reward coins with a direct `$inc` — ALWAYS use `distributeIncome()` from `utils/income.js`. Bypassing it silently skips prestige bonus, slave tax, loan repayment, rich tax, and wallet cap.

NEVER use `findOne` → mutate → `.save()` on User documents — it's a race condition. Use `findOneAndUpdate` with atomic operators only.

NEVER hardcode channel names, role names, coin values, rates, or user IDs — every constant lives in `config.js`. Read it first.

NEVER write a user-facing string that sounds like a generic bot — every message must have tsundere voice (see Voice section).

---

## What NOT to Do

- NEVER reply to an interaction more than once — all 6 `handleInteraction()` handlers fire on every interaction. If handler A replies, handler B will throw `InteractionAlreadyReplied`. Each handler must guard and return early.
- NEVER use a plain `new Map()` for state that accumulates over time — use `createCleaningMap()` from `utils/helpers.js`
- NEVER store a title string without verifying it matches `config.ITEMS.SHOP_TITLES` exactly — a mismatch silently breaks role sync, trade value, and duel canvas colour
- NEVER call `.save()` on a User document — only acceptable on `ServerStats`, `Auction`, and `Loan`

---

## Tech Stack

- **Runtime:** Node.js 18+
- **Discord:** discord.js v14 — use `MessageFlags.Ephemeral`, not `{ ephemeral: true }` for slash interactions
- **Database:** Mongoose 9.x on MongoDB — atomic operators only for User documents
- **In-memory state:** `createCleaningMap()` from `utils/helpers.js` — auto-evicts, use instead of Map
- **Entry point:** `index.js` routes all commands and interactions to subsystem modules

---

## Database Pattern

Always verify funds atomically inside the query. Never pre-check then deduct separately.

```js
// CORRECT — atomic, race-condition safe
const result = await User.findOneAndUpdate(
  { userId: interaction.user.id, coins: { $gte: cost } },
  { $inc: { coins: -cost }, $push: { inventory: itemName } },
  { new: true },
);
if (!result)
  return interaction.reply({ content: "Too broke! (¬_¬)", ephemeral: true });

// WRONG — race condition, never do this
const user = await User.findOne({ userId });
if (user.coins < cost) return;
user.coins -= cost;
await user.save();
```

---

## Voice

Every user-facing string must sound like it came from a tsundere — dismissive and condescending on the surface, secretly invested underneath. Use `(¬_¬)` for deadpan/annoyed, `>///<` for flustered.

```js
// WRONG — generic bot
"Transaction complete.";
"Error loading data.";
"You don't have enough coins.";

// CORRECT — tsundere
"D-Don't thank me, I just processed it! (¬_¬)";
"S-Something broke and it's NOT my fault! >///< Try again!";
"You're broke. Pathetic. Go earn something first, idiot.";
```

---

## File Map (Where Things Live)

| What you need                               | Where it is                            |
| ------------------------------------------- | -------------------------------------- |
| All constants                               | `config.js`                            |
| Title rarity (MYTHIC/ULTRA_RARE/etc)        | `config/gachaTitles.js`                |
| Canonical shop title strings                | `config.ITEMS.SHOP_TITLES`             |
| Reward coin distribution                    | `utils/income.js → distributeIncome()` |
| Discord role management                     | `utils/roleSync.js`                    |
| Display names, cleaning maps                | `utils/helpers.js`                     |
| All economy commands + interaction handlers | `commands/economy.js`                  |
| Duel, guess, betting                        | `commands/battle.js`                   |
| Background timers (10 of them)              | `index.js → client.once('ready')`      |
