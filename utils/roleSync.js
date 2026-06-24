const { PermissionFlagsBits } = require('discord.js');
const User = require('../models/User');
const GACHA_TITLES = require('../config/gachaTitles');
const config = require('../config');

// === CONFIGURATION ===

// Role Colors (Matched to Duel Frame visuals)
const ROLE_COLORS = {
    SHOP: '#00FF00',      // Green (Shop/Custom)
    MYTHIC: '#FF0000',    // Red
    ULTRA_RARE: '#9B30FF',// Purple
    LEGENDARY: '#FFD700', // Gold
    RARE: '#00BFFF',      // Deep Sky Blue
    COMMON: '#FFFFFF'     // White
};

// Titles to ignore (handled elsewhere or special)
// NOTE: We do not use an ignore list anymore. We only touch specific known titles.
const PRESTIGE_ROLES = config.ROLES?.PRESTIGE || [
    'Iron', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Master'
];

// Privileged Roles to Strip on Mute/Slavery
const PRIVILEGED_ROLES = config.ROLES?.PRIVILEGED || ['fatso']; // Customize as needed based on server

// === HELPER FUNCTIONS ===

/**
 * proper case helper
 */
const toTitleCase = str => str.toLowerCase().split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

/**
 * Determine rarity for a title to assign color
 * @param {string} titleName 
 * @returns {string} Rarity key (COMMON, RARE, etc.) or 'SHOP'
 */
function getTitleRarity(titleName) {
    if (!titleName) return 'COMMON';
    const normalized = titleName.toLowerCase().trim();

    // Check Gacha Titles
    if (GACHA_TITLES.MYTHIC.some(t => t.toLowerCase() === normalized)) return 'MYTHIC';
    if (GACHA_TITLES.ULTRA_RARE.some(t => t.toLowerCase() === normalized)) return 'ULTRA_RARE';
    if (GACHA_TITLES.LEGENDARY.some(t => t.toLowerCase() === normalized)) return 'LEGENDARY';
    if (GACHA_TITLES.RARE.some(t => t.toLowerCase() === normalized)) return 'RARE';
    if (GACHA_TITLES.COMMON.some(t => t.toLowerCase() === normalized)) return 'COMMON';

    // Default to Shop/Custom
    return 'SHOP';
}

/**
 * Ensure all Title and Prestige roles exist in the guild
 * Usage: Run on Startup & Daily
 */
