const mongoose = require('mongoose');
const config = require('../config');

const userSchema = new mongoose.Schema({
    // ID & Cached Discord Profile
    userId: { type: String, required: true, unique: true },
    displayName: { type: String, default: null },
    avatarUrl: { type: String, default: null },

    // Battle Stats
    elo: { type: Number, default: config.ECONOMY.DEFAULT_ELO, min: 0 },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },

    // Grid
    gridUrl: { type: String, default: null },

    // Economy
    coins: { type: Number, default: config.ECONOMY.DEFAULT_COINS, min: 0 },
    systemEarned: { type: Number, default: 0 }, // Total coins generated from system
    systemSpent: { type: Number, default: 0 },  // Total coins destroyed to system
    nuggets: { type: Number, default: 0, min: 0 },
    nuggetDuelMilestone: { type: Number, default: 0 }, // Tracks next duel win threshold for nugget grant
    upgrades: {
        walletTier: { type: Number, default: 0 },
        vaultTier:  { type: Number, default: 0 }
    },
    goldenAmuletCount:  { type: Number, default: 0 },
    titanVaultUsed:     { type: Boolean, default: false },
    isekaiDiscountActive: { type: Boolean, default: false },
    doubleDipActive:      { type: Boolean, default: false },
    mediocrityExpiry: { type: Number, default: 0 },
    lastRatTargets: {
        type: [{ _id: false, targetId: String, timestamp: Number }],
        default: []
    },
    bounty: { type: Number, default: 0, min: 0 },
    activeBounties: {
        type: [{
            _id: false,
            placerId: String,
            amount: Number
        }],
        default: []
    },
    inventory: { type: [String], default: [] },

    // Role Persistence (for mutes/slavery)
    strippedRoles: { type: [String], default: [] }, // Stores names of roles removed temporarily

    // NEW: Prestige System
    prestige: { type: Number, default: 0 }, // Stores 0 to 7

    // NEW: Gacha System
    gachaBoxesOpened: { type: Number, default: 0 },
    gachaTotalSpent: { type: Number, default: 0 },
    bestGachaDrop: { type: String, default: null }, // 'COMMON', 'RARE', 'LEGENDARY', etc.
    gachaPityCounter: { type: Number, default: 0 }, // LEGACY — kept for backward compat
    gachaPity: {
        bronze: { type: Number, default: 0 },
        silver: { type: Number, default: 0 },
        gold:   { type: Number, default: 0 },
        goldMythic: { type: Number, default: 0 } // Mythic hard pity counter (Gold only, resets at 50)
    },
    gachaDailyPulls: {
        bronze: { type: Number, default: 0 },
        silver: { type: Number, default: 0 },
        lastReset: { type: Number, default: 0 } // UTC midnight timestamp of last reset
    },

    lastHourly: { type: Number, default: 0 },
    lastActiveTime: { type: Number, default: 0 }, // Precise timestamp of last message

    // Daily Streak
    dailyStreak:        { type: Number, default: 0 },
    lastDailyClaim:     { type: Number, default: 0 },
    longestDailyStreak: { type: Number, default: 0 },

    // --- SLAVERY SYSTEM ---
    isSlave: { type: Boolean, default: false },
    slaveOwner: { type: String, default: null },
    slaveIncomeGenerated: { type: Number, default: 0 }, // Total earned while enslaved
    masterIncomeFromSlaves: { type: Number, default: 0 }, // Total earned from owning slaves
    // --- CARROT SYSTEM ---
    totalCarrotsSpent: { type: Number, default: 0 }, // Lifetime stat for leaderboard
    activeCarrot: {
        amount: { type: Number, default: 0 }, // Coins spent on this carrot
        bonusPerHr: { type: Number, default: 0 }, // Pre-calculated bonus per hour
        expiresAt: { type: Number, default: 0 }, // Expiry timestamp
        ownerId: { type: String, default: null } // Owner who applied carrot
    },
    carrotResistUsed: { type: Boolean, default: false }, // Once per ownership
    resistExpiresAt: { type: Number, default: 0 }, // 6h resist window

    // Cosmetics
    equippedTitle: { type: String, default: null },
    frameColor: { type: String, default: null },
    equippedShield: { type: Boolean, default: false },
    equippedAmuletCount: { type: Number, default: 0 }, // Stacked amulets (0-50)

    // Active Effects
    trashTasteExpiry: { type: Number, default: 0 },
    bountyShieldExpiry: { type: Number, default: 0 }, // Timestamp when bounty shield expires
    // botBanExpiry: { type: Number, default: 0 }, // Moved to GAMES
    // forcedNickname: { type: String, default: null }, // Owner-enforced nickname // Moved to GAMES

    // --- GAMES ---
    guessWinStreak: { type: Number, default: 0 }, // Consecutive !guess wins
    guessTimeoutExpiry: { type: Number, default: 0 }, // Timestamp when timeout ends
    highScore: { type: Number, default: 0 }, // Higher Lower Best Streak
    botBanExpiry: { type: Number, default: 0 },
    forcedNickname: { type: String, default: null }, // Owner-enforced nickname
    opGuessStreak: { type: Number, default: 0 }, // Consecutive !guess opening wins
    opHighestStreak: { type: Number, default: 0 }, // Highest !guess opening streak
    edGuessStreak: { type: Number, default: 0 }, // Consecutive !guess ending wins
    edHighestStreak: { type: Number, default: 0 }, // Highest !guess ending streak
    currentDuelStreak: { type: Number, default: 0 }, // Consecutive duel wins

    // --- ROULETTE STATS ---
    rrGamesPlayed: { type: Number, default: 0 },
    rrHighestRound: { type: Number, default: 0 },      // Furthest round survived
    rrTotalWagered: { type: Number, default: 0 },
    rrTotalWon: { type: Number, default: 0 },           // Pre-tax total
    rrDeaths: { type: Number, default: 0 },
    rrJackpotsWon: { type: Number, default: 0 },

    // --- SHADY MERCHANT SYSTEM ---
    merchantPrices: { type: Map, of: Number, default: {} }, // Item -> rolled price
    merchantLastRefresh: { type: Number, default: 0 }, // Timestamp of last refresh
    merchantDailySold: { type: Number, default: 0 }, // Coins earned today from merchant
    merchantFreeRefreshUsed: { type: Boolean, default: false }, // Has free refresh been used?

    // --- VAULT SYSTEM ---
    vaultCoins: { type: Number, default: 0, min: 0 },
    vaultDailyWithdrawn: { type: Number, default: 0 },
    lastVaultInterest: { type: Number, default: 0 },

    // --- FISHING SYSTEM ---
    fishing: {
        stats: {
            totalCaught: { type: Number, default: 0 },
            heaviestFish: { type: Number, default: 0 },
            mythicsCaught: { type: Number, default: 0 },
            junkCaught: { type: Number, default: 0 }
        },
        gear: {
            activeRod: { type: String, default: 'flimsy_stick' },
            rodDurability: { type: Number, default: 0 },
            ownedRods: { type: Map, of: Number, default: {} }, // rod_id -> current durability
            activeBait: { type: String, default: 'none' },
            baitCount: { type: Number, default: 0 },
            ownedBaits: { type: Map, of: Number, default: {} } // bait_id -> count
        },
        biome: { type: String, default: 'shallow_pond' },
        collection: { type: [String], default: [] },
        pinned: { type: [String], default: [] },
        dailyBounty: {
            targetBiome: { type: String, default: null },
            targetRarity: { type: String, default: null },
            amountNeeded: { type: Number, default: 0 },
            amountCaught: { type: Number, default: 0 },
            rewardTier: { type: String, default: null },
            expiresAt: { type: Number, default: 0 },
            claimed: { type: Boolean, default: false }
        },
        cooldown: { type: Number, default: 0 },
        charterCooldown: { type: Number, default: 0 },
        inventory: [{
            _id: false,
            species: String,
            weight: Number,
            rarity: String,
            value: Number,
            locked: { type: Boolean, default: false }
        }]
    },

    // --- UPGRADED STATS ---
    stats: {
        daily: {
            messages: { type: Number, default: 0 },
            characters: { type: Number, default: 0 },
            reactionsGiven: { type: Number, default: 0 },
            reactionsReceived: { type: Number, default: 0 }
        },
        weekly: {
            messages: { type: Number, default: 0 }
        },
        allTime: {
            messages: { type: Number, default: 0 },
            characters: { type: Number, default: 0 },
            reactionsGiven: { type: Number, default: 0 },
            reactionsReceived: { type: Number, default: 0 },
            channels: {
                type: Map,
                of: Number,
                default: {}
            }
        }
    }
});

module.exports = mongoose.model('User', userSchema);
