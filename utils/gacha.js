// utils/gacha.js - Gacha System Logic
// Extracted from economy.js for better maintainability

const GACHA_TITLES = require('../config/gachaTitles');
const config = require('../config');
const ServerStats = require('../models/ServerStats');

// Drop tables (probabilities in percentages)
const DROP_TABLES = {
    bronze: {
        'coins': 38.9,
        'common_title': 30,
        'amulet': 15,
        'elo_shield': 8,
        'rare_title': 4,
        'freedom_ticket': 0.8,
        'legendary_title': 0.2,
        'bounty_shield': 3,
        'nugget': 0.1
    },
    silver: {
        'coins': 28.5,
        'common_title': 9,
        'rare_title': 21,
        'amulet': 22,
        'elo_shield': 8,
        'freedom_ticket': 3,
        'legendary_title': 3,
        'ultra_rare_title': 0.2,
        'bounty_shield': 3,
        'double_dip': 1.8,
        'nugget': 0.5
    },
    gold: {
        'coins': 1.5,
        'rare_title': 3,
        'amulet': 8,
        'freedom_ticket': 6,
        'bounty_shield': 8,
        'legendary_title': 42,
        'ultra_rare_title': 10,
        'mythic_title': 1,
        'nugget': 5,
        'debt_eraser': 2,
        'slave_snatcher': 0.5,
        'isekai_discount': 4,
        'elo_shield': 4,
        'double_dip': 5
    }
};

// Coin reward ranges per tier
const COIN_RANGES = {
    bronze: [2500, 7500],
    silver: [15000, 40000],
    gold: [60000, 150000]
};

// Rarity display colors
const RARITY_COLORS = {
    COMMON: 0x808080,
    RARE: 0x0099FF,
    LEGENDARY: 0xFFD700,
    ULTRA_RARE: 0x9B59B6,
    MYTHIC: 0xFF0000
};

// Rarity display emojis
const RARITY_EMOJIS = {
    COMMON: '⚪',
    RARE: '🔵',
    LEGENDARY: '🟡',
    ULTRA_RARE: '🟣',
    MYTHIC: '🔴'
};

// Tier display emojis
const TIER_EMOJIS = {
    bronze: '💰',
    silver: '💎',
    gold: '👑'
};

// Rarity order for comparisons
const RARITY_ORDER = ['COMMON', 'RARE', 'LEGENDARY', 'ULTRA_RARE', 'MYTHIC'];

// Fallback coin rewards when user gets a duplicate title (from config)
const DUPLICATE_FALLBACK_REWARDS = config.DUPLICATE_FALLBACK;

/**
 * Execute the result of a drop type
 * @param {string} dropType - The type of drop (coins, amulet, shield, etc.)
 * @param {string} tier - The gacha tier (bronze, silver, gold)
 * @returns {Object} Result object with type, item, rarity, and value
 */