async function ensureAllRoles(guild) {
    if (!guild) return;

    // Check Permissions
    const botMember = guild.members.me;
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
        console.error(`[ROLE_SYNC] CRITICAL: Missing 'ManageRoles' permission in ${guild.name}`);
        return;
    }

    console.log(`[ROLE_SYNC] Verifying roles for ${guild.name}...`);

    try {
        // 1. Gather all required titles
        const allTitles = [
            ...GACHA_TITLES.MYTHIC,
            ...GACHA_TITLES.ULTRA_RARE,
            ...GACHA_TITLES.LEGENDARY,
            ...GACHA_TITLES.RARE,
            ...GACHA_TITLES.COMMON,
            ...(config.ITEMS?.SHOP_TITLES || [])
        ];

        // 2. Find anchor position ("member" role)
        const memberRole = guild.roles.cache.find(r => r.name.toLowerCase() === config.ROLES.MEMBER.toLowerCase());
        let anchorPos = memberRole ? memberRole.position : 0;

        if (!memberRole) console.warn(`[ROLE_SYNC] Warning: '${config.ROLES.MEMBER}' role not found. New roles will be created at the bottom.`);

        // 3. Create/Update Title Roles
        for (const title of allTitles) {
            // Case-insensitive search
            const existingRole = guild.roles.cache.find(r => r.name.toLowerCase() === title.toLowerCase());
            const rarity = getTitleRarity(title);
            const color = ROLE_COLORS[rarity];

            if (!existingRole) {
                try {
                    const newRole = await guild.roles.create({
                        name: title,
                        color: color,
                        reason: 'Auto-Sync: Missing Title Role',
                        permissions: [] // No special perms
                    });

                    // Position Logic
                    // Mythic > Member > Others
                    // Note: We can only move roles if bot is higher than target position
                    // This is best-effort. Discord limits re-positioning.
                } catch (err) {
                    console.error(`[ROLE_SYNC] Failed to create role '${title}':`, err.message);
                }
            } else {
                // Optional: Force update color if wrong?
                if (existingRole.hexColor !== color) {
                    // await existingRole.setColor(color).catch(() => {});
                }
            }
        }

        // 4. Create/Update Prestige Roles
        for (const pRole of PRESTIGE_ROLES) {
            const existing = guild.roles.cache.find(r => r.name.toLowerCase() === pRole.toLowerCase());
            if (!existing) {
                await guild.roles.create({
                    name: pRole,
                    color: '#FFA500', // Generic prestige orange, or map specific ones
                    reason: 'Auto-Sync: Missing Prestige Role'
                }).catch(e => console.error(`[ROLE_SYNC] Failed to create prestige role ${pRole}:`, e.message));
            }
        }
        
        // 4.5. Create Sugar Mommy role if missing
        const sugarMommyName = config.ROLES?.SUGAR_MOMMY;
        if (sugarMommyName) {
            const existing = guild.roles.cache.find(r => r.name.toLowerCase() === sugarMommyName.toLowerCase());
            if (!existing) {
                await guild.roles.create({
                    name: sugarMommyName,
                    color: '#FF69B4',
                    reason: 'Auto-Sync: Missing Sugar Mommy Role'
                }).catch(e => console.error(`[ROLE_SYNC] Failed to create Sugar Mommy role:`, e.message));
            }
        }

        // 5. Create True Member role if missing
        const trueMemberName = config.ROLES?.TRUE_MEMBER;
        if (trueMemberName) {
            const existing = guild.roles.cache.find(r => r.name.toLowerCase() === trueMemberName.toLowerCase());
            if (!existing) {
                await guild.roles.create({
                    name: trueMemberName,
                    color: '#00BFFF',
                    reason: 'Auto-Sync: Missing True Member Role'
                }).catch(e => console.error(`[ROLE_SYNC] Failed to create True Member role:`, e.message));
            }
        }

        // 6. Create Basically Everyone role if missing
        const basicallyEveryoneName = config.ROLES?.BASICALLY_EVERYONE;
        if (basicallyEveryoneName) {
            const existing = guild.roles.cache.find(r => r.name.toLowerCase() === basicallyEveryoneName.toLowerCase());
            if (!existing) {
                await guild.roles.create({
                    name: basicallyEveryoneName,
                    color: '#FFFFFF',
                    reason: 'Auto-Sync: Missing Basically Everyone Role'
                }).catch(e => console.error(`[ROLE_SYNC] Failed to create Basically Everyone role:`, e.message));
            }
        }

        console.log(`[ROLE_SYNC] Role verification complete for ${guild.name}.`);

    } catch (error) {
        console.error("[ROLE_SYNC] Error in ensureAllRoles:", error);
    }
}

/**
 * Assign the correct title role to a user and remove the old one
 * @param {Guild} guild 
 * @param {string} userId 
 * @param {string|null} newTitleName Title to equip (or null to just unequip old)
 * @param {string|null} oldTitleName Title to remove
 */
