// config.js - Centralized Configuration
// All hardcoded values in one place for easy maintenance

module.exports = {
  // === USER IDS ===
  OWNER_ID: process.env.OWNER_ID,

  // === CHANNEL NAMES ===
  CHANNELS: {
    MAIN: "tsun",
    ALT: "tsun-alt",
    GENERAL: "general",
  },

  // === ROLE NAMES ===
  ROLES: {
    OWNER: "Owner",
    MOD: "fatso",
    PRIVILEGED: ["fatso", "Owner"],
    DUEL_LORD: "Duel Lord",
    SUGAR_DADDY: "Sugar Daddy",
    SUGAR_MOMMY: 'Sugar Mommy',
    GAMBLING: "Gambling",
    PRESTIGE: [
      "Iron",
      "Bronze",
      "Silver",
      "Gold",
      "Platinum",
      "Diamond",
      "Master",
    ],
    TRUE_MEMBER: "True Member",
    BASICALLY_EVERYONE: "Basically Everyone",
    MEMBER: "member",
  },

  TRUE_MEMBER_COUNT: 50,
  BASICALLY_EVERYONE_COUNT: 200,

  // === API KEYS ===
  MAL_CLIENT_ID: process.env.MAL_CLIENT_ID,

  // === TIMING CONSTANTS (milliseconds) ===
  TIMING: {
    DUEL_COOLDOWN: 3600000, // 1 hour
    CURSE_DURATION: 86400000, // 24 hours
    TRADE_TIMEOUT: 180000, // 3 minutes
    AUCTION_DURATION: 86400000, // 24 hours
    MARKET_EXPIRY: 604800000, // 7 days
    COIN_BAG_MIN: 20, // Min messages before coin bag
    COIN_BAG_MAX: 30, // Max messages before coin bag
    COIN_BAG_REWARD_MIN: 80,
    COIN_BAG_REWARD_MAX: 250,
    GUESS_TRIGGER: 220, // Messages in #general to trigger guess
    PHRASE_TRIGGER: 150, // Messages in #general before auto-comment
  },

  // === ECONOMIC CONSTANTS ===
  ECONOMY: {
    DEFAULT_COINS: 200,
    DEFAULT_ELO: 1000,
    WEEKLY_GOAL: 10000000, // 10 million
    WEEKLY_REWARD_COINS: 2000,
    WEEKLY_REWARD_NUGGETS: 1,
    MIN_WEEKLY_GOAL: 1000,
    MIN_WEEKLY_REWARD: 100,
    SEASON_START_COINS: 10000,
    HOURLY_MIN_REWARD: 80,
    HOURLY_PERCENTAGE: 0.001,
    FREE_COOLDOWN_BASE: 3600000, // 1 hour
    FREE_COOLDOWN_RICH_THRESHOLD: 100000,
    FREE_COOLDOWN_RICH_MULTIPLIER: 4,
    FREE_COOLDOWN_MILLIONAIRE_THRESHOLD: 1000000,
    FREE_COOLDOWN_MILLIONAIRE_MULTIPLIER: 12,
    DAILY_STREAK_MULTIPLIER: 1000,
    DAILY_STREAK_CAP: 1000000,
    DAILY_COOLDOWN_MS: 72000000, // 20 hours
    DAILY_STREAK_BREAK_MS: 129600000, // 36 hours
    BASE_WALLET_CAP: 5000000, // 5 million
    WALLET_CAP_PER_LEVEL: 85000000, // 85 million per prestige
    FORGE_WALLET_CAP_PER_TIER: 40000000, // 40 million per forge wallet tier
    SLAVE_TAX_RATE: 0.4, // 40%
    SLAVE_BASE_INCOME: 100,
    SLAVE_MESSAGE_DIVISOR: 10,
    RICH_TAX_THRESHOLD: 100000,
    RICH_TAX_RATE: 0.20,
    MILLIONAIRE_TAX_THRESHOLD: 1000000,
    MILLIONAIRE_TAX_RATE: 0.30,
    LOAN_REPAY_RATE: 0.2, // 20%
    DEBT_ERASER_POWER: 0.30, // 30% reduction
    CARROT_MIN: 1000, // Minimum carrot spend
    CARROT_MAX_RATIO: 1.5, // Max carrot = remainingDebt * ratio
    CARROT_DURATION_MS: 86400000, // 24 hours
    CARROT_RESIST_MS: 21600000, // 6 hours
    MARKET_FEE_RATE: 0.05, // 5%
    BOUNTY_TAX_RATE: 0.2, // 20%
    AUCTION_FEE_RATE: 0.05, // 5%
    MIN_BOUNTY: 1000,
    MIN_BET: 10,
    PRESTIGE_MULTIPLIERS: [0, 0.02, 0.05, 0.10, 0.30, 0.50, 0.80, 1.0],
    PRESTIGE_COSTS: [
      200000, 500000, 800000, 2000000, 5000000, 10000000, 30000000,
    ], // Level 1-7
    PRESTIGE_DECAY_START: 0.80, // Starts decaying when wallet is 80% full
    PRESTIGE_DECAY_RANGE: 0.15, // Fully decayed at 95% full (0.80 + 0.15)
  },

  // === FORGE SYSTEM CONSTANTS ===
  FORGE: {
    WALLET_COSTS: [2, 2, 2, 4, 4, 5, 5, 6, 6, 8],
    VAULT_COSTS: [2, 2, 2, 3, 3],
    MAX_WALLET_TIER: 10,
    MAX_VAULT_TIER: 5,
    SHOP: {
      GOLDEN_AMULET_COST: 5,
      TITAN_VAULT_COST: 5,
      DEBT_FORGIVENESS_COST: 8
    }
  },

  // === GOLDEN AMULET (Forge shop permanent income bonus) ===
  GOLDEN_AMULET_BONUS: 0.2, // +0.2x income per golden amulet (max 3)

  // === AMULET STACKING MULTIPLIERS ===
  AMULET_TIERS: {
    BASE: 1.5, // 1 amulet multiplier
    TIER1_RATE: 0.75, // 2-10 amulets, per-amulet increment
    TIER2_RATE: 0.7, // 11-30 amulets, per-amulet increment
    TIER3_RATE: 0.6, // 31-50 amulets, per-amulet increment
    MAX_STACK: 50,
  },

  // === HL AMULET RATE (sqrt curve, weaker than duel — player controls quit) ===
  HL_AMULET_RATE: 0.6, // hlMult = 1 + sqrt(count) * 0.6 → 50 amulets = 5.24x

  // === DUPLICATE TITLE FALLBACK REWARDS ===
  DUPLICATE_FALLBACK: {
    COMMON: 2500,
    RARE: 5000,
    LEGENDARY: 15000,
    ULTRA_RARE: 35000,
    MYTHIC: 75000,
  },

  // === SHOP PRICES ===
  SHOP_PRICES: {
    WEALTH_TAX_RATE: 0.10, // 10% of coins added to all basic items
    "Coin Amulet": 1000,
    "Elo Shield": 40000,
    "Trash Curse": 40000,
    "Curse of Mediocrity": { BASE: 200000, WALLET_RATE: 0.20 },
    "Streak Freeze": { BASE: 100000, WALLET_RATE: 0.50 },
    "Slave Tag Remover": 10000,
    "Slave Freedom Ticket": 50000,
    TITLE_PRICE: 50000,
    RANDOM_FRAME: 2000,
    SUGAR_ROLE: 1000000,
  },

  // === GACHA MINIMUM PRICES (for market listings) ===
  GACHA_MIN_PRICES: {
    COMMON: 8000,
    RARE: 25000,
    LEGENDARY: 75000,
    ULTRA_RARE: 200000,
    MYTHIC: 500000,
  },

  // === GACHA BOX PRICES ===
  GACHA_BOX_PRICES: {
    bronze: 5000,
    silver: 25000,
    gold: { BASE: 100000, WALLET_RATE: 0.05, MAX: 5000000 },
  },

  // === GACHA PITY THRESHOLDS ===
  GACHA_PITY: {
    ULTRA_RARE_THRESHOLD: 10,  // Guaranteed Rare+ every N pulls (Ultra Rare+ for Gold only)
    MYTHIC_HARD_PITY: 50,      // Guaranteed Mythic at exactly N pulls (Gold only)
    SOFT_PITY_START: 40,       // Mythic rate starts escalating at this pull (Gold only)
    SOFT_PITY_MAX_BOOST: 5,    // Max additional % at pull 49 (on top of base ~1.5%)
    SOFT_PITY_MIN_BOOST: 1,    // Starting additional % at SOFT_PITY_START
  },

  // === GACHA FEATURED BANNER ===
  // Title rotates automatically every ROTATION_HOURS to a random MYTHIC title.
  // Set enabled: false to disable the featured banner entirely.
  GACHA_FEATURED: {
    enabled: true,
    title: null,                    // Set at runtime by rotateFeaturedBanner()
    rateUpPercent: 50,              // When a Mythic rolls, this % chance it becomes the featured title
    bannerLabel: null,              // Set at runtime
    bannerDescription: null,        // Set at runtime
    ROTATION_HOURS: 72,             // Rotate every 72 hours (3 days)
    lastRotation: 0,                // Timestamp of last rotation (set at runtime)
  },

  // === GACHA DAILY LIMITS (for rich players) ===
  GACHA_DAILY_LIMITS: {
    WEALTH_THRESHOLD: 1000000,   // coins + vaultCoins >= this triggers limits
    bronze: 20,                  // Max bronze pulls per UTC day
    silver: 10,                  // Max silver pulls per UTC day
  },

  // === ITEM LISTS ===
  ITEMS: {
    NON_TITLE: [
      "Coin Amulet",
      "Elo Shield",
      "Trash Curse",
      "Slave Freedom Ticket",
      "Slave Tag Remover",
      "Bounty Shield",
      "Double Dip",
      "Debt Eraser",
      "Slave Snatcher",
      "Isekai Discount",
      "Curse of Mediocrity",
      "Streak Freeze",
      "Silver Gacha Box",
      "Gold Gacha Box",
    ],
    STACKABLE: [
      "Coin Amulet",
      "Elo Shield",
      "Trash Curse",
      "Slave Freedom Ticket",
      "Bounty Shield",
      "Debt Eraser",
      "Isekai Discount",
      "Double Dip",
      "Streak Freeze",
      "Silver Gacha Box",
      "Gold Gacha Box",
    ],
    FRAME_COLORS: [
      "Red",
      "Blue",
      "Green",
      "Purple",
      "Gold",
      "Pink",
      "Orange",
      "Cyan",
    ],
    SHOP_TITLES: [
      "Onee-San's Fucktoy",
      "2d > 3d",
      "Lewd Handholding",
      "Cutiepie",
      "IDF Soldier",
      "Seinen Addict",
      "Ntr Enjoyer",
      "Ugly Bastard",
      "Facing Allegations",
      "Certified Gambler",
    ],
  },

  // === GAMBLING COMMANDS (restricted to #tsun channels) ===
  GAMBLING_COMMANDS: [
    "!toss",
    "!slots",
    "!rr",
    "!roulette",
    "!bounty",
    "!wanted",
    "!duel",
    "!duels",
    "!guess",
  ],

  // === ELECTION TIMING (minutes) ===
  ELECTION: {
    PURGE_MINS: 10,           // Time for mod removal vote
    APPLY_MINS: 10,           // Time for applications
    VOTE_MINS: 10,            // Time for each final vote / bracket poll
    MIN_VOTES: 1,             // Minimum votes required for a poll to count
    MAX_CANDIDATES: 50,       // Hard cap on applications
    SPEECH_MAX_LENGTH: 200,   // Max speech character count
  },

  // === ROULETTE CONFIG (Multi-Round Progressive) ===
  ROULETTE: {
    MIN_BET: 1000,
    MAX_BET: 1000000,
    JACKPOT_CONTRIBUTION: 0.05,   // 5% of bet feeds jackpot pool
    JACKPOT_SEED: 100000,         // Reset value after claimed
    JACKPOT_CAP: 25000000,        // Max jackpot pool (25M)
    BUTTON_TIMEOUT: 30000,        // 30s to decide or auto-cashout
    ROUNDS: {
      1: { bullets: 1, mult: 1.5, muteTime: 0 },       // 83% survive, no mute
      2: { bullets: 2, mult: 3, muteTime: 60 },         // 67% survive, 1 min mute
      3: { bullets: 3, mult: 6, muteTime: 300 },        // 50% survive, 5 min mute
      4: { bullets: 4, mult: 12, muteTime: 1800 },      // 33% survive, 30 min mute
      5: { bullets: 5, mult: 25, muteTime: 7200 },      // 17% survive, 2 hour mute
    }
  },

  // === VAULT SYSTEM ===
  VAULT: {
    INTEREST_RATE: 0.02, // 2% Daily Interest
    WITHDRAWAL_LIMIT: 0.1, // 10% of total balance per 24h
    BASE_CAPACITY: 5000000, // 5M Base Capacity
    PRESTIGE_CAPACITY_MULTIPLIER: 5000000, // +5M per Prestige Level
    TIER_CAPACITY_MULTIPLIER: 5000000, // +5M per Forge Vault Tier
  },

  // === GUESS GAME REWARDS (based on current wealth) ===
  GUESS_REWARDS: [
    { threshold: 10000, reward: 100 },
    { threshold: 50000, reward: 200 },
    { threshold: 100000, reward: 500 },
    { threshold: 500000, reward: 2000 },
    { threshold: 1000000, reward: 8000 },
    { threshold: 5000000, reward: 20000 },
    { threshold: Infinity, reward: 30000 },
  ],

  // === TRIVIA GAME (!guess op / ed) CONSTANTS ===
  TRIVIA: {
    DURATIONS: { easy: 8, medium: 5, hard: 3, insane: 1 },
    POOL_SIZES: { easy: 200, medium: 500, hard: 700, insane: 1000 },
    DIFF_EMOJI: { easy: '🟢', medium: '🟡', hard: '🔴', insane: '💀' },
    REWARDS: [
      { threshold: 5000000, reward: 65000 },
      { threshold: 1000000, reward: 35000 },
      { threshold: 500000, reward: 15000 },
      { threshold: 100000, reward: 6000 },
      { threshold: 50000, reward: 1500 },
      { threshold: 10000, reward: 700 },
      { threshold: 0, reward: 250 }
    ],
    INSANE_DIMINISHING_RETURNS: [
      { threshold: 5000000, mult: 0.75 },
      { threshold: 1000000, mult: 0.9 }
    ],
    DIFF_MULTS: { easy: 1.0, medium: 1.5, hard: 2.5, insane: 4.0 },
    STREAK_MULTS: [
      { minStreak: 10, mult: 2.0 },
      { minStreak: 5, mult: 1.5 },
      { minStreak: 3, mult: 1.25 },
      { minStreak: 0, mult: 1.0 }
    ]
  },

  // === HIGHER LOWER GAME CONSTANTS ===
  HIGHER_LOWER: {
    POT_MULTIPLIERS: [
      { minStreak: 100, mult: 5000 },
      { minStreak: 50, mult: 1500 },
      { minStreak: 20, mult: 700 },
      { minStreak: 10, mult: 400 },
      { minStreak: 0, mult: 250 }
    ],
    RESULT_BASE_MULTIPLIERS: [
      { minStreak: 100, mult: 1500 },
      { minStreak: 50, mult: 750 },
      { minStreak: 20, mult: 400 },
      { minStreak: 10, mult: 250 },
      { minStreak: 0, mult: 150 }
    ],
    TIMERS: [
      { minStreak: 50, timeMs: 15000 },
      { minStreak: 20, timeMs: 20000 },
      { minStreak: 0, timeMs: 30000 }
    ],
    SPEED_TIERS: [
      { maxTimeMs: 3000, bonus: 4 },
      { maxTimeMs: 5000, bonus: 2 },
      { maxTimeMs: 8000, bonus: 1 }
    ],
    SKIP_COST_PERCENT: 0.15
  },

  // === MARKETPLACE CONSTANTS ===
  MARKET: {
    FEE_PERCENT: 0.05,
    MIN_PRICE_MODIFIER: 0.4,
    MAX_LISTINGS_PER_USER: 5,
    LISTING_DURATION_DAYS: 7,
    FRAME_BASE_PRICE: 2000,
    DEFAULT_UNKNOWN_PRICE: 10000
  },

  // === SOCIAL / MARRIAGE CONSTANTS ===
  SOCIAL: {
    COOLDOWNS: {
      POSITIVE_INTERACTION_MS: 3600000,
      NEGATIVE_INTERACTION_MS: 86400000,
      MILESTONE_INTERVAL_MS: 604800000,
    },
    PROPOSAL: {
      MIN_COST: 50000,
      WEALTH_PERCENT: 0.30
    },
    MARRIAGE: {
      MIN_COST: 100000,
      WEALTH_PERCENT: 0.50
    },
    SHIP_BATTLE: {
      MIN_COST: 2000,
      WEALTH_PERCENT: 0.02
    }
  },

  // === TRADE CONSTANTS ===
  TRADE: {
    TIMEOUT_MS: 180000, // 3 minutes
    DEFAULT_ITEM_VALUE: 10000,
    BALANCE_RATIOS: {
      DANGER: 5,
      WARNING: 3,
      CAUTION: 2
    }
  },

  // === IDLE COINS (hourly passive income by weekly activity rank) ===
  IDLE_COINS: {
    RANK_1: 120,
    RANK_2: 100,
    RANK_3: 85,
    RANK_4_5: 70,
    RANK_6_10: 55,
    RANK_11_30: 30,
    RANK_31_50: 20,
    RANK_51_100: 12,
    DEFAULT: 6
  },

  // === BUZZWORD TRACKING (for !leaderboard buzz) ===
  // Arrays = coupled keywords (combined stats), strings = standalone
  BUZZWORDS: [
    ["nigga", "negro", "nga"],
    "kirk",
    "rape",
    "chud"
  ],

  // === FISHING SYSTEM ===
  FISHING: {
    COOLDOWN_MS: 10000, // 10 seconds
    CHARTER_COOLDOWN_MS: 3600000, // 1 hour
    MINIGAME_TIMEOUT_MIN: 2000, // 2 seconds min wait
    MINIGAME_TIMEOUT_MAX: 10000, // 10 seconds max wait (more unpredictable)
    MAX_INVENTORY: 500, // Cap on how many fish a user can hold
    
    // Daily Bounties
    BOUNTIES: {
      TIERS: {
        EASY: { targetRarities: ['RARE'], amountRange: [5, 10], rewardMultipliers: { baseCoinMult: 2.0 } },
        MEDIUM: { targetRarities: ['UR'], amountRange: [3, 5], rewardMultipliers: { baseCoinMult: 5.0, nuggetChance: 50 } },
        HARD: { targetRarities: ['LEGENDARY', 'MYTHIC'], amountRange: [1, 2], rewardMultipliers: { baseCoinMult: 10.0, nuggets: 2 } }
      }
    },
    
    // UI Icons
    EMOJIS: {
      JUNK: '🗑️',
      COMMON: '🐟',
      RARE: '🐡',
      UR: '🦈',
      LEGENDARY: '🐉',
      MYTHIC: '👑'
    },
    
    // Dynamic scaling base for standard fishing
    REWARD_BASE: [
      { threshold: 10000, base: 200 },     // Buffed 10x
      { threshold: 50000, base: 500 },     // Buffed 10x
      { threshold: 100000, base: 1000 },   // Buffed 10x
      { threshold: 500000, base: 2500 },   // Buffed 5x
      { threshold: 1000000, base: 6000 },  // Buffed 4x
      { threshold: 5000000, base: 15000 }, // Buffed 3.75x
      { threshold: 200000000, base: 25000 },// Buffed ~4x
    ],
    
    // Dynamic cost for charter
    CHARTER_COST_SCALE: [
      { threshold: 10000, cost: 1000 },
      { threshold: 50000, cost: 5000 },
      { threshold: 100000, cost: 10000 },
      { threshold: 500000, cost: 50000 },
      { threshold: 1000000, cost: 100000 },
      { threshold: 5000000, cost: 500000 },
      { threshold: 200000000, cost: 1000000 },
    ],

    // Golden Worm base value — between REWARD_BASE and CHARTER_COST_SCALE
    // Still premium, but not 10-33x normal fishing anymore
    GOLDEN_WORM_VALUE: [
      { threshold: 10000, base: 800 },
      { threshold: 50000, base: 2000 },
      { threshold: 100000, base: 4000 },
      { threshold: 500000, base: 10000 },
      { threshold: 1000000, base: 25000 },
      { threshold: 5000000, base: 60000 },
      { threshold: 200000000, base: 100000 },
    ],
    GOLDEN_WORM_FLOOR: 10000, // Min base value so poor players aren't scammed (was 50000)
    
    // Standard Fishing Drop Table
    STANDARD_DROP: {
      JUNK:  { chance: 50, mult: 0 },
      COMMON:{ chance: 30, mult: 1 },
      RARE:  { chance: 15, mult: 3 },
      UR:    { chance: 4, mult: 10 },
      LEGENDARY:{ chance: 1, mult: 50 },
      MYTHIC:   { chance: 0, mult: 250 }
    },
    
    // Charter Drop Table
    CHARTER_DROP: {
      JUNK:      { chance: 20, mult: 0 },
      RARE:      { chance: 50, mult: 0.5 },
      UR:        { chance: 20, mult: 1.5 },
      LEGENDARY: { chance: 9, mult: 5 },
      MYTHIC:    { chance: 1, mult: 25 }
    },

    // Biomes and Travel (Phase 3)
    BIOMES: {
      shallow_pond: {
        id: "shallow_pond",
        name: "Shallow Pond",
        emoji: "🦆",
        description: "A calm pond for beginners. Mostly carp and garbage.",
        reqCatches: 0,
        reqRod: "flimsy_stick",
        travelCost: 0,
        dropMods: { JUNK: 0, COMMON: 0, RARE: 0, UR: 0, LEGENDARY: 0, MYTHIC: 0 },
        species: {
          COMMON: ["Sardine", "Carp", "Guppy", "Minnow"],
          RARE: ["Bass", "Catfish", "River Eel"],
          UR: ["Giant Salamander", "Armored Carp"],
          LEGENDARY: ["Pond Dragon", "Golden Tadpole"],
          MYTHIC: ["Leviathan of the Shallows"]
        }
      },
      coral_reef: {
        id: "coral_reef",
        name: "Coral Reef",
        emoji: "🪸",
        description: "Vibrant and teeming with rare fish. Less junk, more action.",
        reqCatches: 100,
        reqRod: "carbon_rod",
        travelCost: 10000,
        travelCostWalletRate: 0.01,
        travelCostMax: 500000,
        dropMods: { JUNK: -10, COMMON: -5, RARE: 10, UR: 5, LEGENDARY: 0, MYTHIC: 0 },
        species: {
          COMMON: ["Clownfish", "Blue Tang", "Seaweed", "Starfish"],
          RARE: ["Pufferfish", "Lionfish", "Snapper"],
          UR: ["Stingray", "Moray Eel"],
          LEGENDARY: ["Rainbow Serpent", "Coral Guardian"],
          MYTHIC: ["Leviathan of the Reef"]
        }
      },
      deep_trench: {
        id: "deep_trench",
        name: "Deep Trench",
        emoji: "🌊",
        description: "Dark, crushing depths. High risk, high reward.",
        reqCatches: 500,
        reqRod: "deep_sea_rod",
        travelCost: 50000,
        travelCostWalletRate: 0.02,
        travelCostMax: 2000000,
        dropMods: { JUNK: -20, COMMON: -20, RARE: 10, UR: 15, LEGENDARY: 10, MYTHIC: 5 },
        species: {
          COMMON: ["Lanternfish", "Blobfish", "Tube Worm"],
          RARE: ["Viperfish", "Giant Squid", "Anglerfish"],
          UR: ["Oarfish", "Goblin Shark", "Vampire Squid"],
          LEGENDARY: ["Abyssal Angler", "Kraken Tentacle"],
          MYTHIC: ["Trench Leviathan", "Megalodon"]
        }
      },
      mystic_waterfall: {
        id: "mystic_waterfall",
        name: "Mystic Waterfall",
        emoji: "🌌",
        description: "Floating waters imbued with magic. Only masters can cast here.",
        reqCatches: 1500,
        reqRod: "abyssal_rod",
        travelCost: 200000,
        travelCostWalletRate: 0.05,
        travelCostMax: 10000000,
        dropMods: { JUNK: -30, COMMON: -20, RARE: 10, UR: 20, LEGENDARY: 15, MYTHIC: 5 },
        species: {
          COMMON: ["Glimmer Fish", "Cloud Ray", "Fairy Shrimp"],
          RARE: ["Aura Koi", "Crystal Crab", "Mana Ray"],
          UR: ["Astral Shark", "Sky Serpent"],
          LEGENDARY: ["Galactic Koi", "Celestial Dragon"],
          MYTHIC: ["Cosmic Leviathan", "Star Eater"]
        }
      }
    },
    
    JUNK_TEMPLATES: [
      "Old Boot",
      "Soggy Newspaper",
      "Empty Tuna Can",
      "Used Condom", // Special case
      "Underwear", // Special case
      "Suspiciously Stiff Sock",
      "Discord Mod's Fedora",
      "Crusty Body Pillow",
      "Empty DrPepper Can",
      "Gamer Girl Bath Water (Empty)"
    ],

    // Gear System (Phase 2)
    GEAR: {
      RODS: {
        flimsy_stick: { name: "Flimsy Stick", cost: 0, maxDurability: Infinity, repairCost: 0, mult: 1.0, emoji: '🎋' },
        carbon_rod:   { name: "Carbon Rod", cost: 2, maxDurability: 100, repairCost: 1, mult: 1.5, emoji: '🎣' },
        deep_sea_rod: { name: "Deep Sea Rod", cost: 5, maxDurability: 200, repairCost: 2, mult: 3.0, emoji: '🔱' },
        abyssal_rod:  { name: "Abyssal Rod", cost: 10, maxDurability: 400, repairCost: 4, mult: 7.0, emoji: '🌌' }
      },
      DURABILITY_LOSS: {
        JUNK: 0,
        COMMON: 1,
        RARE: 2,
        UR: 5,
        LEGENDARY: 12,
        MYTHIC: 30
      },
      BAITS: {
        none: { name: "None", emoji: '❌', boost: 0 },
        worm: { name: "Worm", emoji: '🪱', costBase: 500, costScaleMult: 0.005, maxCost: 100000, description: "+10% Rare+ chance" }, // Costs scaling with wallet
        glow_worm: { name: "Glow Worm", emoji: '✨', costBase: 5000, costScaleMult: 0.02, maxCost: 500000, description: "+25% Rare+ chance" },
        golden_worm: { name: "Golden Worm", emoji: '🌟', costNuggets: 1, description: "Guarantees UR+ (Used for Charter)" }
      }
    }
  },

  // === TSUNSTOCKS ===
  STOCKS: {
    BASE_PRICE: 5000,               // Starting price for new stocks (coins)
    PRICE_FLOOR: 1,                 // Stock can never drop below 1 coin
    MAX_SHARES_PER_USER: 200,       // Max shares one investor can hold of a single user
    BROKER_FEE: 0.05,              // 5% fee on buy AND sell

    // Price drivers (additive)
    MESSAGE_PRICE_BUMP: 50.0,        // +50.0 per qualifying message
    MESSAGE_HOURLY_CAP: 2500,         // Max messages/hour that affect stock price
    DUEL_WIN_BUMP: 500.0,            // +500.0 per duel win
    DUEL_LOSS_DROP: 250.0,           // -250.0 per duel loss
    MINIGAME_WIN_BUMP: 250.0,        // +250.0 per minigame win

    // Price drivers (multiplicative)
    BUY_PRESSURE: 0.01,            // +1% price bump when shares are bought
    SELL_PRESSURE: 0.01,           // -1% price drop when shares are sold

    // Inactivity decay
    INACTIVITY_THRESHOLD: 24 * 60 * 60 * 1000,  // 24h before decay starts
    INACTIVITY_DECAY_RATE: 0.02,   // -2% per hour after threshold

    // Rewards
    CEO_SALARY_RATE: 0.25,          // Paid 25% of stock price daily
    DIVIDEND_PER_SHARE: 100,       // 100 coins per share per day (for top active users)
    DIVIDEND_TOP_N: 10,            // Top 10 most active users pay dividends

    // Role
    BLUE_CHIP_COUNT: 5,            // Top N stock prices get the role
    BLUE_CHIP_ROLE: 'Blue Chip',   // Discord role name
  },
};