function executeDropResult(dropType, tier) {
    if (dropType === 'coins') {
        const [min, max] = COIN_RANGES[tier];
        const amount = Math.floor(Math.random() * (max - min + 1)) + min;
        return { type: 'coins', item: `${amount.toLocaleString('en-US')} Coins`, rarity: 'COMMON', value: amount };
    }

    if (dropType === 'amulet') {
        return { type: 'item', item: 'Coin Amulet', rarity: 'RARE', value: null };
    }

    if (dropType === 'shield' || dropType === 'elo_shield') {
        return { type: 'item', item: 'Elo Shield', rarity: 'RARE', value: null };
    }

    if (dropType === 'freedom_ticket') {
        return { type: 'item', item: 'Slave Freedom Ticket', rarity: 'LEGENDARY', value: null };
    }

    if (dropType === 'bounty_shield') {
        return { type: 'item', item: 'Bounty Shield', rarity: 'RARE', value: null };
    }

    if (dropType === 'double_dip') {
        return { type: 'item', item: 'Double Dip', rarity: 'RARE', value: null };
    }

    if (dropType === 'nugget') {
        return { type: 'nugget', item: '1 Nugget', rarity: 'LEGENDARY', value: 1 };
    }

    if (dropType === 'debt_eraser') {
        return { type: 'item', item: 'Debt Eraser', rarity: 'RARE', value: null };
    }

    if (dropType === 'slave_snatcher') {
        return { type: 'item', item: 'Slave Snatcher', rarity: 'MYTHIC', value: null };
    }

    if (dropType === 'isekai_discount') {
        return { type: 'item', item: 'Isekai Discount', rarity: 'LEGENDARY', value: null };
    }

    // TITLES
    if (dropType.includes('title')) {
        const rarityMap = {
            'common_title': 'COMMON',
            'rare_title': 'RARE',
            'legendary_title': 'LEGENDARY',
            'ultra_rare_title': 'ULTRA_RARE',
            'mythic_title': 'MYTHIC'
        };
        const rarity = rarityMap[dropType];
        const titles = GACHA_TITLES[rarity];
        const randomTitle = titles[Math.floor(Math.random() * titles.length)];
        return { type: 'title', item: randomTitle, rarity, value: null };
    }

    // Fallback
    return { type: 'coins', item: 'Coins', rarity: 'COMMON', value: 100 };
}

// Tier-specific pity pools (only these drop types are eligible during a pity roll)
const PITY_POOLS = {
    bronze: ['rare_title', 'legendary_title'],
    silver: ['rare_title', 'legendary_title', 'ultra_rare_title'],
    gold:   ['legendary_title', 'ultra_rare_title', 'mythic_title']
};

// Mythic drop types (used for soft/hard pity boosting — items like Slave Snatcher excluded)
const MYTHIC_DROP_TYPES = ['mythic_title'];

/**
 * Calculate the soft pity bonus % for a given mythic pity count.
 * Returns the ADDITIONAL percentage on top of normal mythic rates.
 * @param {number} mythicPityCount - Current mythic pity counter value
 * @returns {number} Additional mythic % boost (0 if below soft pity start)
 */
function getSoftPityRate(mythicPityCount) {
    const { SOFT_PITY_START, MYTHIC_HARD_PITY, SOFT_PITY_MIN_BOOST, SOFT_PITY_MAX_BOOST } = config.GACHA_PITY;
    if (mythicPityCount < SOFT_PITY_START) return 0;
    if (mythicPityCount >= MYTHIC_HARD_PITY) return 100;

    const steps = MYTHIC_HARD_PITY - SOFT_PITY_START - 1; // 9 steps (pull 40-49)
    const progress = mythicPityCount - SOFT_PITY_START;     // 0-9
    return SOFT_PITY_MIN_BOOST + (progress / steps) * (SOFT_PITY_MAX_BOOST - SOFT_PITY_MIN_BOOST);
}

/**
 * Rotate the featured banner to a random MYTHIC title.
 * Picks a different title from the current one. Updates in-memory config and DB.
 * Call on bot startup and periodically (checked via interval).
 * @param {boolean} force - If true, rotates regardless of elapsed time
 */