async function syncUserTitleRole(guild, userId, newTitleName, oldTitleName) {
    if (!guild) return;

    try {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) return; // User left server?

        // 1. Remove Old Role
        if (oldTitleName) {
            const oldRole = guild.roles.cache.find(r => r.name.toLowerCase() === oldTitleName.toLowerCase());
            if (oldRole && member.roles.cache.has(oldRole.id)) {
                await member.roles.remove(oldRole, "Unequipping Title").catch(e => console.warn(`[ROLE_SYNC] Failed to remove ${oldTitleName}: ${e.message}`));
            }
        }

        // 2. Add New Role
        if (newTitleName) {
            const newRole = guild.roles.cache.find(r => r.name.toLowerCase() === newTitleName.toLowerCase());
            if (newRole) {
                await member.roles.add(newRole, "Equipping Title").catch(e => console.error(`[ROLE_SYNC] Failed to add ${newTitleName}: ${e.message}`));
            } else {
                console.warn(`[ROLE_SYNC] Role for title '${newTitleName}' not found! Run ensureAllRoles?`);
            }
        }

    } catch (error) {
        console.error(`[ROLE_SYNC] Error syncing user ${userId}:`, error);
    }
}

/**
 * Bulk Sync: Force all users in DB to have the correct roles for their equipped title
 * Usage: Run on Startup & Daily (Self-healing)
 */
async function syncAllUserTitleRoles(guild) {
    if (!guild) return;
    console.log(`[ROLE_SYNC] Starting bulk sync for ${guild.name}...`);

    try {
        // Find all users with an equipped title and only pull their IDs and titles
        const usersWithTitles = await User.find({ equippedTitle: { $ne: null } }).select('userId equippedTitle').lean();

        // Process in chunks to avoid flooding API
        const CHUNK_SIZE = 50;
        let processed = 0;

        for (let i = 0; i < usersWithTitles.length; i += CHUNK_SIZE) {
            const chunk = usersWithTitles.slice(i, i + CHUNK_SIZE);

            await Promise.all(chunk.map(async (userDoc) => {
                const member = await guild.members.fetch(userDoc.userId).catch(() => null);
                if (!member) return;

                const expectedTitle = userDoc.equippedTitle;
                const expectedRole = guild.roles.cache.find(r => r.name.toLowerCase() === expectedTitle.toLowerCase());

                // If user doesn't have the role, give it
                if (expectedRole && !member.roles.cache.has(expectedRole.id)) {
                    await member.roles.add(expectedRole, "Daily Sync Correction").catch(() => { });
                }

                // Optional: Remove OTHER title roles? 
                // That's expensive (looping all roles). 
                // We rely on 'syncUserTitleRole' doing clean swaps usually.
            }));

            // Small breathing room
            // await new Promise(r => setTimeout(r, 1000));
            processed += chunk.length;
        }

        console.log(`[ROLE_SYNC] Bulk sync finished. Checked ${processed} users.`);

    } catch (error) {
        console.error("[ROLE_SYNC] Error in bulk sync:", error);
    }
}

// === PRIVILEGED ROLE HANDLING (Mute/Slavery) ===

/**
 * Remove generic privileged roles (Owner, fatso) and save to DB
 * Used for: Mutes, Slavery, Punishments
 */
async function stripPrivilegedRoles(guild, userId) {
    if (!guild) return;

    try {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) return;

        // 1. Identify roles to remove
        const rolesToRemove = [];
        const roleNamesSaved = [];

        for (const privRoleName of PRIVILEGED_ROLES) {
            const role = guild.roles.cache.find(r => r.name.toLowerCase() === privRoleName.toLowerCase());
            // Check if user has it AND it is manageable by bot
            if (role && member.roles.cache.has(role.id)) {
                if (role.editable) {
                    rolesToRemove.push(role);
                    roleNamesSaved.push(privRoleName); // Store name to be safe against ID changes? Typically ID is better, but config uses names.
                } else {
                    console.warn(`[ROLE_SYNC] Cannot strip '${privRoleName}' from ${member.user.tag} - Role higher than Bot.`);
                }
            }
        }

        if (rolesToRemove.length === 0) return;

        // 2. Update DB *BEFORE* Discord action (Safety)
        await User.findOneAndUpdate(
            { userId: userId },
            { $addToSet: { strippedRoles: { $each: roleNamesSaved } } }, // Add unique
            { upsert: true }
        );

        // 3. Remove from Discord
        for (const role of rolesToRemove) {
            await member.roles.remove(role, "Punishment: Privileged Role Strip").catch(e => console.error(`[ROLE_SYNC] Failed to strip ${role.name}:`, e.message));
        }

        console.log(`[ROLE_SYNC] Stripped [${roleNamesSaved.join(',')}] from ${member.user.tag}`);

    } catch (err) {
        console.error(`[ROLE_SYNC] Error stripping roles for ${userId}:`, err);
    }
}

