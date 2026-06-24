# TSUN BOT — Complete AI Reference Document

> **Purpose of this file:** This README is the single source of truth for the Tsun Discord bot. It contains every file, every function, every command, every constant, every interaction ID, and every data field. An AI reading only this file should understand the entire codebase with no gaps.

---

## TABLE OF CONTENTS

1. [Project Overview](#1-project-overview)
2. [Tech Stack & Dependencies](#2-tech-stack--dependencies)
3. [Environment Variables](#3-environment-variables)
4. [File Tree](#4-file-tree)
5. [config.js — All Constants](#5-configjs--all-constants)
6. [config/gachaTitles.js](#6-configgachatitlesjs)
7. [config/phrases.js](#7-configphrasesjs)
8. [MongoDB Models](#8-mongodb-models)
9. [Utils](#9-utils)
10. [index.js — Entry Point](#10-indexjs--entry-point)
11. [commands/battle.js](#11-commandsbattlejs)
12. [commands/economy.js](#12-commandseconomyjs)
13. [commands/election.js](#13-commandselectionjs)
14. [commands/guessOp.js](#14-commandsguessopjs)
15. [commands/higherLower.js](#15-commandshigherlowerjs)
16. [commands/leaderboard.js](#16-commandsleaderboardjs)
17. [commands/market.js](#17-commandsmarketjs)
18. [commands/trade.js](#18-commandstradejs)
19. [commands/utility.js](#19-commandsutilityjs)
20. [Interaction ID Master List](#20-interaction-id-master-list)
21. [Income Pipeline](#21-income-pipeline)
22. [Background Timers](#22-background-timers)
23. [Bot Personality Rules](#23-bot-personality-rules)
24. [Deployment](#24-deployment)

---

## 1. PROJECT OVERVIEW

**Name:** Tsun (package: `tsun`)
**Runtime:** Node.js ≥18, `npm start` → runs `index.js`
**Database:** MongoDB via Mongoose
**Platform:** Discord (discord.js v14), text-command based (`!command`)
**Personality:** Tsundere anime girl — sarcastic, dismissive, reluctant, uses "Baka!", ">///<", "(¬_¬)", "You idiot!" in every response. Never neutral or corporate.

**Core feature pillars:**

- Economy (coins, wallet cap, taxes, vault savings account)
- PvP duel system with ELO and Canvas-rendered battle cards
- Slavery system (loans → default → enslavement → auction → freedom)
- Gacha loot boxes with rarity tiers and pity system
- Player-to-player market and trading
- Mini-games: slots, roulette, coin toss, Higher/Lower manga, guess-the-character, guess anime OP/ED
- Server moderation elections with bracket tournament
- Prestige/isekai reset system
- Role sync (title roles + prestige roles tied to DB state)

**Express.js keep-alive server** runs on `PORT` env var (default 3000). GET `/` returns `'Tsun is awake! (¬_¬)'` for uptime monitoring.

---

## 2. TECH STACK & DEPENDENCIES

| Package              | Version  | Purpose                                                          |
| -------------------- | -------- | ---------------------------------------------------------------- |
| `discord.js`         | ^14.25.1 | Discord API client                                               |
| `mongoose`           | ^9.1.3   | MongoDB ODM                                                      |
| `mongodb`            | ^7.0.0   | MongoDB driver                                                   |
| `canvas`             | ^3.2.1   | Server-side image rendering for duel cards and Higher/Lower game |
| `cloudinary`         | ^2.8.0   | CDN image hosting for user duel grid images                      |
| `axios`              | ^1.6.7   | HTTP requests (AniList, AnimeThemes APIs)                        |
| `fluent-ffmpeg`      | ^2.1.3   | Audio clip trimming for OP/ED guessing                           |
| `ffmpeg-static`      | ^5.3.0   | Static ffmpeg binary                                             |
| `fuse.js`            | ^7.1.0   | Fuzzy string matching for anime title guessing                   |
| `async-lock`         | ^1.4.1   | Mutex lock for concurrent duel prevention                        |
| `express`            | ^4.18.2  | Keep-alive HTTP server                                           |
| `dotenv`             | ^16.6.1  | `.env` injection                                                 |
| `@heyputer/puter.js` | ^2.2.2   | (imported, utility use)                                          |

**Dockerfile:** Node 22 (bookworm). Installs `libcairo2-dev`, `libpango1.0-dev`, `libjpeg-dev`, `libgif-dev`, `librsvg2-dev` for the `canvas` package. Runs `npm ci --omit=dev` then `npm start`.

---

## 3. ENVIRONMENT VARIABLES

All loaded via `dotenv`. Required in `.env`:

| Variable                | Description                            |
| ----------------------- | -------------------------------------- |
| `DISCORD_TOKEN`         | Bot login token                        |
| `MONGO_URI`             | MongoDB connection string              |
| `PORT`                  | Express keep-alive port (default 3000) |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary account name                |
| `CLOUDINARY_API_KEY`    | Cloudinary API key                     |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret                  |
| `POLLINATIONS_API_KEY`  | Pollinations API key                   |
| `OPENROUTER_API_KEY`    | OpenRouter API key                     |
| `DASHBOARD_PASSWORD`    | Admin Dashboard Password               |
| `SESSION_SECRET`        | Express Session Secret                 |
| `OWNER_ID`              | Discord user ID of the bot owner       |
| `MAL_CLIENT_ID`         | MyAnimeList Client ID                  |

*Note: Copy `.env.example` to `.env` to configure these variables before starting the bot.*

Bot logs `❌ CRITICAL` and `✅` for each env var at startup.

---

## 4. FILE TREE

```
index.js                   ← Entry point, event hub, all timers
config.js                  ← ALL game constants (single source of truth)
config/
  gachaTitles.js           ← Lootable title pools by rarity
  phrases.js               ← Tsundere auto-comment phrase list
models/
  User.js                  ← Core player document schema
  Auction.js               ← Slave auction state
  Election.js              ← Multi-step election state machine
  Loan.js                  ← Peer-to-peer loan records
  MarketListing.js         ← Player marketplace listings
  ServerStats.js           ← Per-guild weekly goal & tax tracking
utils/
  cloudinary.js            ← Image upload helper
  database.js              ← MongoDB connection bootstrapper
  gacha.js                 ← Gacha roll engine & drop tables
  helpers.js               ← Shared utility functions
  income.js                ← Central coin distribution pipeline
  mangaCache.js            ← Jikan API manga cache for Higher/Lower
  roleSync.js              ← Discord role ↔ DB state synchroniser
commands/
  battle.js                ← Duel system, guess-the-character
  economy.js               ← All economy commands (shop, gacha, loans, slavery, vault, etc.)
  election.js              ← Server mod election system
  guessOp.js               ← Anime OP/ED audio guessing game
  higherLower.js           ← Higher/Lower manga score game
  leaderboard.js           ← All leaderboard views
  market.js                ← Player-to-player marketplace
  trade.js                 ← Real-time item trading between users
  utility.js               ← Help menu, goal tracking, stats, server reset
Dockerfile
package.json
```

---

## 5. CONFIG.JS — ALL CONSTANTS

**Location:** `config.js` — imported as `const config = require('./config')` by all files.

```js
OWNER_ID: '409234534392004608'   // Only this Discord ID can use owner commands

CHANNELS: {
  MAIN: 'tsun',
  ALT: 'tsun-alt',
  GENERAL: 'general',
  ASYLUM: 'asylum'
}

ROLES: {
  ASYLUM: 'locked in asylum',
  MOD: 'fatso',
  DUEL_LORD: 'Duel Lord',
  SUGAR_DADDY: 'Sugar Daddy',
  GAMBLING: 'Gambling',
  PRESTIGE: ['Iron', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Master']
}

MAL_CLIENT_ID: '6133714cf92c8861fb454109d51a9fb4'   // MyAnimeList API

TIMING: {
  DUEL_COOLDOWN: 3600000,       // 1 hour per opponent
  ASYLUM_DURATION: 43200000,    // 12 hours
  CURSE_DURATION: 86400000,     // 24 hours
  TRADE_TIMEOUT: 180000,        // 3 minutes
  AUCTION_DURATION: 86400000,   // 24 hours
  MARKET_EXPIRY: 604800000,     // 7 days
  COIN_BAG_MIN: 20,             // Min messages before a coin bag drops
  COIN_BAG_MAX: 30,             // Max messages before a coin bag drops
  GUESS_TRIGGER: 220,           // Messages in #general to auto-start !guess
  PHRASE_TRIGGER: 150           // Messages in #general before tsundere auto-comment
}

ECONOMY: {
  DEFAULT_COINS: 200,
  DEFAULT_ELO: 1000,
  WEEKLY_GOAL: 10000000,            // 10M server-wide coin target
  BASE_WALLET_CAP: 5000000,         // 5M base wallet cap
  WALLET_CAP_PER_LEVEL: 20000000,   // +20M wallet cap per prestige level
  SLAVE_TAX_RATE: 0.40,             // 40% of slave's income → master
  LOAN_REPAY_RATE: 0.20,            // 20% of income → loan repayment
  MARKET_FEE_RATE: 0.05,            // 5% market sale fee (burned)
  BOUNTY_TAX_RATE: 0.20,            // 20% bounty placement fee (burned)
  AUCTION_FEE_RATE: 0.05,           // 5% auction fee (burned), 95% to seller
  MIN_BOUNTY: 1000,
  MIN_BET: 10,
  PRESTIGE_MULTIPLIERS: [0, 0.05, 0.1, 0.3, 0.5, 1, 1.2, 1.5],
  // Index = prestige level. Level 0 = 0% bonus, Level 7 (Master) = +150% bonus
  PRESTIGE_COSTS: [200000, 400000, 600000, 1000000, 1600000, 2600000, 4200000]
  // Cost to reach levels 1–7
}

AMULET_TIERS: {
  BASE: 1.5,         // 1 amulet = 1.5x multiplier
  TIER1_RATE: 0.75,  // Amulets 2–10: +0.75x each
  TIER2_RATE: 0.70,  // Amulets 11–30: +0.70x each
  TIER3_RATE: 0.60,  // Amulets 31–50: +0.60x each
  MAX_STACK: 50
}

DUPLICATE_FALLBACK: {  // Coins given when gacha title is a duplicate
  COMMON: 2500,
  RARE: 5000,
  LEGENDARY: 15000,
  ULTRA_RARE: 35000,
  MYTHIC: 75000
}

SHOP_PRICES: {
  'Coin Amulet': 1000,
  'Elo Shield': 40000,
  'Trash Curse': 40000,
  'Asylum Key': 1000000,
  'Slave Tag Remover': 10000,
  'Slave Freedom Ticket': 50000,
  TITLE_PRICE: 50000,        // Custom shop titles
  RANDOM_FRAME: 2000         // Random frame color roll
}

GACHA_MIN_PRICES: {  // Minimum listing price on market for gacha titles
  COMMON: 8000,
  RARE: 25000,
  LEGENDARY: 75000,
  ULTRA_RARE: 200000,
  MYTHIC: 500000
}

GACHA_BOX_PRICES: {
  bronze: 5000,
  silver: 25000,
  gold: 100000
}

ITEMS: {
  NON_TITLE: ['Coin Amulet', 'Elo Shield', 'Asylum Key', 'Trash Curse', 'Slave Freedom Ticket', 'Whip', 'Slave Tag Remover'],
  STACKABLE: ['Coin Amulet', 'Elo Shield', 'Asylum Key', 'Trash Curse', 'Slave Freedom Ticket'],
  FRAME_COLORS: ['Red', 'Blue', 'Green', 'Purple', 'Gold', 'Pink', 'Orange', 'Cyan'],
  SHOP_TITLES: [
    "Onee-San's Fucktoy", "2d > 3d", "Lewd Handholding", "Cutiepie", "IDF Soldier",
    "Seinen Addict", "Ntr Enjoyer", "Ugly Bastard", "Facing Allegations", "Certified Gambler"
  ]
}

GAMBLING_COMMANDS: ['!toss', '!slots', '!rr', '!roulette', '!bounty', '!wanted', '!duel', '!duels', '!guess']
// These commands are channel-restricted to #tsun or #tsun-alt only

ELECTION: {
  STEP1_HOURS: 1,
  STEP2_HOURS: 1,
  APPLY_MINS: 30,
  FINAL_HOURS: 1
}

ROULETTE: {
  1: { mult: 1.05, time: 60 },      // 5% profit, 1 min timeout on loss
  2: { mult: 1.25, time: 300 },     // 25% profit, 5 min timeout
  3: { mult: 1.75, time: 600 },     // 75% profit, 10 min timeout
  4: { mult: 2.50, time: 3600 },    // 150% profit, 1 hour timeout
  5: { mult: 5.00, time: 21600 }    // 400% profit, 6 hour timeout
}

VAULT: {
  INTEREST_RATE: 0.02,                   // 2% daily interest
  WITHDRAWAL_LIMIT: 0.10,                // Max 10% of vault per 24h withdrawal
  BASE_CAPACITY: 5000000,                // 5M base vault cap
  PRESTIGE_CAPACITY_MULTIPLIER: 5000000  // +5M capacity per prestige level
}

GUESS_REWARDS: [  // Coin reward per correct guess, scaled by user wealth
  { threshold: 10000,   reward: 100 },
  { threshold: 50000,   reward: 200 },
  { threshold: 100000,  reward: 500 },
  { threshold: 500000,  reward: 2000 },
  { threshold: 1000000, reward: 8000 },
  { threshold: 5000000, reward: 20000 },
  { threshold: Infinity, reward: 30000 }
]
```

---

## 6. CONFIG/GACHATITLES.JS

All strings are the exact title names stored in `user.inventory` and `user.equippedTitle`.

```js
GACHA_TITLES = {
  COMMON: [
    "Cooked",
    "It's So Over",
    "Panel Sniffer",
    "Retarded ass mf",
    "Shonen Tard",
    "Casual",
    "Tepid",
  ],
  RARE: [
    "Unironically Him",
    "Lobotomy Survivor",
    "Certified Crashout",
    "It is what it is",
    "Genre Bender",
    "The Enlightened",
    "Kawaii",
  ],
  LEGENDARY: [
    "Aura Merchant",
    "The Usogui",
    "Inkbound",
    "Everyone's Onii-chan",
  ],
  ULTRA_RARE: [
    "We Are So Back",
    "He Who Ends Debates",
    "The Thinker",
    "The One Above Panels",
    "Femboy",
  ],
  MYTHIC: [
    "Embodiment of Peak Fiction",
    "The Unwritten Ending",
    "The One Above Heaven",
    "God's Mistake",
    "GOD",
  ],
};
```

**Rarity colors (used in roleSync and battle canvas):**

- COMMON = `#FFFFFF` (white)
- RARE = `#00BFFF` (deep sky blue)
- LEGENDARY = `#FFD700` (gold)
- ULTRA_RARE = `#9B30FF` (purple)
- MYTHIC = `#FF0000` (red)
- SHOP titles = `#00FF00` (green)

---

## 7. CONFIG/PHRASES.JS

43 tsundere auto-comment strings. Posted in `#general` every 150 messages (`PHRASE_TRIGGER`).
Placeholders replaced at runtime:

- `{{user}}` → replaced with a random top-5 daily chatter's display name
- `{{user1}}`, `{{user2}}` → two different top chatters

The replacement logic is in `postRandomPhrase()` in `index.js`.

---

## 8. MONGODB MODELS

### `models/User.js` — Primary user document

```
userId            String, required, unique     Discord user ID (primary key)
elo               Number, default 1000, min 0  PvP rating
wins              Number, default 0
losses            Number, default 0
gridUrl           String, null                 Cloudinary URL of custom duel image
coins             Number, default 200, min 0   Wallet balance
bounty            Number, default 0            Bounty on their head
activeBounties    [{placerId, amount}]          Who placed the bounty and how much
inventory         [String]                     Item names (titles, equipment, frames)
strippedRoles     [String]                     Role names removed during punishment
prestige          Number, default 0            0–7 (0=none, 1=Iron ... 7=Master)
gachaBoxesOpened  Number, default 0
gachaTotalSpent   Number, default 0
bestGachaDrop     String, null                 'COMMON'|'RARE'|'LEGENDARY'|'ULTRA_RARE'|'MYTHIC'
gachaPityCounter  Number, default 0            Boxes since last pity trigger
lastHourly        Number, default 0            Timestamp of last !free claim
lastActiveTime    Number, default 0            Timestamp of last message sent
isSlave           Boolean, default false
slaveOwner        String, null                 Discord user ID of master
slaveIncomeGenerated     Number, default 0     Total coins generated while enslaved
masterIncomeFromSlaves   Number, default 0     Total coins earned from owning slaves
equippedTitle     String, null                 Currently displayed title
frameColor        String, null                 Duel card frame color
equippedShield    Boolean, default false       Elo Shield active
equippedAmuletCount Number, default 0          Stacked amulets (0–50)
trashTasteExpiry  Number, default 0            Timestamp when Trash Curse expires
asylumExpiry      Number, default 0            Timestamp when asylum ends
botBanExpiry      Number, default 0            Timestamp when bot ban ends
forcedNickname    String, null                 Owner-forced nickname (cannot be changed)
guessWinStreak    Number, default 0            Consecutive !guess wins
guessTimeoutExpiry Number, default 0           Guess game cooldown
highScore         Number, default 0            Higher/Lower best streak
opGuessStreak     Number, default 0            OP guess current streak
opHighestStreak   Number, default 0            OP guess all-time best
edGuessStreak     Number, default 0            ED guess current streak
edHighestStreak   Number, default 0            ED guess all-time best
merchantPrices    Map<String,Number>           Item → rolled sell price
merchantLastRefresh Number, default 0          Last merchant refresh timestamp
merchantDailySold Number, default 0            Coins earned today selling to merchant
merchantFreeRefreshUsed Boolean, default false
vaultCoins        Number, default 0, min 0
vaultDailyWithdrawn Number, default 0
lastVaultInterest Number, default 0
stats.daily: {
  messages         Number    Reset every 24h
  characters       Number
  reactionsGiven   Number
  reactionsReceived Number
}
stats.allTime: {
  messages         Number    Never reset
  characters       Number
  reactionsGiven   Number
  reactionsReceived Number
  channels         Map<channelId, messageCount>
}
```

### `models/Auction.js`

```
auctionId       String, required, unique
slaveId         String, required           Discord ID of the user being sold
sellerId        String, required
currentBid      Number, default 0
currentBidder   String, null
minimumBid      Number, required
endTime         Number, required           Unix timestamp
active          Boolean, default true
guildId         String, required
createdAt       Number, default Date.now
```

Index: `{ active: 1, endTime: 1 }` for background sweeper.

### `models/Election.js`

```
guildId         String, required, unique
active          Boolean, default false
step            Number, default 0        0=Idle, 1=YesNo, 2=Remove, 3=Apply, 4=Tournament
channelId       String
messageId       String
candidates      [{userId, displayName, speech, index}]     New mod applicants
modCandidates   [{index, userId, displayName}]             Existing mods at risk
endTime         Number
processing      Boolean, default false   Mutex flag
tournamentRound         Number, default 0
currentBracketIndex     Number, default 0
tournamentBrackets      [{bracketIndex, messageId, winnerUserId, candidates:[{userId,displayName,index}]}]
```

### `models/Loan.js`

```
lenderId        String, required
borrowerId      String, required
initialAmount   Number, required
remainingAmount Number, required
interestRate    Number, required         1–20 (percent)
totalRepayment  Number, required         initialAmount * (1 + interestRate/100)
dueDate         Number, required         Unix timestamp
status          String, enum ['ACTIVE','PAID','DEFAULTED'], default 'ACTIVE'
```

Indexes: `{borrowerId,status}`, `{lenderId,status}`, `{status,dueDate}`.

### `models/MarketListing.js`

```
listingId   String, required, unique
sellerId    String, required
itemName    String, required
price       Number, required
createdAt   Date, default Date.now
expiresAt   Date, required              createdAt + 7 days
views       Number, default 0
```

Indexes: `{expiresAt}`, `{sellerId}`.

### `models/ServerStats.js`

```
guildId              String, required, unique
weeklyCoinCount      Number, default 0         Progress toward goal
weeklyGoal           Number, default 10000000  10M default
weeklyReward         String, default 'No reward set'
weeklyRewardAmount   Number, default 5000
lastReset            Number, default Date.now
weeklyClaimers       [String]                  UserIds who claimed this week
lastDailyTax         Number, default 0         Timestamp of last tax run
lastWeeklyReset      Number, default 0
```

---

## 9. UTILS

### `utils/database.js`

**`connectDB()`**
Connects Mongoose to `process.env.MONGO_URI`. Sets `strictQuery: false`. Calls `process.exit(1)` on failure. Called once in `client.once('ready')`.

---

### `utils/cloudinary.js`

**`uploadImage(filePath, userId)`** → `Promise<string>`
Uploads a local file to Cloudinary at path `user_grids/{userId}` with `overwrite: true`.
Server-side transformation: max 800×800, `quality: auto`, `fetch_format: auto`.
Returns the `secure_url` CDN string. Throws on failure.

---

### `utils/helpers.js`

**`getDisplayName(userId, guild)`** → `Promise<string>`
Fetches `guild.members.fetch(userId)` and returns `member.displayName`.
Falls back to `User#XXXX` (last 4 of userId) on error.

**`safeRoleOperation(operation, fallbackMessage)`** → `Promise<boolean>`
Wraps an async role mutation in try/catch. Returns `true`/`false`.

**`safeCoinOperation(operation, user, amount)`** → `Promise<{success, error}>`
Wraps an async coin mutation. On failure, attempts rollback by setting `user.coins` back to `originalCoins`.

**`createCleaningMap(maxAge=3600000, cleanupInterval=1800000)`** → `Map`
Returns a `Map` where `.set(key, value)` stores `{value, timestamp}` internally.
A `setInterval` runs every `cleanupInterval` ms and deletes entries older than `maxAge`.
Used for duel cooldowns in `battle.js` to prevent memory leaks.

**`getAmuletMultiplier(count)`** → `number`
Computes the coin multiplier for stacked Coin Amulets.

- 0 amulets → 1.0
- 1 amulet → 1.5 (BASE)
- 2–10 amulets → BASE + (n-1) × 0.75
- 11–30 → extends with 0.70 per amulet
- 31–50 → extends with 0.60 per amulet
  Max stack: 50 amulets.

**`titleCase(str)`** → `string`
Converts string to Title Case.

---

### `utils/gacha.js`

**Drop Tables (probability %):**

| Drop Type        | Bronze | Silver | Gold |
| ---------------- | ------ | ------ | ---- |
| coins            | 40     | 35     | 30   |
| common_title     | 30     | 10     | 5    |
| amulet           | 15     | 20     | 10   |
| shield           | 10     | 10     | 8    |
| rare_title       | 4      | 20     | 10   |
| freedom_ticket   | 0.8    | 3      | 6    |
| legendary_title  | 0.2    | 1.8    | 25   |
| ultra_rare_title | —      | 0.2    | 5    |
| mythic_title     | —      | —      | 1    |

**Coin reward ranges per tier:**

- Bronze: 2,500–7,500
- Silver: 15,000–40,000
- Gold: 60,000–150,000

**`rollGacha(tier, isPity)`** → `{type, item, rarity, value}`
Normal: rolls 0–100 against cumulative drop table.
Pity: filters out `common` and `coins` drops, re-normalises probabilities, forces Rare+.

**`executeDropResult(dropType, tier)`** → `{type, item, rarity, value}`
Translates drop type string into a concrete result. For titles, picks a random string from `GACHA_TITLES[rarity]`.

**`isRarityBetter(currentBest, newRarity)`** → `boolean`
Compares against `RARITY_ORDER = ['COMMON','RARE','LEGENDARY','ULTRA_RARE','MYTHIC']`.

---

### `utils/income.js`

**`distributeIncome(userId, baseAmount)`** → `Promise<string>`

The **central payment function**. All coin grants in the entire bot flow through this. Returns a log string of all deductions/bonuses applied.

**Pipeline (applied in strict order):**

1. **Rich Tax** (on base amount, burned):
   - `coins > 1,000,000` → 50% tax on base
   - `coins > 100,000` → 20% tax on base
2. **Prestige Bonus** (tax-free, added after tax):
   - `bonus = baseAmount × PRESTIGE_MULTIPLIERS[prestige]`
3. `netIncome = baseAmount - richTax + bonus`
4. **Slave Tax** (if `user.isSlave`): 40% of netIncome → transferred to `slaveOwner`'s coins directly
5. **Loan Repayment** (if active/defaulted loan exists): 20% of remaining netIncome → lender. Marks loan PAID if `remainingAmount` reaches 0.
6. **Wallet Cap**: `BASE_WALLET_CAP + (prestige × WALLET_CAP_PER_LEVEL)`. Overflow is lost (logged to user).
7. **ServerStats** increment: `weeklyCoinCount += totalAmount`

Returns a multi-line log string like:

```
🌟 **Prestige Bonus:** +X Coins
⛓️ **Slave Tax:** -X Coins (to Master)
💸 **Loan Repay:** -X Coins
🔥 **Rich Tax:** -X Coins (Burned for being too rich)
🛑 **Wallet Full:** X coins vanished!
```

---

### `utils/mangaCache.js`

In-memory cache of top manga from Jikan API (MyAnimeList). Used by `higherLower.js`.

**`init()`**
Calls `fetchTopManga()` immediately, then sets a 24-hour refresh interval.

**`fetchTopManga()`**
Fetches 12 pages from `https://api.jikan.moe/v4/top/manga?page={n}&filter=bypopularity&type=manga`.
1,500ms delay between pages. Retries on HTTP 429. Skips 5xx errors.
Validates: `score` must be a non-null number, image URL must exist, title must exist.
Stores: `{id, title, score, image, rank, popularity}`.
Requires ≥50 items to consider cache valid. Retries after 5 minutes if insufficient.

**`getMangaPair(currentManga=null)`** → `[manga, manga] | null`

- `null` input → picks 2 random distinct manga from cache (new game)
- `currentManga` provided → keeps it as left side, picks new random challenger (streak continuation)
  Returns `null` if cache has <10 items.

**`isReady()`** → `boolean`
Returns `true` if cache is initialised and has >10 items.

---

### `utils/roleSync.js`

Manages the Discord role ↔ MongoDB state relationship.

**`ensureAllRoles(guild)`**
Creates all missing title roles (from `GACHA_TITLES` + `SHOP_TITLES`) and prestige roles (`PRESTIGE_ROLES`).
Role colors match rarity. Requires `ManageRoles` bot permission.

**`syncUserTitleRole(guild, userId, newTitleName, oldTitleName)`**
Removes `oldTitleName` role from member, adds `newTitleName` role.

**`syncAllUserTitleRoles(guild)`**
Bulk-heals all users with an `equippedTitle` in DB. Processes in chunks of 50. Adds missing roles.

**`syncPrestigeRole(guild, userId, level)`**
Maps level (1=Iron, 2=Bronze, ... 7=Master) to the correct prestige role.
Removes all other prestige roles. Adds the correct one.

**`syncAllUserPrestigeRoles(guild)`**
Bulk prestige sync for all users with `prestige > 0`. Chunks of 50.

**`stripPrivilegedRoles(guild, userId)`**
Removes `['Owner', 'fatso']` roles from user if present.
Saves removed role names to `user.strippedRoles` in DB before removing from Discord.

**`restorePrivilegedRoles(guild, userId)`**
Reads `user.strippedRoles` from DB. Re-adds each role to the member. Clears `strippedRoles`.

**`getTitleRarity(titleName)`** → `'MYTHIC'|'ULTRA_RARE'|'LEGENDARY'|'RARE'|'COMMON'|'SHOP'`
Used internally to determine role color.

---

## 10. INDEX.JS — ENTRY POINT

### Startup sequence (`client.once('ready')`)

1. Calls `connectDB()`
2. Sets presence: `Watching "judging your taste"`
3. For each guild: `roleSync.ensureAllRoles()`, `syncAllUserTitleRoles()`, `syncAllUserPrestigeRoles()`
4. `mangaCache.init()`
5. Registers all background timers (see §22)

### Helper functions in `index.js`

**`dropCoinBag(channel)`**
Sends an embed with a "Grab Coins" button. 30-second collector.
First user to click wins 30–50 random coins via `distributeIncome()`.
If nobody clicks: edits message to tsundere salty message.
Triggered every 20–30 messages in `#tsun` or `#tsun-alt`.

**`postRandomPhrase(channel, guild)`**
Picks a random phrase from `config/phrases.js`.
Replaces `{{user}}` with a random top-5 daily chatter name.
Replaces `{{user1}}` and `{{user2}}` with two different shuffled top chatters.
Triggered every 150 messages in `#general`.

### `messageCreate` event handler

1. Skip if `message.author.bot`
2. `utilitySystem.trackMessage(message)` — always, even before ban check
3. If channel is `#asylum` → silent return
4. If command starts with `!` → check `botBanExpiry`. If banned, reply with remaining time and return.
5. Count messages in `#tsun`/`#tsun-alt` → trigger `dropCoinBag()` when count hits random target (20–30)
6. Count messages in `#general`:
   - Every 220 messages → `battleSystem.startGuessGame(message)`
   - Every 150 messages → `postRandomPhrase()`
7. Check if command is in `GAMBLING_COMMANDS` → require `#tsun` or `#tsun-alt`
8. Route commands:

| Command                                                                                                                                                                                                  | Handler                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `!giveaway`                                                                                                                                                                                              | `index.js` inline (owner only) |
| `!ban`                                                                                                                                                                                                   | `index.js` inline (owner only) |
| `!rename`                                                                                                                                                                                                | `index.js` inline (owner only) |
| `!removerename`                                                                                                                                                                                          | `index.js` inline (owner only) |
| `!guess opening/ending`                                                                                                                                                                                  | `guessOpSystem.handle()`       |
| `!guess` (other)                                                                                                                                                                                         | `battleSystem.handle()`        |
| `!duel*`                                                                                                                                                                                                 | `battleSystem.handle()`        |
| `!higherlower` / `!hl`                                                                                                                                                                                   | `higherLowerSystem.handle()`   |
| `!shop`, `!free`, `!bag`, `!inventory`, `!equip`, `!curse`, `!lock`, `!toss`, `!slots`, `!loan`, `!rr`, `!roulette`, `!tax`, `!bounty`, `!wanted`, `!isekai`, `!gacha`, `!freedom`, `!auction`, `!vault` | `economySystem.handle()`       |
| `!startelection`, `!cancelelection`, `!endelection`, `!electionstatus`, `!electioncandidates`, `!endpoll`, `!endapplications`                                                                            | `electionSystem.handle()`      |
| `!help`, `!goal`, `!claimweekly`, `!resetserver`                                                                                                                                                         | `utilitySystem.handle()`       |
| `!leaderboard op/ed` / `!lb op/ed`                                                                                                                                                                       | `guessOpSystem.handle()`       |
| `!leaderboard` / `!lb`                                                                                                                                                                                   | `leaderboardSystem.handle()`   |
| `!trade`                                                                                                                                                                                                 | `tradeSystem.handle()`         |
| `!market`                                                                                                                                                                                                | `marketSystem.handle()`        |

### Owner-only inline commands

**`!giveaway @user/role [amount]`**

- Role mention → distributes `amount` coins to every non-bot member with that role
- User mention → gives `amount` coins to one user
- Uses `distributeIncome()` for each recipient

**`!ban @user [hours]`**

- No hours or hours=0 → unban (clears `botBanExpiry`)
- Hours 0.1–168 → sets `botBanExpiry = Date.now() + hours*3600000`
- Also clears `gridUrl` on ban

**`!rename @user [NewName]`**

- No name or "clear" → clears `forcedNickname`
- Name provided → sets `forcedNickname`, immediately applies to Discord nickname

**`!removerename @user`**

- Clears `forcedNickname` field

### `messageReactionAdd` event

Calls `utilitySystem.trackReaction(user.id, reaction.message.author.id)`.

### `interactionCreate` event

Routes all button/modal/select interactions to all subsystems in sequence:
`battleSystem → economySystem → electionSystem → utilitySystem → tradeSystem → marketSystem`

### `guildMemberUpdate` event — Nickname Enforcer

Fires when a member's nickname changes.
**Priority 1 (Forced Rename):** If `user.forcedNickname` set and new name differs → revert + public callout in `#tsun`/`#tsun-alt`.
**Priority 2 (Slave Nickname):** If `user.isSlave` and new name doesn't end with ` ({ownerName}'s Slave)` → revert to compliant name + public "REBELLION SUPPRESSED" callout.

---

## 11. COMMANDS/BATTLE.JS

### State variables (module-level)

```js
activeBattles: Set<guildId>         // Guilds with an active duel
activeGuessGames: Set<channelId>    // Channels with an active guess game
activeBets: Map<guildId, [{userId, targetId, amount}]>
currentFighters: Map<guildId, [p1Id, p2Id]>
cooldowns: CleaningMap              // Key: `${p1Id}_${p2Id}`, value: timestamp
```

### Exported functions

**`handle(message, client)`**
Routes `!guess` → `startGuessGame()`.
Routes `!duel stats @user` → `showSelfStats()`.
Routes `!duel` with attachment → `handleImageUpload()`.
Routes `!duel random` → `startRandomDuel()` (with async-lock per guild).
Routes `!duel @user` → `startDuel()` (with async-lock per guild).
Routes `!duel` alone → `showSelfStats()`.

**`handleInteraction(interaction, client)`**
Handles:

- `bet_menu_open` → shows fighter selection buttons (ephemeral)
- `bet_select_{userId}` → opens bet amount modal
- `bet_confirm_{userId}` (modal) → validates amount, deducts coins, adds to `activeBets`
- `vote_p1` / `vote_p2` → duel resolution (see below)

**`resetCooldowns(userId)`** (exported)
Removes all cooldown entries containing `userId`.

**`startGuessGame(message)`** (exported — also called from `index.js`)
Fetches a random character image (from anime/manga).
Posts image embed with "Reveal Answer" button.
30-second message collector. Users type the character name in chat.
Correct answer: awards coins from `GUESS_REWARDS` based on user's current coins.
Also awards streak bonus. On timeout: reveals answer.

### Internal functions

**`handleImageUpload(message)`**
Downloads the attached image → saves temp file → calls `uploadImage()` → saves URL to `user.gridUrl`.

**`startDuel(message, p1User, p2User)`**

- Validates: not self, not bot, not same active battle, cooldown check
- Fetches both users' DB records and Discord avatars
- Calls `generateBattleCanvas()` to render the duel image
- Posts image embed with "Vote P1" / "Vote P2" / "💰 Bet" buttons
- 60-second collector
- On vote resolution: calculates ELO change, distributes winnings via `distributeIncome()`, checks Elo Shield (prevents loss if equipped, consumes it), bounty payout, Trash Curse check (asylum if loser had curse active), calls `updateLeaderRole()`

**`startRandomDuel(message, client)`**
Picks a random online guild member (not self, not bot, not currently in battle) → calls `startDuel()`.

**`showSelfStats(message, targetUser=null)`**
Shows embed with: ELO, wins/losses, rank, prestige, equipped title, frame, amulet count, guess streak.

**`updateLeaderRole(guild, channel)`**
Finds user with highest ELO → assigns "Duel Lord" role → removes it from everyone else.

**`getTitleColor(title)`** → `string` (hex color)
Checks SHOP_TITLES → Gacha tiers by rarity → returns hex color string.

**`generateBattleCanvas(p1Data, p2Data)`** (Canvas rendering)
Creates 1200×600 image. Draws side-by-side fighter panels with avatar, stats, title text, ELO, frame border overlay in their equipped frame color.

---

## 12. COMMANDS/ECONOMY.JS

All commands handled via `handle(message, client)`. User document fetched/created at top of every call.

### Commands

**`!isekai`** — Prestige System

- Checks: no active loan, not a slave
- Calculates max reachable prestige level from current coins (iterates `PRESTIGE_COSTS`)
- Burns coins + fires confirmation embed with "Truck-kun" theme
- On confirm: resets coins to 0, increments prestige, awards prestige role via `roleSync.syncPrestigeRole()`
- Burns remaining coins ("change") after paying level costs

**`!bounty @user [amount]`** / **`!wanted @user [amount]`**

- Places a bounty on target user (min 1,000)
- 20% fee burned (`BOUNTY_TAX_RATE`)
- Remaining added to `target.activeBounties[]`
- Bounties are collected when target loses a duel

**`!roulette [bullets]`** / **`!rr [bullets]`**

- Bullets 1–5, corresponds to `config.ROULETTE[bullets]`
- User bets their entire wallet (no amount input)
- Win: coins × `mult` via `distributeIncome()`
- Lose: Discord timeout for `time` seconds, coins lost

**`!tax`**

- Displays current rich tax brackets and rates

**`!free`**

- Cooldown: 1h (coins <100k), 4h (coins 100k–1M), 12h (coins >1M)
- Reward: `Math.max(80, Math.floor(user.coins * 0.001))`
- Paid via `distributeIncome()`

**`!bag`** / **`!inventory`**

- Paginated embed showing all items grouped by type, counts, equipped status
- Shows prestige, bounty, slave status, vault balance

**`!shop`**

- Category selector (StringSelectMenu): Equipment, Titles, Frames, Shady Merchant
- Equipment: Coin Amulet (1k), Elo Shield (40k), Trash Curse (40k), Asylum Key (1M), Slave Tag Remover (10k), Slave Freedom Ticket (50k)
- Titles: 10 custom shop titles (50k each)
- Frames: Random frame color roll (2k)
- Shady Merchant: User can sell items from inventory at randomised daily prices

**`!equip [item]`**

- Equip/unequip titles, frame colors, amulets (choose 0–50 count via modal), shields
- Triggers `roleSync.syncUserTitleRole()` for title changes

**`!curse @user`**

- Uses one "Trash Curse" item from inventory
- Sets `target.trashTasteExpiry = Date.now() + 86400000` (24h)
- If target loses a duel while cursed → sent to #asylum

**`!lock @user`**

- Uses one "Asylum Key" item
- Sets `target.asylumExpiry = Date.now() + 43200000` (12h)
- Adds "locked in asylum" role to target

**`!toss [heads/tails] [amount]`**

- Coin flip. Win: +amount via `distributeIncome()`. Lose: -amount.

**`!slots [amount]`**

- Amount: 10–100,000
- Symbols: `['❤️‍🩹', '✌️', '🔥', '🥀', '❤️‍🩹', '💔', '🙏']`
- Three-reel spin with animated edits
- All 3 match `🙏` → 10x. All 3 match `🔥` → 5x. All 3 match (other) → 3x. 2 match → 1.5x. No match → 0x (lose bet)
- Rich users (>100k) have lower jackpot odds (0.5% vs 2%)
- Amulet multiplier applied to winnings via `getAmuletMultiplier()`

**`!gacha [bronze/silver/gold]`**

- Deducts box price from coins
- Rolls via `gacha.rollGacha(tier, isPity)`
- Pity: triggers every 10 boxes (`gachaPityCounter`)
- Duplicate title → fallback coins from `DUPLICATE_FALLBACK`
- Updates `bestGachaDrop` if new rarity is better

**`!freedom`**

- Uses "Slave Freedom Ticket" item → clears `isSlave`, `slaveOwner`, removes slave suffix from nickname
- Or uses "Slave Tag Remover" → each use forgives 5% of remaining loan debt (costs 10k)
- Calls `roleSync.restorePrivilegedRoles()` on freedom

**`!auction [list/bid/cancel]`**

- `!auction list [minimumBid]` → creates 24h auction for the user's slave. User must own a slave.
- `!auction bid [auctionId] [amount]` → places bid if amount > currentBid. Refunds previous bidder.
- `!auction cancel` → owner cancels their auction (refunds bidder)
- Auction resolution handled by background timer in `index.js`

**`!loan [lend/borrow/status/repay]`**

- `!loan lend @user [amount] [interest%] [days]` → creates loan offer to target
- Target accepts/declines via button interaction
- `!loan status` → shows active loans (as lender and borrower)
- `!loan repay` → manually pays off portion of loan using wallet
- Default (missed dueDate) → handled by background timer in `index.js` → sets `isSlave: true`, strips roles, shames nickname

**`!vault [deposit/withdraw/status]`**

- Deposit: moves coins from wallet to vault (subject to vault capacity)
- Withdraw: moves coins from vault to wallet (subject to 10% daily limit)
- Status: shows vault balance, capacity, pending interest, withdrawal remaining
- Interest: 2% daily, only for users who sent a message in the last 24h

### `handleInteraction(interaction, client)` in economy.js

Handles all economy-related interaction IDs (see §20).

### Exported function

**`checkAndApplyDailyTax(client)`**
Called every 1 minute from `index.js`. Checks if 24h has elapsed since `ServerStats.lastDailyTax`.
If yes:

1. Finds all users with `coins > 100000`
2. Applies tiered tax (20% for 100k–1M, 50% for >1M)
3. Deducts tax from wallet
4. Updates `ServerStats.weeklyCoinCount`
5. Posts announcement in `#tsun` or `#tsun-alt`

---

## 13. COMMANDS/ELECTION.JS

### Commands (all owner-only)

**`!startelection`** → starts Step 1 (Yes/No poll: "Should we hold a mod election?")
**`!cancelelection`** → cancels active election, resets to Step 0
**`!endelection`** → force-ends current step and advances
**`!electionstatus`** → shows current election step and time remaining
**`!electioncandidates`** → lists current applicants
**`!endpoll`** → force-ends current active Discord poll
**`!endapplications`** → closes application phase early

### Election Steps

| Step | Function              | Duration       | Action                                                                |
| ---- | --------------------- | -------------- | --------------------------------------------------------------------- |
| 0    | Idle                  | —              | No election                                                           |
| 1    | `startStep1()`        | 1h             | Yes/No Discord poll: hold election?                                   |
| 2    | `startStep2()`        | 1h             | Vote to remove existing mods. Most voted mod loses `config.ROLES.MOD` |
| 3    | `startApplications()` | 30min          | Users click "Apply" button → `mod_speech_modal` → submit speech       |
| 4    | `startFinalVote()`    | 1h per bracket | Tournament: head-to-head Discord polls. Winner gets mod role          |

### Internal functions

**`checkTimers(client)`** (exported, called every 1 min from `index.js`)
Checks `election.endTime` against `Date.now()`. If expired, advances to next step.

**`sendNextBracketPoll(election, channel, client)`**
Sends the next bracket matchup as a Discord poll. Handles byes for odd candidate counts. Increments `currentBracketIndex`.

**`endPollSafely(poll, maxRetries=3)`**
Retries `poll.end()` with rate limit handling. Returns `true/false`.

**`handleInteraction(interaction, client)`** (exported)

- `apply_mod` button → shows `mod_speech_modal`
- `mod_speech_modal` submit → saves candidate to `election.candidates`
- Election poll results → determined automatically when poll ends

---

## 14. COMMANDS/GUESSOP.JS

### Commands

**`!guess opening`** / **`!guess openings`** → anime OP guessing
**`!guess ending`** / **`!guess endings`** → anime ED guessing
**`!leaderboard op`** / **`!lb op`** → top OP guess streaks
**`!leaderboard ed`** / **`!lb ed`** → top ED guess streaks

### Data flow

1. `fetchTopAnime()` → AniList GraphQL API → caches top 500 anime by popularity (in-memory `topAnimeCache`)
2. `fetchAnime(mode)` → picks random from top 500 → queries `https://api.animethemes.moe/anime?q={title}` for OP/ED video URLs
3. Downloads video via `axios` stream
4. `ffmpeg` trims a clip starting 15s in, duration based on difficulty:
   - easy: 8s, medium: 5s, hard: 3s, insane: 1s
5. Clip uploaded as Discord `AttachmentBuilder`
6. User types answer in chat; collector runs for `difficultyTime × 1000` ms
7. Answer matching: `normalizeTitle()` removes punctuation/season info, then `Fuse.js` fuzzy search (threshold 0.4) + Levenshtein distance check

### Streak & reward logic

- Correct answer → increments `opGuessStreak` or `edGuessStreak`, updates `opHighestStreak`/`edHighestStreak`
- Reward scales with streak (geometric compound)
- Wrong/timeout → resets streak, applies `guessTimeoutExpiry` cooldown

### Internal functions

**`normalizeTitle(t)`** → `string`
Removes punctuation, "season X", "part X", "cour X", "the", collapses spaces.

**`levenshtein(a, b)`** → `number`
Dynamic programming edit distance calculation.

**`fetchTopAnime()`** → `Array`
AniList GraphQL query: `Page(page:1, perPage:500) { media(sort:POPULARITY_DESC, type:ANIME) }`.
Cached in `topAnimeCache` module-level variable.

**`handle(message, client)`**
Routes OP/ED guessing and leaderboard subcommands.

---

## 15. COMMANDS/HIGHERLOWER.JS

### Command

**`!higherlower`** / **`!hl`** — channel restricted to `#tsun`/`#tsun-alt`

### Flow

1. Checks `mangaCache.isReady()`
2. Gets pair via `getMangaPair(null)` (new game)
3. Renders 800×400 Canvas image with both manga covers, titles, score hidden for right side
4. Posts image with "Higher 📈" / "Lower 📉" buttons and 45s collector
5. Correct: reveal score, update embed, `getMangaPair(winnerManga)` for next round
6. Wrong or timeout: game over, save `highScore` if beaten, award coins via `distributeIncome()`

### Internal functions

**`createGameCanvas(mangaA, mangaB, revealB=false)`** → `Canvas.Canvas`
800×400 canvas. Left panel = mangaA (always visible score). Right panel = mangaB (score hidden until `revealB=true`).
Draws: manga cover image, dark gradient overlay, title text with word-wrap, score text.

**Reward formula:**
`reward = Math.floor(baseReward × (1 + Math.log10(user.coins) / 2))`
Where `baseReward` scales with streak length. Paid via `distributeIncome()`.

**`handle(message, client)`**
Spawns game session. Uses `processing` flag to prevent double-clicks during canvas render.

---

## 16. COMMANDS/LEADERBOARD.JS

### Command: `!leaderboard [type] [subtype]` (Alias: `!lb`)

| Subcommand      | Description                         | Sort Field               |
| --------------- | ----------------------------------- | ------------------------ |
| `chats`         | Daily top chatters + reactions      | `stats.daily.messages`   |
| `chats alltime` | All-time message + reaction leaders | `stats.allTime.messages` |
| `coins`         | Richest + slave economy breakdown   | `coins` desc             |
| `elo`           | Top PvP ELO                         | `elo` desc               |
| `prestige`      | Highest prestige                    | `prestige` desc          |
| `guess`         | Best character guess streak         | `guessWinStreak` desc    |
| `hl`            | Higher/Lower best score             | `highScore` desc         |
| `op`            | Best OP guess streak                | `opHighestStreak` desc   |
| `ed`            | Best ED guess streak                | `edHighestStreak` desc   |

Top 10 results. Uses medal emojis 🥇🥈🥉 for top 3.

**`handle(message, client)`**
Single exported function. All leaderboard types handled inside with if/else chains.

---

## 17. COMMANDS/MARKET.JS

### Commands: `!market [subcommand]`

**`!market list`** / **`!market sell`**

- Dropdown of sellable inventory items (excludes equipped items)
- Modal to input price (minimum enforced by `getMinPrice()`)
- Max 5 active listings per user
- Creates `MarketListing` document with 7-day expiry

**`!market browse`** / **`!market`** (default)

- Paginated embed of all active listings
- Each page: 5 listings with item name, price, seller, time remaining
- Pagination via `market_page_{n}` buttons

**`!market buy [listingId]`**

- Deducts price from buyer's wallet
- 5% fee burned (`MARKET_FEE_RATE`)
- 95% to seller via `distributeIncome()`
- Transfers item from seller's to buyer's inventory
- Deletes `MarketListing` document

**`!market cancel [listingId]`**

- Seller cancels own listing
- Item returned to seller's inventory
- Listing deleted

### Internal functions

**`getMinPrice(itemName)`** → `number`

- Shop items: 40% of shop price
- Frame colors: 40% of 2,000 (800)
- Shop titles: 40% of 50,000 (20,000)
- Gacha titles: `GACHA_MIN_PRICES[rarity]`
- Unknown: 10,000

**`generateListingId()`** → `string`
`'M' + Math.random().toString(36).substr(2,5).toUpperCase()`

**`formatTimeRemaining(expiresAt)`** → `string`
Returns `"Xd Yh"` or `"Xh"` format.

**`checkExpiredListings(client)`** (exported, called hourly from `index.js`)
Finds listings past `expiresAt`. Returns each item to seller's inventory. Notifies in guild channel.

---

## 18. COMMANDS/TRADE.JS

### Command: `!trade @user`

### `TradeSession` class

```js
{
  id: `trade_{timestamp}_{random6}`;
  (initiatorId, targetId, channelId, messageId);
  initiatorOffer: []; // Array of item name strings
  targetOffer: [];
  initiatorConfirmed: false;
  targetConfirmed: false;
  status: "SELECTING"; // SELECTING | CONFIRMING | COUNTDOWN | COMPLETED | CANCELLED
  (createdAt, expiresAt); // expiresAt = createdAt + 180000 (3 min)
  (initiatorName, targetName);
}
```

State maps:

- `activeTrades: Map<tradeId, TradeSession>`
- `tradeTimers: Map<tradeId, intervalId>` — 10s polling intervals that auto-cancel expired sessions

### Trade UI flow

1. `!trade @user` → creates session, sends trade embed showing both empty offers
2. Each party clicks "Add Items" → category dropdown (Titles / Equipment / Special / Frames)
3. Select item from dropdown → if stackable, opens quantity modal
4. "Clear Offer" → removes all offered items
5. "Lock In" by both parties → status moves to CONFIRMING → 5-second countdown
6. "EMERGENCY CANCEL" button appears during countdown
7. If uncancelled: items swap between inventories atomically

### Value estimation

**`getItemValue(itemName)`** → `number`

- Shop items → `SHOP_PRICES[itemName]`
- Frame colors → `SHOP_PRICES.RANDOM_FRAME × 2`
- Gacha titles → `GACHA_MIN_PRICES[rarity]`
- Shop titles → `SHOP_PRICES.TITLE_PRICE`
- Default → 10,000

**`getItemRarity(itemName)`** → `string | null`
Checks all `GACHA_TITLES` tiers and `SHOP_TITLES`.

**Imbalance warning thresholds:**

- > 5x value difference → 🚨 RED warning
- > 3x → ⚠️ ORANGE warning
- > 2x → 💛 YELLOW warning

### Internal functions

**`handle(message, client)`** — main exported entry point
**`handleInteraction(interaction, client)`** — exported, handles all `trade_*` interaction IDs

---

## 19. COMMANDS/UTILITY.JS

### Commands

**`!resetserver confirm`** (owner only)

1. Deletes all `Loan`, `Auction`, `MarketListing` documents
2. Resets `ServerStats` (goal/reward/tax)
3. Bulk-writes all `User` documents:
   - `coins: 10000`, `bounty: 0`, `inventory: []`
   - `prestige: newPrestige` (was >0 → keeps as 1 / Iron; was 0 → stays 0)
   - Clears slavery, cosmetics, punishments, games, vault, merchant state
   - Preserves: `stats.daily`, `stats.allTime`, `elo`, `wins`, `losses`, `highScore`, streaks
4. Iterates all guild members → removes title/prestige roles → clears slave suffixes from nicknames

**`!goal`**
Shows `ServerStats.weeklyCoinCount` vs `weeklyGoal` as a visual progress bar (filled/empty blocks).
Displays `weeklyReward` text and `weeklyRewardAmount`.

**`!claimweekly`**

- Checks `weeklyCoinCount >= weeklyGoal`
- Checks user not in `weeklyClaimers[]`
- If both pass: adds userId to `weeklyClaimers`, calls `distributeIncome(userId, weeklyRewardAmount)`

**`!help`**
StringSelectMenu with categories:

- Economy, Games, Gacha, Slavery, Prestige, Market, Trading, Election, Admin
  Each category posts a detailed embed pulled from `config` values.

### Exported functions

**`trackMessage(message)`**
Increments `stats.daily.messages`, `stats.daily.characters`, `stats.allTime.messages`, `stats.allTime.characters`.
Sets `lastActiveTime = Date.now()`.
Uses MongoDB `$inc` for atomic update.

**`trackReaction(giverId, receiverId)`**
Increments `stats.daily.reactionsGiven` for giver, `stats.daily.reactionsReceived` for receiver.

**`checkAndResetStats()`** (exported, called hourly from `index.js`)
Checks if 24h has passed since last daily reset (tracked in `ServerStats.lastReset`).
If yes: sets all users' `stats.daily.*` to 0.
Checks if 7 days have passed since `lastWeeklyReset`.
If yes: clears `weeklyClaimers[]`, resets `weeklyCoinCount = 0`.

**`checkAndResetStats()`** is also the weekly goal reset gate.

**`handleInteraction(interaction, client)`** (exported)
Handles `help_menu` StringSelectMenu interactions.

---

## 20. INTERACTION ID MASTER LIST

All `customId` values used across the bot:

### battle.js

| ID                     | Type   | Action                              |
| ---------------------- | ------ | ----------------------------------- |
| `bet_menu_open`        | Button | Opens fighter selection for betting |
| `bet_select_{userId}`  | Button | Opens bet amount modal              |
| `bet_confirm_{userId}` | Modal  | Confirms bet amount                 |
| `vote_p1`              | Button | Vote for Player 1 in duel           |
| `vote_p2`              | Button | Vote for Player 2 in duel           |

### economy.js

| ID                               | Type             | Action                          |
| -------------------------------- | ---------------- | ------------------------------- |
| `isekai_confirm`                 | Button           | Confirms prestige reset         |
| `isekai_cancel`                  | Button           | Cancels prestige reset          |
| `shop_category_selector`         | StringSelectMenu | Selects shop category           |
| `shop_purchase`                  | Button           | Confirms shop purchase          |
| `shop_back_to_categories`        | Button           | Returns to category list        |
| `equip_page_{n}`                 | Button           | Paginates equip menu            |
| `equip_selector`                 | StringSelectMenu | Selects item to equip           |
| `bag_page_{n}_{userId}`          | Button           | Paginates bag view              |
| `color_modal`                    | Modal            | Input for custom frame color    |
| `amulet_none`                    | Button           | Unequip all amulets             |
| `amulet_custom`                  | Button           | Opens amulet count modal        |
| `amulet_stack_modal`             | Modal            | Input for amulet count          |
| `loan_{accept/decline}_{loanId}` | Button           | Loan offer response             |
| `merchant_item_selector`         | StringSelectMenu | Select item to sell to merchant |
| `merchant_confirm_{item}`        | Button           | Confirm merchant sale           |
| `merchant_cancel`                | Button           | Cancel merchant interaction     |
| `merchant_back`                  | Button           | Back to merchant menu           |
| `merchant_bulk_{itemName}`       | Button           | Bulk sell trigger               |
| `merchant_bulk_modal_{itemName}` | Modal            | Bulk sell quantity input        |
| `merchant_refresh`               | Button           | Refresh merchant prices         |

### election.js

| ID                 | Type   | Action                      |
| ------------------ | ------ | --------------------------- |
| `apply_mod`        | Button | Opens campaign speech modal |
| `mod_speech_modal` | Modal  | Submits election candidacy  |

### market.js

| ID                             | Type             | Action                 |
| ------------------------------ | ---------------- | ---------------------- |
| `market_sell_select`           | StringSelectMenu | Select item to list    |
| `market_sell_modal_{itemName}` | Modal            | Input listing price    |
| `market_page_{n}`              | Button           | Paginate market browse |

### trade.js

| ID                                            | Type             | Action                             |
| --------------------------------------------- | ---------------- | ---------------------------------- |
| `trade_items_{tradeId}_{userId}`              | Button           | Open item category picker          |
| `trade_select_{tradeId}_{userId}`             | StringSelectMenu | Select category                    |
| `trade_select_page_{tradeId}_{userId}_{page}` | Button           | Paginate item list                 |
| `trade_qty_{tradeId}_{userId}_{item}`         | Modal            | Input quantity for stackable items |
| `trade_back_{tradeId}_{userId}`               | Button           | Back to category                   |
| `trade_clear_{tradeId}_{userId}`              | Button           | Clear own offer                    |
| `trade_lock_{tradeId}_{userId}`               | Button           | Lock in offer (confirm)            |
| `trade_confirm_{tradeId}_{userId}`            | Button           | Final confirm                      |
| `trade_cancel_{tradeId}_{userId}`             | Button           | Cancel trade                       |
| `trade_emergency_{tradeId}`                   | Button           | Emergency cancel during countdown  |

### utility.js

| ID          | Type             | Action                   |
| ----------- | ---------------- | ------------------------ |
| `help_menu` | StringSelectMenu | Navigate help categories |

---

## 21. INCOME PIPELINE

Every coin payout in the bot calls `distributeIncome(userId, baseAmount)`. The pipeline:

```
baseAmount
    │
    ▼
[Rich Tax] ─────────────────────────── burned (never reaches anyone)
    │  coins > 1M  → tax = base × 0.50
    │  coins > 100k → tax = base × 0.20
    │  else        → tax = 0
    │
    ▼
[Prestige Bonus] ────────────────────── added to net (tax-free)
    │  bonus = base × PRESTIGE_MULTIPLIERS[prestige]
    │
    ▼
netIncome = base - richTax + bonus
    │
    ▼
[Slave Tax] ─────────────────────────── 40% → transferred to slaveOwner.coins
    │  only if user.isSlave && user.slaveOwner
    │
    ▼
[Loan Repayment] ────────────────────── 20% → transferred to lender.coins
    │  only if active/defaulted loan exists
    │  capped at loan.remainingAmount
    │  marks loan PAID if cleared
    │
    ▼
[Wallet Cap Check] ──────────────────── overflow is lost (logged)
    │  cap = BASE_WALLET_CAP + (prestige × WALLET_CAP_PER_LEVEL)
    │
    ▼
user.coins += finalIncome
ServerStats.weeklyCoinCount += totalAmount
```

---

## 22. BACKGROUND TIMERS

All defined in `client.once('ready')` in `index.js`:

| Interval             | What it does                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Every 60 seconds** | `electionSystem.checkTimers(client)` — advances election steps                                                                                                                                    |
| **Every 60 seconds** | Asylum auto-remover — finds users with expired `asylumExpiry`, removes "locked in asylum" role                                                                                                    |
| **Every 60 seconds** | Bot-ban auto-remover — finds users with expired `botBanExpiry`, clears the field                                                                                                                  |
| **Every 60 seconds** | Loan default checker — finds `ACTIVE` loans past `dueDate`, sets `DEFAULTED`, sets `isSlave: true`, strips privileged roles, shames nickname, posts announcement                                  |
| **Every 60 seconds** | Daily wealth tax — `economySystem.checkAndApplyDailyTax(client)`                                                                                                                                  |
| **Every 60 seconds** | Auction expiry — finds active auctions past `endTime`, resolves winner, transfers ownership and debt, updates nickname, posts announcement                                                        |
| **Every 1 hour**     | `utilitySystem.checkAndResetStats()` — resets daily stats if 24h elapsed, weekly claimers if 7d elapsed                                                                                           |
| **Every 1 hour**     | Market listing expiry — `marketSystem.checkExpiredListings(client)`                                                                                                                               |
| **Every 1 hour**     | Slave passive income — for each `isSlave` user: `hourlyIncome = Math.floor(100 + (dailyMessages/10) × prestigeMultiplier)` → paid to `slaveOwner` via `distributeIncome()`                        |
| **Every 1 hour**     | Vault interest — for each user with `vaultCoins > 0` who has been active in last 24h: `interest = Math.floor(vaultCoins × 0.02)`, capped at vault capacity. Also resets `vaultDailyWithdrawn = 0` |
| **Every 24 hours**   | Full role sync — `ensureAllRoles`, `syncAllUserTitleRoles`, `syncAllUserPrestigeRoles` for all guilds                                                                                             |

---

## 23. BOT PERSONALITY RULES

The bot's voice is a **tsundere anime girl**. Every single user-facing message must follow these rules:

**Required elements (use at least one per response):**

- `>///<` — blushing/embarrassed
- `(¬_¬)` — deadpan annoyance
- `Baka!` or `baka` — calling user an idiot
- `You idiot!` / `you moron` / `you degenerate` / `you greedy bastard`
- `I-It's not like I...` — tsundere classic denial
- `Don't get the wrong idea!`
- `>////<` — deep embarrassment

**Tone rules:**

- Never sound polite, neutral, or corporate
- Never say "Success!" or "Done!" alone — always add personality
- Errors should be insulting ("What are you doing, you absolute walnut?!")
- Confirmations should be reluctant ("F-Fine, here! Don't waste it!")
- Never be outright kind — always undercut warmth with sarcasm

**Examples of correct tone:**

- `"F-Fine, take this! 💰 **+200 Coins** added. Don't waste it on stupid shit, idiot! >///<"`
- `"H-Hah? Only the owner can do this! Know your place! (¬_¬)"`
- `"Y-You got 40 coins! Don't spend them all at once, idiot! >///<"`
- `"U-Ugh! I dropped my coin bag again! First one to grab it gets the coins, you greedy bastards! >///<"`

---

## 24. DEPLOYMENT

**Dockerfile:**

- Base: `node:22-bookworm`
- System deps installed: `build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev` (required for `canvas` npm package)
- `WORKDIR /usr/src/app`
- `npm ci --omit=dev` (production deps only)
- `CMD ["npm", "start"]` → runs `node index.js`

**Required `.env` at runtime:**

```
DISCORD_TOKEN=
MONGO_URI=
PORT=3000
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
```

**Node.js minimum version:** 18.0.0 (uses native `fetch` with `AbortSignal.timeout()` in `mangaCache.js`)

**Startup checklist (bot logs these):**

1. `✅ DISCORD_TOKEN is present` / `❌ CRITICAL: DISCORD_TOKEN is missing!`
2. `✅ MONGO_URI is present` / `❌ CRITICAL: MONGO_URI is missing!`
3. `🔗 Keep-Alive Server listening on port {PORT}`
4. `🔌 Connecting to Database...`
5. `✅ Database Connected!`
6. `🚀 Tsun is online as {bot tag}`
7. Role sync logs per guild
8. `📚 Starting Manga Cache initialization (Jikan API)...`

---

_End of README — this document is the complete reference for the Tsun bot codebase._