async function rotateFeaturedBanner(force = false) {
    const featured = config.GACHA_FEATURED;
    if (!featured || !featured.enabled) return;
    const mythicTitles = GACHA_TITLES.MYTHIC;
    if (!mythicTitles || mythicTitles.length === 0) {
        console.error('[GACHA] WARNING: No MYTHIC titles found! Disabling featured banner.');
        featured.enabled = false;
        return;
    }

    try {
        let stats = await ServerStats.findOne({}).lean();
        if (!stats) return; // Wait for ServerStats to be initialized

        const rotationMs = (featured.ROTATION_HOURS || 72) * 60 * 60 * 1000;
        const now = Date.now();
        let currentTitle = stats.featuredGachaTitle || null;
        let lastRot = stats.featuredGachaLastRotation || 0;

        // Sync DB state to memory if available
        if (currentTitle && lastRot) {
            featured.title = currentTitle;
            featured.bannerLabel = `🔥 FEATURED: ${currentTitle}`;
            featured.bannerDescription = `When you roll a Mythic, **${featured.rateUpPercent}%** chance it's **${currentTitle}**! Don't get your hopes up though... (¬_¬)`;
            featured.lastRotation = lastRot;
        }

        // Only rotate if enough time has passed (or forced/first run)
        if (!force && lastRot && (now - lastRot) < rotationMs) return;

        // Pick a random title different from the current one (if possible)
        let pool = mythicTitles.filter(t => t !== currentTitle);
        if (pool.length === 0) pool = mythicTitles; // Only 1 mythic title edge case
        const newTitle = pool[Math.floor(Math.random() * pool.length)];

        featured.title = newTitle;
        featured.bannerLabel = `🔥 FEATURED: ${newTitle}`;
        featured.bannerDescription = `When you roll a Mythic, **${featured.rateUpPercent}%** chance it's **${newTitle}**! Don't get your hopes up though... (¬_¬)`;
        featured.lastRotation = now;

        // Persist to DB
        await ServerStats.updateOne({ _id: stats._id }, { $set: { featuredGachaTitle: newTitle, featuredGachaLastRotation: now } });

        console.log(`[GACHA] 🔥 Featured banner rotated to: "${newTitle}" (next rotation in ${featured.ROTATION_HOURS || 72}h)`);
    } catch (err) {
        console.error('[GACHA] Failed to rotate featured banner:', err);
    }
}

/**
 * Get time remaining until next featured banner rotation in milliseconds.
 * @returns {number} Milliseconds until next rotation (0 if overdue/disabled)
 */
function getTimeUntilRotation() {
    const featured = config.GACHA_FEATURED;
    if (!featured || !featured.enabled || !featured.lastRotation) return 0;
    const rotationMs = (featured.ROTATION_HOURS || 72) * 60 * 60 * 1000;
    const elapsed = Date.now() - featured.lastRotation;
    return Math.max(0, rotationMs - elapsed);
}

/**
 * Roll the gacha with given tier, supporting dual pity system
 * @param {string} tier - The gacha tier (bronze, silver, gold)
 * @param {boolean} isPityUltraRare - Whether Ultra Rare pity triggered (every 10 pulls)
 * @param {boolean} isPityMythic - Whether Mythic hard pity triggered (pull 50, Gold only)
 * @param {number} mythicPityCount - Current mythic pity counter (for soft pity rate calc)
 * @param {Object} user - User document (for mediocrity curse check)
 * @returns {Object} Result object with type, item, rarity, value, and isFeatured flag
 */