/**
 * Restore privileged roles from DB
 * Used for: Unmute, Freedom
 */
async function restorePrivilegedRoles(guild, userId) {
    if (!guild) return;

    try {
        const userDoc = await User.findOne({ userId: userId });
        if (!userDoc || !userDoc.strippedRoles || userDoc.strippedRoles.length === 0) return;

        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) return;

        const rolesRestored = [];

        // 1. Attempt to add back roles
        for (const roleName of userDoc.strippedRoles) {
            const role = guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
            if (role && role.editable) {
                await member.roles.add(role, "Punishment Ended: Role Restore").catch(e => console.error(`[ROLE_SYNC] Failed to restore ${role.name}:`, e.message));
                rolesRestored.push(roleName);
            }
        }

        // 2. Clear from DB
        // Only remove the ones we successfully restored? Or clear all to avoid sticky bad state?
        // Let's clear all to be clean.
        await User.findOneAndUpdate(
            { userId: userId },
            { $set: { strippedRoles: [] } }
        );

        console.log(`[ROLE_SYNC] Restored [${rolesRestored.join(',')}] to ${member.user.tag}`);

    } catch (err) {
        console.error(`[ROLE_SYNC] Error restoring roles for ${userId}:`, err);
    }
}

// === PRESTIGE SYNC ===

/**
 * Syncs the specific prestige role for a user based on their level
 * @param {Guild} guild 
 * @param {string} userId 
 * @param {number} level 
 */
async function syncPrestigeRole(guild, userId, level) {
    if (!guild || !userId) return;

    try {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) return;

        // Map Level -> Role Name
        // 0=None, 1=Iron, 2=Bronze, ...
        // PRESTIGE_ROLES array: ['Iron', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Master']
        // Index 0 = Iron (Level 1)

        let targetRoleName = null;
        if (level > 0 && level <= PRESTIGE_ROLES.length) {
            targetRoleName = PRESTIGE_ROLES[level - 1];
        }

        // 1. Identify roles to add/remove
        const rolesToRemove = [];
        let roleToAdd = null;

        for (const pRoleName of PRESTIGE_ROLES) {
            const r = guild.roles.cache.find(role => role.name.toLowerCase() === pRoleName.toLowerCase());
            if (r) {
                if (pRoleName === targetRoleName) {
                    roleToAdd = r;
                } else if (member.roles.cache.has(r.id)) {
                    rolesToRemove.push(r);
                }
            }
        }

        // 2. Remove incorrect prestige roles
        if (rolesToRemove.length > 0) {
            await member.roles.remove(rolesToRemove, "Syncing Prestige (Cleaning old)").catch(e => console.error(`[ROLE_SYNC] Failed to remove old prestige for ${member.user.tag}:`, e.message));
        }

        // 3. Add new prestige role
        if (roleToAdd && !member.roles.cache.has(roleToAdd.id)) {
            await member.roles.add(roleToAdd, `Syncing Prestige (Level ${level})`).catch(e => console.error(`[ROLE_SYNC] Failed to add ${targetRoleName} to ${member.user.tag}:`, e.message));
        }

    } catch (err) {
        console.error(`[ROLE_SYNC] Error in syncPrestigeRole for ${userId}:`, err);
    }
}

