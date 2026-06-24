/**
 * Shared Helper Utilities for the Discord Bot
 * Consolidates common functions used across multiple command files.
 */
const config = require('../config');
const User = require('../models/User');

/**
 * Get a user's display name safely
 * @param {string} userId - Discord user ID
 * @param {Guild} guild - Discord Guild object
 * @returns {Promise<string>} - Display name or fallback
 */
async function getDisplayName(userId, guild) {
    // 1. Try Discord cache first (instant)
    let member = guild?.members?.cache?.get(userId);
    if (member) return member.displayName;

    // 2. Try DB if not in cache (fast)
    try {
        const userDoc = await User.findOne({ userId }).lean();
        if (userDoc && userDoc.displayName) {
            return userDoc.displayName;
        }
    } catch (e) {
        // Ignore DB error, proceed to fetch
    }

    // 3. Fallback to API fetch (slow)
    try {
        member = await guild.members.fetch(userId);
        const name = member.displayName;
        const avatar = member.user.displayAvatarURL({ size: 256 });
        
        // Upsert to User database instantly to keep the website in sync
        User.updateOne(
            { userId }, 
            { $set: { displayName: name, avatarUrl: avatar } }, 
            { upsert: true }
        ).catch(() => {});
        
        return name;
    } catch (e) {
        return `User#${userId.slice(-4)}`;
    }
}

/**
 * Safe wrapper for role operations
 * @param {Function} operation - Async function to execute
 * @param {string} fallbackMessage - Message to log on failure
 * @returns {Promise<boolean>} - Success status
 */
async function safeRoleOperation(operation, fallbackMessage = "Role operation failed") {
    try {
        await operation();
        return true;
    } catch (e) {
        console.error(`${fallbackMessage}:`, e.message);
        return false;
    }
}

/**
 * Safe wrapper for coin operations with rollback support
 * @param {Function} operation - Async function to execute
 * @param {Object} user - User object for potential rollback
 * @param {number} amount - Amount involved (for logging)
 * @returns {Promise<{success: boolean, error: string|null}>}
 */
async function safeCoinOperation(operation, user, amount) {
    const originalCoins = user.coins;
    try {
        await operation();
        return { success: true, error: null };
    } catch (e) {
        console.error(`Coin operation failed (Amount: ${amount}):`, e.message);
        // Attempt rollback
        try {
            await User.updateOne({ userId: user.userId }, { $set: { coins: originalCoins } });
        } catch (rollbackError) {
            console.error("Rollback also failed:", rollbackError.message);
        }
        return { success: false, error: e.message };
    }
}

/**
 * Creates a self-cleaning Map that removes old entries
 * @param {number} maxAge - Maximum age of entries in milliseconds
 * @param {number} cleanupInterval - How often to clean in milliseconds
 * @returns {Map} - Extended Map with auto-cleanup
 */
function createCleaningMap(maxAge = 3600000, cleanupInterval = 1800000) {
    const map = new Map();

    // Store timestamps with values
    const originalSet = map.set.bind(map);
    map.set = (key, value) => {
        return originalSet(key, { value, timestamp: Date.now() });
    };

    const originalGet = map.get.bind(map);
    map.get = (key) => {
        const entry = originalGet(key);
        return entry ? entry.value : undefined;
    };

    // Cleanup old entries periodically
    setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of map.entries()) {
            if (entry && entry.timestamp && (now - entry.timestamp > maxAge)) {
                map.delete(key);
            }
        }
    }, cleanupInterval);

    return map;
}

/**
 * Calculate amulet multiplier based on equipped count
 * Uses config.AMULET_TIERS for all tier rates
 * 
 * @param {number} count - Number of equipped amulets
 * @returns {number} Multiplier value
 */
function getAmuletMultiplier(count) {
    const t = config.AMULET_TIERS;
    if (count <= 0) return 1.0;
    if (count === 1) return t.BASE;

    let mult = t.BASE;
    const tier1 = Math.min(count, 10) - 1;
    if (tier1 > 0) mult += tier1 * t.TIER1_RATE;
    if (count > 10) mult += (Math.min(count, 30) - 10) * t.TIER2_RATE;
    if (count > 30) mult += (Math.min(count, t.MAX_STACK) - 30) * t.TIER3_RATE;

    return mult;
}

/**
 * Convert a string to Title Case
 * @param {string} str - String to convert
 * @returns {string} - Title cased string
 */
function titleCase(str) {
    if (!str) return '';
    return str
        .toLowerCase()
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

/**
 * Calculate the max vault capacity properly utilizing base, prestige, forge tier, and titan vault multiplier.
 * @param {number} prestige - Prestige level of the user (e.g. user.prestige || 0)
 * @param {number} vaultTier - Forge vault tier upgraded by nuggets (e.g. user.upgrades?.vaultTier || 0)
 * @param {boolean} titanVaultUsed - If user applied the titan vault token (e.g. user.titanVaultUsed)
 * @returns {number} Max Vault Capacity
 */
function getVaultCap(prestige = 0, vaultTier = 0, titanVaultUsed = false) {
    const base = config.VAULT.BASE_CAPACITY;
    const prestigeBonus = prestige * config.VAULT.PRESTIGE_CAPACITY_MULTIPLIER;
    const tierBonus = vaultTier * config.VAULT.TIER_CAPACITY_MULTIPLIER;
    let totalCap = base + prestigeBonus + tierBonus;
    if (titanVaultUsed) totalCap *= 2;
    return totalCap;
}

module.exports = {
    getDisplayName,
    safeRoleOperation,
    safeCoinOperation,
    createCleaningMap,
    getAmuletMultiplier,
    titleCase,
    getVaultCap
};