function rollGacha(tier, isPityUltraRare, isPityMythic, mythicPityCount, user) {
    // CURSE OF MEDIOCRITY: restrict to coins + common titles only
    if (user && user.mediocrityExpiry > Date.now()) {
        const roll = Math.random() * 100;
        const dropType = roll < 70 ? 'coins' : 'common_title';
        return executeDropResult(dropType, tier);
    }

    const table = DROP_TABLES[tier];

    // HARD PITY: Guaranteed Mythic at pull 50 (Gold only)
    if (isPityMythic) {
        const mythicDrops = Object.entries(table).filter(([key]) => MYTHIC_DROP_TYPES.includes(key));
        const totalMythic = mythicDrops.reduce((sum, [, prob]) => sum + prob, 0);
        const roll = Math.random() * totalMythic;
        let cumulative = 0;
        for (const [dropType, probability] of mythicDrops) {
            cumulative += probability;
            if (roll < cumulative) {
                const result = executeDropResult(dropType, tier);
                return applyFeaturedBanner(result);
            }
        }
    }

    // ULTRA RARE PITY: Guaranteed Ultra Rare+ (every 10 pulls)
    if (isPityUltraRare) {
        const pityPool = PITY_POOLS[tier] || [];
        const pityDrops = Object.entries(table).filter(([key]) => pityPool.includes(key));
        const totalPity = pityDrops.reduce((sum, [, prob]) => sum + prob, 0);
        const roll = Math.random() * totalPity;
        let cumulative = 0;
        for (const [dropType, probability] of pityDrops) {
            cumulative += probability;
            if (roll < cumulative) {
                const result = executeDropResult(dropType, tier);
                if (result.rarity === 'MYTHIC') return applyFeaturedBanner(result);
                return result;
            }
        }
    }

    // SOFT PITY: Boost mythic rates for Gold tier when approaching hard pity
    const softBoost = (tier === 'gold') ? getSoftPityRate(mythicPityCount) : 0;

    if (softBoost > 0) {
        // Build a modified table with boosted mythic rates
        const boostedTable = {};
        let totalNonMythic = 0;
        let totalMythic = 0;

        for (const [key, prob] of Object.entries(table)) {
            if (MYTHIC_DROP_TYPES.includes(key)) {
                totalMythic += prob;
            } else {
                totalNonMythic += prob;
            }
        }

        // Scale non-mythic drops down to make room for the boost
        const newMythicTotal = totalMythic + softBoost;
        const scaleFactor = (100 - newMythicTotal) / totalNonMythic;

        for (const [key, prob] of Object.entries(table)) {
            if (MYTHIC_DROP_TYPES.includes(key)) {
                // Distribute boost proportionally among mythic drop types
                boostedTable[key] = prob + (softBoost * (prob / totalMythic));
            } else {
                boostedTable[key] = prob * scaleFactor;
            }
        }

        // Roll with boosted table
        const roll = Math.random() * 100;
        let cumulative = 0;
        for (const [dropType, probability] of Object.entries(boostedTable)) {
            cumulative += probability;
            if (roll < cumulative) {
                const result = executeDropResult(dropType, tier);
                if (result.rarity === 'MYTHIC') return applyFeaturedBanner(result);
                return result;
            }
        }
    }

    // NORMAL ROLL
    const roll = Math.random() * 100;
    let cumulative = 0;
    for (const [dropType, probability] of Object.entries(table)) {
        cumulative += probability;
        if (roll < cumulative) {
            const result = executeDropResult(dropType, tier);
            if (result.rarity === 'MYTHIC') return applyFeaturedBanner(result);
            return result;
        }
    }

    // Fallback (should never happen)
    return { type: 'coins', item: 'Coins', rarity: 'COMMON', value: 100 };
}

/**
 * Apply featured banner rate-up to a Mythic result.
 * If featured is enabled, coin-flip to replace the title with the featured one.
 * @param {Object} result - The original Mythic drop result
 * @returns {Object} Modified result with isFeatured flag
 */
function applyFeaturedBanner(result) {
    const featured = config.GACHA_FEATURED;
    if (!featured || !featured.enabled) return result;
    if (result.type !== 'title') return result; // Only applies to title drops, not items like Slave Snatcher

    if (Math.random() * 100 < featured.rateUpPercent) {
        result.item = featured.title;
        result.isFeatured = true;
    }
    return result;
}

/**
 * Check if a new rarity is better than the current best
 * @param {string} currentBest - Current best rarity string
 * @param {string} newRarity - New rarity to compare
 * @returns {boolean} True if new rarity is better
 */
function isRarityBetter(currentBest, newRarity) {
    const currentIndex = currentBest ? RARITY_ORDER.indexOf(currentBest) : -1;
    const newIndex = RARITY_ORDER.indexOf(newRarity);
    return newIndex > currentIndex;
}

module.exports = {
    rollGacha,
    executeDropResult,
    isRarityBetter,
    getSoftPityRate,
    rotateFeaturedBanner,
    getTimeUntilRotation,
    DROP_TABLES,
    COIN_RANGES,
    RARITY_COLORS,
    RARITY_EMOJIS,
    TIER_EMOJIS,
    RARITY_ORDER,
    PITY_POOLS,
    DUPLICATE_FALLBACK_REWARDS
};