/**
 * Bulk Sync: Force all users in DB to have correct prestige roles
 * Usage: Run on Daily Interval
 */
async function syncAllUserPrestigeRoles(guild) {
    if (!guild) return;
    console.log(`[ROLE_SYNC] Starting PRESTIGE bulk sync for ${guild.name}...`);

    try {
        // Find all users with ANY prestige, but only load the necessary fields
        const prestigiousUsers = await User.find({ prestige: { $gt: 0 } }).select('userId prestige').lean();

        // Process in chunks
        const CHUNK_SIZE = 50;
        let processed = 0;

        for (let i = 0; i < prestigiousUsers.length; i += CHUNK_SIZE) {
            const chunk = prestigiousUsers.slice(i, i + CHUNK_SIZE);

            await Promise.all(chunk.map(async (userDoc) => {
                await syncPrestigeRole(guild, userDoc.userId, userDoc.prestige);
            }));

            processed += chunk.length;
        }

        console.log(`[ROLE_SYNC] Prestige bulk sync finished. Checked ${processed} users.`);

    } catch (error) {
        console.error("[ROLE_SYNC] Error in prestige bulk sync:", error);
    }
}

/**
 * Sync True Member role: top N all-time chatters get the role, everyone else loses it
 * Usage: Run on Startup & Daily (alongside prestige/title sync)
 */
async function syncTrueMemberRoles(guild) {
    if (!guild) return;

    const botMember = guild.members.me;
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
        console.error(`[ROLE_SYNC] CRITICAL: Missing 'ManageRoles' permission in ${guild.name} — skipping True Member sync`);
        return;
    }

    const trueMemberName = config.ROLES?.TRUE_MEMBER;
    if (!trueMemberName) return;

    const role = guild.roles.cache.find(r => r.name.toLowerCase() === trueMemberName.toLowerCase());
    if (!role) {
        console.error(`[ROLE_SYNC] True Member role '${trueMemberName}' not found — run ensureAllRoles first`);
        return;
    }

    console.log(`[ROLE_SYNC] Starting True Member sync for ${guild.name}...`);

    try {
        const count = config.TRUE_MEMBER_COUNT || 50;

        // Fetch all guild members so cache is fully populated before lookups
        await guild.members.fetch();

        const cursor = User.find({ 'stats.allTime.messages': { $gt: 0 } })
            .sort({ 'stats.allTime.messages': -1 })
            .select('userId')
            .lean()
            .cursor();

        const qualifyingIds = new Set();
        let skipped = 0;

        for await (const userDoc of cursor) {
            if (qualifyingIds.size >= count) break;
            
            const member = guild.members.cache.get(userDoc.userId);
            if (member && !member.user.bot) {
                qualifyingIds.add(userDoc.userId);
            } else {
                skipped++;
            }
        }

        let removed = 0;
        let assigned = 0;

        // Remove role from members who have it but are no longer in top N
        const currentHolders = guild.members.cache.filter(m => m.roles.cache.has(role.id));
        for (const [, member] of currentHolders) {
            if (member.user.bot) continue;
            if (!qualifyingIds.has(member.id)) {
                await member.roles.remove(role, 'True Member Sync: Dropped out of top').catch(e =>
                    console.error(`[ROLE_SYNC] Failed to remove True Member from ${member.user.tag}:`, e.message)
                );
                removed++;
            }
        }

        // Add role to qualifying members in chunks
        const CHUNK_SIZE = 50;
        const qualifying = [...qualifyingIds];

        for (let i = 0; i < qualifying.length; i += CHUNK_SIZE) {
            const chunk = qualifying.slice(i, i + CHUNK_SIZE);

            await Promise.all(chunk.map(async (userId) => {
                const member = guild.members.cache.get(userId);
                if (!member) return;
                
                if (!member.roles.cache.has(role.id)) {
                    await member.roles.add(role, 'True Member Sync: Top chatter').catch(e =>
                        console.error(`[ROLE_SYNC] Failed to add True Member to ${member.user.tag}:`, e.message)
                    );
                    assigned++;
                }
            }));
        }

        console.log(`[ROLE_SYNC] True Member sync: ${assigned} assigned, ${removed} removed, ${skipped} skipped (left server/bots)`);

    } catch (error) {
        console.error('[ROLE_SYNC] Error in True Member sync:', error);
    }
}

/**
 * Sync Basically Everyone role: top N all-time chatters get the role, everyone else loses it.
 * Skips users who are no longer in the server and keeps filling until the quota is met.
 * Usage: Run on Startup & Daily (alongside prestige/title sync)
 */
async function syncBasicallyEveryoneRoles(guild) {
    if (!guild) return;

    const botMember = guild.members.me;
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
        console.error(`[ROLE_SYNC] CRITICAL: Missing 'ManageRoles' permission in ${guild.name} — skipping Basically Everyone sync`);
        return;
    }

    const roleName = config.ROLES?.BASICALLY_EVERYONE;
    if (!roleName) return;

    const role = guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
    if (!role) {
        console.error(`[ROLE_SYNC] Basically Everyone role '${roleName}' not found — run ensureAllRoles first`);
        return;
    }

    console.log(`[ROLE_SYNC] Starting Basically Everyone sync for ${guild.name}...`);

    try {
        const count = config.BASICALLY_EVERYONE_COUNT || 200;


        const cursor = User.find({ 'stats.allTime.messages': { $gt: 0 } })
            .sort({ 'stats.allTime.messages': -1 })
            .select('userId')
            .lean()
            .cursor();

        const qualifyingIds = new Set();
        let skipped = 0;

        for await (const userDoc of cursor) {
            if (qualifyingIds.size >= count) break;

            const member = guild.members.cache.get(userDoc.userId);
            if (member && !member.user.bot) {
                qualifyingIds.add(userDoc.userId);
            } else {
                skipped++;
            }
        }

        let removed = 0;
        let assigned = 0;

        // Remove role from members who have it but are no longer in top N
        const currentHolders = guild.members.cache.filter(m => m.roles.cache.has(role.id));
        for (const [, member] of currentHolders) {
            if (member.user.bot) continue;
            if (!qualifyingIds.has(member.id)) {
                await member.roles.remove(role, 'Basically Everyone Sync: Dropped out of top').catch(e =>
                    console.error(`[ROLE_SYNC] Failed to remove Basically Everyone from ${member.user.tag}:`, e.message)
                );
                removed++;
            }
        }

        // Add role to qualifying members in chunks
        const CHUNK_SIZE = 50;
        const qualifying = [...qualifyingIds];

        for (let i = 0; i < qualifying.length; i += CHUNK_SIZE) {
            const chunk = qualifying.slice(i, i + CHUNK_SIZE);

            await Promise.all(chunk.map(async (userId) => {
                const member = guild.members.cache.get(userId);
                if (!member) return;

                if (!member.roles.cache.has(role.id)) {
                    await member.roles.add(role, 'Basically Everyone Sync: Top chatter').catch(e =>
                        console.error(`[ROLE_SYNC] Failed to add Basically Everyone to ${member.user.tag}:`, e.message)
                    );
                    assigned++;
                }
            }));
        }

        console.log(`[ROLE_SYNC] Basically Everyone sync: ${assigned} assigned, ${removed} removed, ${skipped} skipped (left server/bots)`);

    } catch (error) {
        console.error('[ROLE_SYNC] Error in Basically Everyone sync:', error);
    }
}

module.exports = {
    ensureAllRoles,
    syncUserTitleRole,
    syncAllUserTitleRoles,
    syncPrestigeRole,
    syncAllUserPrestigeRoles,
    syncTrueMemberRoles,
    syncBasicallyEveryoneRoles,
    stripPrivilegedRoles,
    restorePrivilegedRoles
};
