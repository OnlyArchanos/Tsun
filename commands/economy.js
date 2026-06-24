const {
    EmbedBuilder, ActionRowBuilder,
    StringSelectMenuBuilder, StringSelectMenuOptionBuilder, TextInputBuilder, TextInputStyle,
    ModalBuilder, PermissionFlagsBits, MessageFlags,
    ButtonBuilder, ButtonStyle
} = require('discord.js');
const User = require('../models/User');
const Loan = require('../models/Loan');
const Auction = require('../models/Auction');
const battleSystem = require('./battle');
const { distributeIncome } = require('../utils/income');
const ServerStats = require('../models/ServerStats');
const GACHA_TITLES = require('../config/gachaTitles');
const { getDisplayName, createCleaningMap, getVaultCap } = require('../utils/helpers');
const config = require('../config');
const roleSync = require('../utils/roleSync');
const fishingSystem = require('./fishing');
const { rollGacha, executeDropResult, DROP_TABLES, getSoftPityRate, getTimeUntilRotation } = require('../utils/gacha');
const Relationship = require('../models/Relationship');
const { applyRelationshipSuffix } = require('./social');
// Helper: Title Case
const titleCase = str => str.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
const slotsCooldowns = createCleaningMap(3000, 300000);
const rrGames = createCleaningMap(60000, 300000); // Active roulette games (60s TTL, 5min cleanup)
const ACTIVE_LOAN_STATUSES = ['ACTIVE', 'DEFAULTED'];
const loanAcceptLocks = new Set();
const NON_TITLE_ITEMS = ["Elo Shield", "Coin Amulet", "Trash Curse", "Slave Tag Remover", "Slave Freedom Ticket", "Bounty Shield", "Double Dip", "Debt Eraser", "Slave Snatcher", "Isekai Discount", "Curse of Mediocrity", "Streak Freeze", "Silver Gacha Box", "Gold Gacha Box"];
const CARROT_RESET_SET = {
    'activeCarrot.amount': 0,
    'activeCarrot.bonusPerHr': 0,
    'activeCarrot.expiresAt': 0,
    'activeCarrot.ownerId': null
};

function formatDurationCompact(ms) {
    const safeMs = Math.max(0, ms);
    const totalMinutes = Math.floor(safeMs / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    return `${hours}h ${mins}m`;
}

function calculateSlaveHourlyIncome(slave, now = Date.now()) {
    const dailyMessages = slave.stats?.daily?.messages || 0;
    const prestige = slave.prestige || 0;
    const prestigeMultiplier = 1.0 + (prestige * 0.2);
    const baseHourly = Math.floor(config.ECONOMY.SLAVE_BASE_INCOME + (dailyMessages / config.ECONOMY.SLAVE_MESSAGE_DIVISOR) * prestigeMultiplier);
    const carrotActive = (slave.activeCarrot?.expiresAt || 0) > now;
    const resistActive = (slave.resistExpiresAt || 0) > now;
    const carrotBonus = carrotActive && !resistActive ? (slave.activeCarrot?.bonusPerHr || 0) : 0;
    const hourlyIncome = baseHourly + carrotBonus;
    const ownerCut = Math.floor(hourlyIncome * config.ECONOMY.SLAVE_TAX_RATE);
    const loanRepay = Math.floor(hourlyIncome * config.ECONOMY.LOAN_REPAY_RATE);
    const selfKeep = Math.max(0, hourlyIncome - ownerCut - loanRepay);

    return {
        baseHourly,
        carrotActive,
        resistActive,
        carrotBonus,
        hourlyIncome,
        ownerCut,
        loanRepay,
        selfKeep
    };
}

// Rarity mapping for each drop type — used to compute accurate rate displays
const DROP_RARITY_MAP = {
    coins: 'COMMON', common_title: 'COMMON',
    amulet: 'RARE', elo_shield: 'RARE', rare_title: 'RARE', bounty_shield: 'RARE', double_dip: 'RARE', debt_eraser: 'RARE',
    freedom_ticket: 'LEGENDARY', legendary_title: 'LEGENDARY', nugget: 'LEGENDARY', isekai_discount: 'LEGENDARY',
    ultra_rare_title: 'ULTRA_RARE',
    mythic_title: 'MYTHIC', slave_snatcher: 'MYTHIC'
};

function computeTierRates(tier) {
    const table = DROP_TABLES[tier];
    const totals = { COMMON: 0, RARE: 0, LEGENDARY: 0, ULTRA_RARE: 0, MYTHIC: 0 };
    for (const [dropType, prob] of Object.entries(table)) {
        const rarity = DROP_RARITY_MAP[dropType] || 'COMMON';
        totals[rarity] += prob;
    }
    return totals;
}

async function showGachaDashboard(messageOrInteraction, user) {
    const isInteraction = typeof messageOrInteraction.update === 'function';
    
    const embed = new EmbedBuilder()
        .setColor(0xFF1493)
        .setTitle("🎰 Tsun's Gacha Dashboard")
        .setDescription(
            "W-Welcome to the gacha! Don't just stand there staring, pick a banner from the menu below or I'll kick you out! (¬_¬)\n\n" +
            "Use the dropdown to view box details, rates, and pity, then click the buttons to pull!"
        )
        .setFooter({ text: "Gacha Dashboard" });

    const userId = isInteraction ? messageOrInteraction.user.id : messageOrInteraction.author.id;
    const rowMenu = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`gacha_tier_select_${userId}`)
            .setPlaceholder('Select a Banner or View Rates...')
            .addOptions([
                { label: 'Bronze Box', description: 'Common items & small rare chance', value: 'bronze', emoji: '💰' },
                { label: 'Silver Box', description: 'Better rates & ultra rare chance', value: 'silver', emoji: '💎' },
                { label: 'Gold Box', description: 'Legendary rates & mythic titles', value: 'gold', emoji: '👑' },
                { label: 'Drop Rates', description: 'View exact percentage drop rates', value: 'rates', emoji: '📊' }
            ])
    );

    // Initial state: no banner selected, so buttons are disabled
    const rowButtons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`gacha_pull_1_none_${userId}`).setLabel('Pull 1x').setStyle(ButtonStyle.Primary).setDisabled(true),
        new ButtonBuilder().setCustomId(`gacha_pull_10_none_${userId}`).setLabel('Pull 10x').setStyle(ButtonStyle.Success).setDisabled(true)
    );

    const payload = { embeds: [embed], components: [rowMenu, rowButtons] };
    
    if (isInteraction) {
        if (!messageOrInteraction.replied && !messageOrInteraction.deferred) {
            await messageOrInteraction.update(payload);
        } else {
            await messageOrInteraction.editReply(payload);
        }
    } else {
        await messageOrInteraction.reply(payload);
    }
}

async function handleGachaDashboardSelect(interaction, client) {
    const tier = interaction.values[0];
    const user = await User.findOne({ userId: interaction.user.id });
    if (!user) return interaction.reply({ content: "You don't exist in my database! (¬_¬)", ephemeral: true });

    const goldPrice = Math.floor(Math.min(config.GACHA_BOX_PRICES.gold.MAX || Infinity, config.GACHA_BOX_PRICES.gold.BASE + user.coins * config.GACHA_BOX_PRICES.gold.WALLET_RATE));

    let embed = new EmbedBuilder().setColor(0xFF1493).setTitle("🎰 Tsun's Gacha Dashboard");
    
    if (tier === 'rates') {
        const formatRates = (t) => {
            const r = computeTierRates(t);
            return `Common: ${r.COMMON}% | Rare: ${r.RARE}% | Legendary: ${r.LEGENDARY}% | Ultra Rare: ${r.ULTRA_RARE}% | Mythic: ${r.MYTHIC}%`;
        };
        embed.setDescription(
            "📊 **DROP RATES**\n\n" +
            "**💰 Bronze Box:**\n" +
            formatRates('bronze') + "\n\n" +
            "**💎 Silver Box:**\n" +
            formatRates('silver') + "\n\n" +
            "**👑 Gold Box:**\n" +
            formatRates('gold') + "\n\n" +
            "*(Nuggets also have a small chance to drop in Gold boxes!)*"
        );
    } else {
        const prices = { bronze: config.GACHA_BOX_PRICES.bronze, silver: config.GACHA_BOX_PRICES.silver, gold: goldPrice };
        const descMap = {
            bronze: "Common items + small chance for rare titles",
            silver: "Better rates + ultra rare titles unlock",
            gold: "Legendary rates + mythic titles + nuggets possible!"
        };
        const tierEmojis = { bronze: '💰', silver: '💎', gold: '👑' };

        // Build progress bar helper
        const buildBar = (current, max) => {
            const filled = Math.min(Math.round((current / max) * 10), 10);
            return '█'.repeat(filled) + '░'.repeat(10 - filled);
        };

        const ultraRarePity = user.gachaPity?.[tier] || 0;
        const mythicPity = (tier === 'gold') ? (user.gachaPity?.goldMythic || 0) : 0;

        // Dynamic embed color for Gold based on mythic pity
        if (tier === 'gold') {
            if (mythicPity >= 45) embed.setColor(0xFF4500);       // Blazing red-orange
            else if (mythicPity >= 30) embed.setColor(0x9B59B6);  // Glowing purple
        }

        let pityDisplay;
        if (tier === 'gold') {
            const softBoost = getSoftPityRate(mythicPity);
            pityDisplay =
                `🎯 **Ultra Rare Pity:** ${ultraRarePity}/${config.GACHA_PITY.ULTRA_RARE_THRESHOLD} [${buildBar(ultraRarePity, config.GACHA_PITY.ULTRA_RARE_THRESHOLD)}]\n` +
                `🔥 **Mythic Pity:** ${mythicPity}/${config.GACHA_PITY.MYTHIC_HARD_PITY} [${buildBar(mythicPity, config.GACHA_PITY.MYTHIC_HARD_PITY)}]` +
                (softBoost > 0 ? `\n⚡ **SOFT PITY ACTIVE** — Mythic rate boosted by +${softBoost.toFixed(1)}%!` : '');
        } else {
            pityDisplay = `🎯 **Pity:** ${ultraRarePity}/${config.GACHA_PITY.ULTRA_RARE_THRESHOLD} [${buildBar(ultraRarePity, config.GACHA_PITY.ULTRA_RARE_THRESHOLD)}] — next pity guaranteed Rare+`;
        }

        let desc =
            `${tierEmojis[tier]} **${tier.charAt(0).toUpperCase() + tier.slice(1)} Box** - ${prices[tier].toLocaleString('en-US')} Coins${tier === 'gold' ? ' *(scales with wallet)*' : ''}\n` +
            `${descMap[tier]}\n\n` +
            `${pityDisplay}\n\n` +
            `*(10-Pulls cost 10x the price${tier === 'gold' ? ', with a flat 5% discount' : ''}!)*`;

        // Featured banner display (Gold only)
        if (tier === 'gold' && config.GACHA_FEATURED?.enabled && config.GACHA_FEATURED.title) {
            const rotMs = getTimeUntilRotation();
            const rotHours = Math.floor(rotMs / 3600000);
            const rotMins = Math.floor((rotMs % 3600000) / 60000);
            const rotText = rotMs > 0 ? `⏰ Rotates in **${rotHours}h ${rotMins}m**` : '⏰ Rotating soon...';
            desc += `\n\n${config.GACHA_FEATURED.bannerLabel}\n${config.GACHA_FEATURED.bannerDescription}\n${rotText}`;
        }

        embed.setDescription(desc);
    }

    const rowMenu = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`gacha_tier_select_${interaction.user.id}`)
            .setPlaceholder('Select a Banner or View Rates...')
            .addOptions([
                { label: 'Bronze Box', description: 'Common items & small rare chance', value: 'bronze', emoji: '💰', default: tier === 'bronze' },
                { label: 'Silver Box', description: 'Better rates & ultra rare chance', value: 'silver', emoji: '💎', default: tier === 'silver' },
                { label: 'Gold Box', description: 'Legendary rates & mythic titles', value: 'gold', emoji: '👑', default: tier === 'gold' },
                { label: 'Drop Rates', description: 'View exact percentage drop rates', value: 'rates', emoji: '📊', default: tier === 'rates' }
            ])
    );

    const pullDisabled = tier === 'rates';
    const rowButtons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`gacha_pull_1_${tier}_${interaction.user.id}`).setLabel('Pull 1x').setStyle(ButtonStyle.Primary).setDisabled(pullDisabled),
        new ButtonBuilder().setCustomId(`gacha_pull_10_${tier}_${interaction.user.id}`).setLabel('Pull 10x').setStyle(ButtonStyle.Success).setDisabled(pullDisabled)
    );

    await interaction.update({ embeds: [embed], components: [rowMenu, rowButtons] });
}

async function executeGachaPull(context, user, tier, pullCount, client) {
    const isInteraction = typeof context.update === 'function';
    const originalAuthor = isInteraction ? context.user : context.author;
    const guild = context.guild;
    
    // Prevent spam — auto-evicts after 30s so a crash can't permanently lock a user
    if (!global.gachaInProgress) global.gachaInProgress = createCleaningMap(30000, 60000);
    if (global.gachaInProgress.get(originalAuthor.id)) {
        const msg = "H-Hey! Your previous gacha is still opening! Wait for it to finish, you impatient fool! (¬_¬)";
        if (isInteraction) return context.reply({ content: msg, ephemeral: true });
        return context.reply(msg);
    }
    global.gachaInProgress.set(originalAuthor.id, true);

    try {
        // --- DAILY PULL LIMIT CHECK (rich players: bronze/silver only) ---
        const limits = config.GACHA_DAILY_LIMITS;
        if (limits && limits[tier] !== undefined) {
            const wealth = (user.coins || 0) + (user.vaultCoins || 0);
            if (wealth >= limits.WEALTH_THRESHOLD) {
                // Calculate today's UTC midnight for day rollover
                const now = Date.now();
                const todayMidnight = new Date();
                todayMidnight.setUTCHours(0, 0, 0, 0);
                const todayMs = todayMidnight.getTime();

                // Reset counters if last reset was before today's midnight
                const lastReset = user.gachaDailyPulls?.lastReset || 0;
                if (lastReset < todayMs) {
                    await User.findOneAndUpdate(
                        { userId: originalAuthor.id },
                        { $set: { 'gachaDailyPulls.bronze': 0, 'gachaDailyPulls.silver': 0, 'gachaDailyPulls.lastReset': todayMs } }
                    );
                    user = await User.findOne({ userId: originalAuthor.id });
                }

                const currentPulls = user.gachaDailyPulls?.[tier] || 0;
                const maxPulls = limits[tier];
                const remaining = maxPulls - currentPulls;

                if (remaining <= 0) {
                    const msg = `🚫 You've already used all **${maxPulls}** of your daily ${tier} pulls! You're too rich to be spamming cheap boxes all day, baka! Go buy Gold boxes like the whale you are! (¬_¬)`;
                    if (isInteraction) return context.reply({ content: msg, ephemeral: true });
                    return context.reply(msg);
                }

                if (pullCount > remaining) {
                    const msg = `🚫 You only have **${remaining}** ${tier} pull${remaining !== 1 ? 's' : ''} left today (limit: ${maxPulls}/day)! D-Don't look at me like that, it's not my fault you're rich! (¬_¬)`;
                    if (isInteraction) return context.reply({ content: msg, ephemeral: true });
                    return context.reply(msg);
                }
            }
        }

        const goldPrice = Math.floor(Math.min(config.GACHA_BOX_PRICES.gold.MAX || Infinity, config.GACHA_BOX_PRICES.gold.BASE + user.coins * config.GACHA_BOX_PRICES.gold.WALLET_RATE));
        const costs = { bronze: config.GACHA_BOX_PRICES.bronze, silver: config.GACHA_BOX_PRICES.silver, gold: goldPrice };
        const cost = costs[tier];
        const pityLabels = { bronze: 'Rare', silver: 'Rare', gold: 'Legendary' };

        // --- GACHA BOX CONSUMPTION (single-pull only, atomic) ---
        let usedBox = false;
        const boxMap = { silver: 'Silver Gacha Box', gold: 'Gold Gacha Box' };
        if (pullCount === 1 && boxMap[tier]) {
            const boxName = boxMap[tier];
            // Atomic: finds user with this box AND marks the first match as null in one op.
            // Two concurrent requests can't consume the same element.
            const boxResult = await User.findOneAndUpdate(
                { userId: originalAuthor.id, inventory: boxName },
                { $unset: { 'inventory.$': 1 }, $inc: { gachaBoxesOpened: 1 } },
                { new: true }
            );
            if (boxResult) {
                // Clean up the null left by $unset (cosmetic, not race-critical)
                await User.updateOne({ userId: originalAuthor.id }, { $pull: { inventory: null } });
                usedBox = true;
                user = boxResult;
                // Increment daily pull counter even for box usage (anti-exploit)
                if (limits && limits[tier] !== undefined) {
                    const boxWealth = (user.coins || 0) + (user.vaultCoins || 0);
                    if (boxWealth >= limits.WEALTH_THRESHOLD) {
                        await User.findOneAndUpdate(
                            { userId: originalAuthor.id },
                            { $inc: { [`gachaDailyPulls.${tier}`]: pullCount } }
                        );
                    }
                }
            }
        }

        let totalCost;
        if (usedBox) {
            totalCost = 0;
        } else if (pullCount === 10 && tier === 'gold') {
            totalCost = Math.floor(cost * 10 * 0.95);
        } else {
            totalCost = cost * pullCount;
        }

        if (!usedBox && user.coins < totalCost) {
            const msg = `🚫 You need **${totalCost.toLocaleString('en-US')}** coins for ${pullCount}x ${tier} box${pullCount > 1 ? 'es' : ''}! You only have **${user.coins.toLocaleString('en-US')}**. Stop being poor! (¬_¬)`;
            if (isInteraction) return context.reply({ content: msg, ephemeral: true });
            return context.reply(msg);
        }

        // DEDUCT COST (atomic) — skip if box was consumed
        // Also atomically increment daily pull counter for rich players
        if (!usedBox) {
            const incFields = { coins: -totalCost, systemSpent: totalCost, gachaBoxesOpened: pullCount, gachaTotalSpent: totalCost };
            // Atomically increment daily counter alongside cost deduction (prevents race condition)
            if (limits && limits[tier] !== undefined) {
                const deductWealth = (user.coins || 0) + (user.vaultCoins || 0);
                if (deductWealth >= limits.WEALTH_THRESHOLD) {
                    incFields[`gachaDailyPulls.${tier}`] = pullCount;
                }
            }
            const gachaDeduct = await User.findOneAndUpdate(
                { userId: originalAuthor.id, coins: { $gte: totalCost } },
                { $inc: incFields },
                { new: true }
            );
            if (!gachaDeduct) {
                const msg = `🚫 You need **${totalCost.toLocaleString('en-US')}** coins for ${pullCount}x ${tier} box${pullCount > 1 ? 'es' : ''}! You only have **${user.coins.toLocaleString('en-US')}**. Stop being poor! (¬_¬)`;
                if (isInteraction) return context.reply({ content: msg, ephemeral: true });
                return context.reply(msg);
            }
            user = gachaDeduct;
        }

        // === ROLL + DISTRIBUTE REWARDS BEFORE ANIMATION ===
        // This guarantees rewards are granted even if the animation/display fails
        let ultraRarePity = user.gachaPity?.[tier] || 0;
        let mythicPity = (tier === 'gold') ? (user.gachaPity?.goldMythic || 0) : 0;
        const results = [];
        let bestRarity = user.bestGachaDrop || null;
        const rarityOrder = ['COMMON', 'RARE', 'LEGENDARY', 'ULTRA_RARE', 'MYTHIC'];

        for (let i = 0; i < pullCount; i++) {
            ultraRarePity++;
            if (tier === 'gold') mythicPity++;

            const isUltraRarePity = ultraRarePity >= config.GACHA_PITY.ULTRA_RARE_THRESHOLD;
            const isMythicPity = (tier === 'gold') && mythicPity >= config.GACHA_PITY.MYTHIC_HARD_PITY;

            // Mythic hard pity overrides ultra rare pity
            const result = rollGacha(tier, isUltraRarePity && !isMythicPity, isMythicPity, mythicPity, user);
            result.wasPity = isUltraRarePity || isMythicPity;
            result.wasMythicPity = isMythicPity;

            // Reset counters based on what ACTUALLY dropped (mid-loop)
            if (['ULTRA_RARE', 'MYTHIC'].includes(result.rarity)) ultraRarePity = 0;
            else if (isUltraRarePity) ultraRarePity = 0;
            // Only mythic TITLES reset mythic pity — items like Slave Snatcher don't
            if (result.rarity === 'MYTHIC' && result.type === 'title') mythicPity = 0;
            else if (isMythicPity) mythicPity = 0;

            const currentBestIndex = bestRarity ? rarityOrder.indexOf(bestRarity) : -1;
            const newRarityIndex = rarityOrder.indexOf(result.rarity);
            if (newRarityIndex > currentBestIndex) bestRarity = result.rarity;

            // Add featured tag to extra text
            if (result.isFeatured) result.featuredTag = ' 🔥 **FEATURED!**';

            if (result.type === 'coins') {
                const log = await distributeIncome(originalAuthor.id, result.value);
                result.extra = log;
            } else if (result.type === 'nugget') {
                await User.updateOne({ userId: originalAuthor.id }, { $inc: { nuggets: result.value } });
                result.extra = " 💎";
            } else if (result.type === 'item') {
                await User.findOneAndUpdate({ userId: originalAuthor.id }, { $push: { inventory: result.item } });
                result.extra = " ✅";
            } else if (result.type === 'title') {
                const freshUser = await User.findOne({ userId: originalAuthor.id });
                if (!freshUser.inventory.includes(result.item)) {
                    await User.findOneAndUpdate({ userId: originalAuthor.id }, { $push: { inventory: result.item } });
                    result.extra = " ✅";
                } else {
                    const fallbackCoins = config.DUPLICATE_FALLBACK[result.rarity] || 8000;
                    const incomeLog = await distributeIncome(originalAuthor.id, fallbackCoins);
                    result.extra = ` ♻️ DUP → ${fallbackCoins.toLocaleString('en-US')}c${incomeLog}`;
                    result.item = `~~${result.item}~~`;
                }
            }
            results.push(result);
        }

        // Save pity + best drop (includes goldMythic for Gold tier)
        const pityUpdate = { [`gachaPity.${tier}`]: ultraRarePity };
        if (tier === 'gold') pityUpdate['gachaPity.goldMythic'] = mythicPity;
        if (bestRarity !== user.bestGachaDrop) pityUpdate.bestGachaDrop = bestRarity;
        await User.findOneAndUpdate({ userId: originalAuthor.id }, { $set: pityUpdate });

        // Mythic announcement (fire-and-forget)
        const generalChannel = guild.channels.cache.find(c => c.name === config.CHANNELS.GENERAL);
        if (generalChannel) {
            let postedMythic = false;
            for (const r of results) {
                // Only announce NEW mythic titles — skip duplicates (♻️ DUP)
                if (r.rarity === 'MYTHIC' && !postedMythic && !r.extra?.includes('DUP')) {
                    postedMythic = true;
                    const mythicEmbed = new EmbedBuilder()
                        .setColor(0xFF0000)
                        .setTitle('🚨 MYTHIC DROP')
                        .setDescription(`<@${originalAuthor.id}> just pulled **${r.item}** from a ${tier.charAt(0).toUpperCase() + tier.slice(1)} Box!! I-I'm not impressed!! ...okay maybe a little. >////<`);
                    generalChannel.send({ embeds: [mythicEmbed] }).catch(console.error);
                }
            }
        }

        // Re-fetch user for display
        user = await User.findOne({ userId: originalAuthor.id });

        // === ANIMATION + DISPLAY (rewards already granted above) ===
        const tierEmojis = { bronze: '💰', silver: '💎', gold: '👑' };
        let messageRef = null; // Tracks the message object for subsequent edits

        const sendUpdate = async (payload) => {
            try {
                if (isInteraction) {
                    if (!context.replied && !context.deferred) {
                        await context.update(payload);
                        messageRef = context.message;
                    } else if (messageRef) {
                        await messageRef.edit(payload);
                    } else {
                        await context.editReply(payload);
                    }
                } else {
                    if (!messageRef) {
                        messageRef = await context.reply(payload);
                    } else {
                        await messageRef.edit(payload);
                    }
                }
            } catch (err) {
                console.error('Gacha sendUpdate failed (rewards already granted):', err.message);
            }
        };

        await sendUpdate({ content: `${tierEmojis[tier]} **Opening ${pullCount}x ${tier.toUpperCase()} box${pullCount > 1 ? 'es' : ''}...**\n*The air crackles with anticipation...*`, embeds: [], components: [] });
        await new Promise(r => setTimeout(r, 2000));
        await sendUpdate({ content: `${tierEmojis[tier]} **Opening ${pullCount}x ${tier.toUpperCase()} box${pullCount > 1 ? 'es' : ''}...**\n✨ *Something glimmers inside...*`, embeds: [], components: [] });
        await new Promise(r => setTimeout(r, 2000));

        // Build final embed with progress bars
        const buildBar = (current, max) => {
            const filled = Math.min(Math.round((current / max) * 10), 10);
            return '█'.repeat(filled) + '░'.repeat(10 - filled);
        };
        const rarityColors = { COMMON: 0x808080, RARE: 0x0099FF, LEGENDARY: 0xFFD700, ULTRA_RARE: 0x9B59B6, MYTHIC: 0xFF0000 };
        const rarityEmojis = { COMMON: '⚪', RARE: '🔵', LEGENDARY: '🟡', ULTRA_RARE: '🟣', MYTHIC: '🔴' };

        // Build pity display string for embeds
        let pityDisplay;
        if (tier === 'gold') {
            pityDisplay =
                `🎯 **UR Pity:** ${ultraRarePity}/${config.GACHA_PITY.ULTRA_RARE_THRESHOLD} [${buildBar(ultraRarePity, config.GACHA_PITY.ULTRA_RARE_THRESHOLD)}]` +
                ` | 🔥 **Mythic:** ${mythicPity}/${config.GACHA_PITY.MYTHIC_HARD_PITY} [${buildBar(mythicPity, config.GACHA_PITY.MYTHIC_HARD_PITY)}]`;
        } else {
            pityDisplay = `🎯 **Pity:** ${ultraRarePity}/${config.GACHA_PITY.ULTRA_RARE_THRESHOLD} [${buildBar(ultraRarePity, config.GACHA_PITY.ULTRA_RARE_THRESHOLD)}] — next Rare+`;
        }

        let finalEmbed;
        if (pullCount === 1) {
            const result = results[0];
            finalEmbed = new EmbedBuilder()
                .setColor(rarityColors[result.rarity])
                .setTitle(`${rarityEmojis[result.rarity]} **${result.rarity} DROP!**`)
                .setDescription(
                    `**You won:** ${result.item}${result.extra || ''}${result.featuredTag || ''}\n\n` +
                    `💳 **New Balance:** ${user.coins.toLocaleString('en-US')} Coins\n` +
                    `📦 **Boxes Opened:** ${user.gachaBoxesOpened}\n` +
                    pityDisplay +
                    (result.wasPity ? '\n🎁 **PITY TRIGGERED!** Guaranteed drop!' : '') +
                    (result.wasMythicPity ? ' 🔥 **HARD PITY!**' : '')
                )
                .setFooter({ text: `Best Drop: ${user.bestGachaDrop || 'None yet'} | Total Spent: ${user.gachaTotalSpent.toLocaleString('en-US')}` });
        } else {
            const highestRarity = results.reduce((best, r) => rarityOrder.indexOf(r.rarity) > rarityOrder.indexOf(best) ? r.rarity : best, 'COMMON');
            const resultLines = results.map((r, i) => `${rarityEmojis[r.rarity]} **${i + 1}.** ${r.item}${r.extra || ''}${r.featuredTag || ''}${r.wasPity ? ' 🎁' : ''}`).join('\n');
            const discountNote = tier === 'gold' ? ' *(5% discount!)*' : '';
            finalEmbed = new EmbedBuilder()
                .setColor(rarityColors[highestRarity])
                .setTitle(`${tierEmojis[tier]} **10x ${tier.toUpperCase()} PULL!**`)
                .setDescription(
                    `💸 **Cost:** ${totalCost.toLocaleString('en-US')} Coins${discountNote}\n\n` +
                    `${resultLines}\n\n` +
                    `💳 **New Balance:** ${user.coins.toLocaleString('en-US')} Coins\n` +
                    `📦 **Boxes Opened:** ${user.gachaBoxesOpened}\n` +
                    pityDisplay
                )
                .setFooter({ text: `Best Drop: ${user.bestGachaDrop || 'None yet'} | Total Spent: ${user.gachaTotalSpent.toLocaleString('en-US')}` });
        }

        // Action Row for Pull Again
        const rowButtons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`gacha_pull_1_${tier}_${originalAuthor.id}`).setLabel('Pull 1x Again').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`gacha_pull_10_${tier}_${originalAuthor.id}`).setLabel('Pull 10x Again').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`gacha_dashboard_${originalAuthor.id}`).setLabel('Dashboard').setStyle(ButtonStyle.Secondary)
        );

        await sendUpdate({ content: null, embeds: [finalEmbed], components: [rowButtons] });
    } finally {
        global.gachaInProgress.delete(originalAuthor.id);
    }
}

// ==========================================
// RUSSIAN ROULETTE — HELPER FUNCTIONS
// ==========================================

const RR_CYLINDER = (bullets) => {
    const chambers = [];
    for (let i = 0; i < 6; i++) chambers.push(i < bullets ? '💀' : '⬜');
    return `[ ${chambers.join(' | ')} ]`;
};

const RR_DEATH_MESSAGES = {
    1: "Pfft. One bullet and you couldn't dodge that? Absolutely pathetic. I expected nothing and I'm still disappointed. (¬_¬)",
    2: "Two bullets and you crumble? You barely even tried, baka. Don't come crying to me.",
    3: "50/50 and you picked wrong. Classic loser energy. I'm not even a little surprised. (¬_¬)",
    4: "You had **{pot}** in your greedy little hands and you STILL pushed?! You DESERVE this! Every. Single. Coin. GONE. (¬_¬)",
    5: "Five bullets... one empty chamber... and you STILL pulled the trigger?! You're either the bravest or the DUMBEST person alive. ...W-Was kinda cool though. >///< N-NOT THAT I CARE!",
};

const RR_SURVIVE_MESSAGES = {
    1: "*Click.* ...Obvious. Don't act all relieved, it was ONE bullet. Pathetic. (¬_¬)",
    2: "*Click.* Lucky. Don't let it go to your head, you're still an idiot for playing. (¬_¬)",
    3: "*Click.* ...50/50 and you lived. Even I'll admit that's... m-mildly impressive. Just mildly! (¬_¬)",
    4: "*Click.* ...I c-can't believe you survived that. My heart was— I MEAN, whatever! D-Don't look at me like that! >///< ",
    5: "***Click.*** ...WHAT?! FIVE BULLETS AND YOU LIVED?! That's... that's IMPOSSIBLE! I... >///< **JACKPOT CLAIMED!!**",
};

const RR_ROUND_COLORS = {
    1: 0x2ECC71,  // Green
    2: 0x27AE60,  // Darker green
    3: 0xF39C12,  // Orange (tension rising)
    4: 0xE74C3C,  // Red (danger zone)
    5: 0x9B59B6,  // Purple (legendary territory)
};

function formatMuteTime(seconds) {
    if (seconds <= 0) return null;
    if (seconds >= 3600) return `${seconds / 3600} Hour${seconds >= 7200 ? 's' : ''}`;
    return `${seconds / 60} Min${seconds >= 120 ? 's' : ''}`;
}

async function playRouletteRound(context, game, isInteraction) {
    const roundConfig = config.ROULETTE.ROUNDS[game.round];
    if (!roundConfig) {
        // Safety fallback — shouldn't happen
        rrGames.delete(game.userId);
        const fallbackMsg = "S-Something went wrong with the cylinder... Game cancelled, your bet was returned! >///< ";
        await User.findOneAndUpdate({ userId: game.userId }, { $inc: { coins: game.bet, systemSpent: -game.bet } });
        if (isInteraction) return context.update({ content: fallbackMsg, embeds: [], components: [] });
        return context.reply(fallbackMsg);
    }

    // --- STEP 1: Spinning animation ---
    const spinContent = `🔫 **══ ROUND ${game.round} ══** 🔫\n` +
        `${RR_CYLINDER(roundConfig.bullets)}\n` +
        `💰 Bet: **${game.bet.toLocaleString('en-US')}** | Pot: **${Math.floor(game.bet * roundConfig.mult).toLocaleString('en-US')}** (${roundConfig.mult}x)\n\n` +
        `*The cylinder spins... your hand trembles...*`;

    try {
        if (isInteraction) {
            await context.update({ content: spinContent, embeds: [], components: [] });
            game.messageRef = context.message;
        } else {
            game.messageRef = await context.reply({ content: spinContent });
        }
    } catch (err) {
        console.error('[RR] Failed to send spin message:', err);
        rrGames.delete(game.userId);
        await User.findOneAndUpdate({ userId: game.userId }, { $inc: { coins: game.bet, systemSpent: -game.bet } });
        return;
    }

    // --- STEP 2: Suspense delay ---
    await new Promise(r => setTimeout(r, 1500));

    // --- STEP 3: "Click..." or "BANG" teaser ---
    const dead = Math.floor(Math.random() * 6) < roundConfig.bullets;

    const teaserContent = `🔫 **══ ROUND ${game.round} ══** 🔫\n` +
        `${RR_CYLINDER(roundConfig.bullets)}\n\n` +
        (dead ? `💥 ***...BANG.***` : `🔫 ***...Click.***`);

    try {
        await game.messageRef.edit({ content: teaserContent, embeds: [], components: [] });
    } catch (err) {
        console.error('[RR] Failed to edit teaser:', err);
    }

    await new Promise(r => setTimeout(r, 1500));

    // --- STEP 4: Resolve ---
    if (dead) {
        await rouletteDeath(game, roundConfig);
    } else {
        // Round 5 survival = auto-cashout + jackpot
        if (game.round >= 5) {
            await rouletteCashout(game, 'round5');
            return;
        }

        // Build survival embed
        const pot = Math.floor(game.bet * roundConfig.mult);
        const nextRound = config.ROULETTE.ROUNDS[game.round + 1];
        const nextSurvival = Math.round(((6 - nextRound.bullets) / 6) * 100);

        const surviveEmbed = new EmbedBuilder()
            .setColor(RR_ROUND_COLORS[game.round])
            .setTitle(`✅ ROUND ${game.round} — SURVIVED`)
            .setDescription(
                `${RR_SURVIVE_MESSAGES[game.round]}\n\n` +
                `💰 **Current Pot:** ${pot.toLocaleString('en-US')} (${roundConfig.mult}x)\n` +
                `🔫 **Next Round:** ${nextRound.bullets} bullets loaded (${nextSurvival}% survival)\n` +
                `💀 **Next Pot:** ${Math.floor(game.bet * nextRound.mult).toLocaleString('en-US')} (${nextRound.mult}x)\n\n` +
                `🎰 **Jackpot Pool:** ${game.jackpotDisplay.toLocaleString('en-US')} *(survive all 5 to claim!)*`
            )
            .setFooter({ text: `Bet: ${game.bet.toLocaleString('en-US')} | You have ${config.ROULETTE.BUTTON_TIMEOUT / 1000}s to decide or I'm cashing you out!` });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`rr_cashout_${game.userId}`)
                .setLabel(`💰 Cash Out (${pot.toLocaleString('en-US')})`)
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`rr_continue_${game.userId}`)
                .setLabel(`🔫 Spin Again (Round ${game.round + 1})`)
                .setStyle(ButtonStyle.Danger)
        );

        try {
            await game.messageRef.edit({ content: null, embeds: [surviveEmbed], components: [row] });
        } catch (err) {
            console.error('[RR] Failed to show survival embed:', err);
            // Fallback: cashout the player safely
            await rouletteCashout(game, 'manual');
            return;
        }

        // Auto-cashout timeout
        game.autoTimeout = setTimeout(async () => {
            const activeGame = rrGames.get(game.userId);
            if (!activeGame || activeGame !== game) return; // Game already resolved
            await rouletteCashout(game, 'timeout');
        }, config.ROULETTE.BUTTON_TIMEOUT);

        // Refresh TTL so cleaningMap doesn't evict during gameplay
        rrGames.set(game.userId, game);
    }
}

async function rouletteDeath(game, roundConfig) {
    rrGames.delete(game.userId);

    // --- Mute (if applicable) ---
    let timeoutSuccess = false;
    let muteImmune = false;
    try {
        // Resolve guild from message reference
        const guild = game.messageRef?.guild || game.messageRef?.channel?.guild || null;

        if (guild && roundConfig.muteTime > 0) {
            const member = await guild.members.fetch(game.userId).catch(() => null);
            if (member && member.manageable) {
                // Strip privileged roles so mute works
                await roleSync.stripPrivilegedRoles(guild, game.userId);
                try {
                    await member.timeout(roundConfig.muteTime * 1000, `Lost Roulette at Round ${game.round}`);
                    timeoutSuccess = true;
                    // Schedule role restore
                    setTimeout(async () => {
                        await roleSync.restorePrivilegedRoles(guild, game.userId).catch(() => {});
                    }, roundConfig.muteTime * 1000);
                } catch (timeoutErr) {
                    console.error('[RR] Mute failed (likely Admin):', timeoutErr.message);
                    await roleSync.restorePrivilegedRoles(guild, game.userId).catch(() => {});
                    muteImmune = true;
                }
            } else if (member) {
                // Member exists but role is too high to manage
                muteImmune = true;
            }
        }
    } catch (e) {
        console.error('[RR] Death mute error:', e);
    }

    // --- Update stats ---
    // rrHighestRound tracks the highest round SURVIVED, not died at
    const highestSurvived = game.round - 1;
    const statUpdate = {
        $inc: {
            rrGamesPlayed: 1,
            rrDeaths: 1,
            rrTotalWagered: game.bet,
        }
    };
    const currentUser = await User.findOne({ userId: game.userId }).select('rrHighestRound coins').lean();
    if (highestSurvived > (currentUser?.rrHighestRound || 0)) {
        statUpdate.$set = { rrHighestRound: highestSurvived };
    }
    await User.findOneAndUpdate({ userId: game.userId }, statUpdate).catch(e => console.error('[RR] Stats update failed:', e));

    // --- Death embed ---
    const muteDisplay = roundConfig.muteTime > 0
        ? (timeoutSuccess ? formatMuteTime(roundConfig.muteTime) : (muteImmune ? 'Immune! Tch, lucky punk. (¬_¬)' : null))
        : null;

    const deathMessage = RR_DEATH_MESSAGES[game.round].replace('{pot}', Math.floor(game.bet * roundConfig.mult).toLocaleString('en-US'));

    const freshUser = await User.findOne({ userId: game.userId });
    const bestRound = Math.max(freshUser?.rrHighestRound || 0, highestSurvived);

    const deathEmbed = new EmbedBuilder()
        .setColor(0x000000)
        .setTitle(`💥 DEAD — Round ${game.round}`)
        .setDescription(
            `${deathMessage}\n\n` +
            `💸 **Lost:** ${game.bet.toLocaleString('en-US')} coins\n` +
            (muteDisplay ? `🤐 **Muted:** ${muteDisplay}\n` : '') +
            (muteImmune && !timeoutSuccess ? `⚠️ *Your role is too high for my mute magic, but your coins are still GONE! (¬_¬)*\n` : '') +
            `💳 **Balance:** ${(freshUser?.coins || 0).toLocaleString('en-US')} coins\n\n` +
            `📊 **Stats:** ${freshUser?.rrDeaths || 1} death${(freshUser?.rrDeaths || 1) !== 1 ? 's' : ''} | Best: Round ${bestRound}`
        )
        .setFooter({ text: "Type !rr <bet> to try again... if you dare. (¬_¬)" });

    try {
        await game.messageRef.edit({ content: null, embeds: [deathEmbed], components: [] });
    } catch (err) {
        console.error('[RR] Failed to show death embed:', err);
    }
}

async function rouletteCashout(game, reason) {
    // Clear auto-timeout if it exists
    if (game.autoTimeout) clearTimeout(game.autoTimeout);
    rrGames.delete(game.userId);

    const roundConfig = config.ROULETTE.ROUNDS[game.round];
    const pot = Math.floor(game.bet * roundConfig.mult);
    const profit = pot - game.bet;

    // --- Return original bet (critical — wrap in try/catch) ---
    try {
        await User.findOneAndUpdate(
            { userId: game.userId },
            { $inc: { coins: game.bet, systemSpent: -game.bet } }
        );
    } catch (e) {
        console.error(`[RR] CRITICAL: Failed to return bet for ${game.userId} (${game.bet}):`, e);
        // Don't abort — still try to distribute profit
    }

    // --- Distribute profit through income pipeline ---
    let log = '';
    let profitFailed = false;
    if (profit > 0) {
        try {
            log = await distributeIncome(game.userId, profit);
        } catch (e) {
            console.error(`[RR] distributeIncome failed for ${game.userId} (profit: ${profit}):`, e);
            profitFailed = true;
        }
    }

    // --- Jackpot claim (Round 5 only) ---
    let jackpotWon = 0;
    let jackpotLog = '';
    if (reason === 'round5') {
        try {
            const claimed = await ServerStats.findOneAndUpdate(
                { guildId: game.guildId },
                { $set: { rouletteJackpot: config.ROULETTE.JACKPOT_SEED } },
                { new: false } // Return the OLD document to get jackpot amount before reset
            );
            jackpotWon = claimed?.rouletteJackpot || 0;
            if (jackpotWon > 0) {
                try {
                    jackpotLog = await distributeIncome(game.userId, jackpotWon);
                } catch (jpErr) {
                    console.error(`[RR] Jackpot distributeIncome failed for ${game.userId} (${jackpotWon}):`, jpErr);
                    // Fallback: direct $inc so the player doesn't lose the jackpot entirely
                    await User.findOneAndUpdate({ userId: game.userId }, { $inc: { coins: jackpotWon } }).catch(() => {});
                    jackpotLog = ' ⚠️ *(direct deposit — taxes skipped)*';
                }
                // Track jackpot win
                await User.findOneAndUpdate({ userId: game.userId }, { $inc: { rrJackpotsWon: 1 } });
            }
        } catch (e) {
            console.error('[RR] Jackpot claim failed:', e);
        }
    }

    // --- Update stats ---
    const totalWon = pot + jackpotWon;
    const statUpdate = {
        $inc: {
            rrGamesPlayed: 1,
            rrTotalWagered: game.bet,
            rrTotalWon: totalWon,
        }
    };
    const currentUser = await User.findOne({ userId: game.userId }).select('rrHighestRound').lean();
    if (game.round > (currentUser?.rrHighestRound || 0)) {
        statUpdate.$set = { rrHighestRound: game.round };
    }
    await User.findOneAndUpdate({ userId: game.userId }, statUpdate).catch(e => console.error('[RR] Stats update failed:', e));

    const freshUser = await User.findOne({ userId: game.userId });

    // --- Build cashout embed ---
    let title, description, color;
    if (reason === 'round5') {
        color = 0xFF0000;
        title = '🏆 ROUND 5 CLEAR — LEGENDARY!! 🏆';
        description =
            `${RR_SURVIVE_MESSAGES[5]}\n\n` +
            `💰 **Pot:** ${pot.toLocaleString('en-US')} (${roundConfig.mult}x)${log}\n` +
            (jackpotWon > 0 ? `🎰 **JACKPOT:** +${jackpotWon.toLocaleString('en-US')}${jackpotLog}\n` : '') +
            `💳 **Balance:** ${(freshUser?.coins || 0).toLocaleString('en-US')} coins\n\n` +
            `📊 **Stats:** ${freshUser?.rrGamesPlayed || 1} games | Best: Round ${freshUser?.rrHighestRound || 5} | Jackpots: ${freshUser?.rrJackpotsWon || 1}`;
    } else if (reason === 'timeout') {
        color = 0xF39C12;
        title = `⏰ AUTO-CASHOUT — Round ${game.round}`;
        const timeoutMessages = [
            "Tch. Too slow! I cashed you out before you wasted my time any longer. (¬_¬)",
            "Hello?! Earth to baka?! I grabbed your coins before they disappeared! You're WELCOME! (¬_¬)",
            "You froze up like a scared kitten! I-I saved your money, not that you deserve it! >///< ",
        ];
        description =
            `${timeoutMessages[Math.floor(Math.random() * timeoutMessages.length)]}\n\n` +
            `💰 **Payout:** ${pot.toLocaleString('en-US')} (${roundConfig.mult}x)${log}\n` +
            `📈 **Profit:** +${profit.toLocaleString('en-US')}\n` +
            `💳 **Balance:** ${(freshUser?.coins || 0).toLocaleString('en-US')} coins` +
            (profitFailed ? `\n\n⚠️ *S-Something hiccuped with your profit... your stake was returned though! Tell the owner if coins are missing! >///< *` : '');
    } else {
        // Manual cashout
        color = 0xFFD700;
        title = `💰 CASHED OUT — Round ${game.round}`;
        const cashoutMessages = {
            1: "One round and you're already running? Coward. ...S-Smart coward, though. (¬_¬)",
            2: "Cashing out at 3x? Boring but rational. I g-guess you're not completely stupid. (¬_¬)",
            3: "6x and you walked away from the table. Respectable. N-Not that I was worried or anything! >///< ",
            4: "12x?! You walked away from 25x for THIS?! ...O-Okay fine, that's actually a lot of money. Smart. >///< ",
        };
        description =
            `${cashoutMessages[game.round] || "Hmph. Fine. Take your money and go. (¬_¬)"}\n\n` +
            `💰 **Payout:** ${pot.toLocaleString('en-US')} (${roundConfig.mult}x)${log}\n` +
            `📈 **Profit:** +${profit.toLocaleString('en-US')}\n` +
            `💳 **Balance:** ${(freshUser?.coins || 0).toLocaleString('en-US')} coins\n\n` +
            `📊 **Stats:** ${freshUser?.rrGamesPlayed || 1} games | Best: Round ${freshUser?.rrHighestRound || game.round}` +
            (profitFailed ? `\n\n⚠️ *S-Something hiccuped with your profit... your stake was returned though! Tell the owner if coins are missing! >///< *` : '');
    }

    const cashoutEmbed = new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(description)
        .setFooter({ text: "Type !rr <bet> to play again!" });

    try {
        await game.messageRef.edit({ content: null, embeds: [cashoutEmbed], components: [] });
    } catch (err) {
        console.error('[RR] Failed to show cashout embed:', err);
    }

    // --- Jackpot announcement in #general (fire-and-forget) ---
    if (reason === 'round5' && jackpotWon > 0) {
        try {
            const guild = game.messageRef?.channel?.guild;
            if (guild) {
                const generalChannel = guild.channels.cache.find(c => c.name === config.CHANNELS.GENERAL);
                if (generalChannel) {
                    const jpEmbed = new EmbedBuilder()
                        .setColor(0xFF0000)
                        .setTitle('🎰🔫 ROULETTE JACKPOT CLAIMED!!')
                        .setDescription(
                            `<@${game.userId}> survived ALL 5 ROUNDS of Russian Roulette and claimed the **${jackpotWon.toLocaleString('en-US')}** coin jackpot!!\n\n` +
                            `I-It's not like I'm impressed or anything... that was just pure luck! B-Baka! >///< `
                        );
                    generalChannel.send({ embeds: [jpEmbed] }).catch(() => {});
                }
            }
        } catch (e) {
            console.error('[RR] Jackpot announcement failed:', e);
        }
    }
}

module.exports = {
    handle: async (message, client) => {
        const cmd = message.content.toLowerCase().split(' ')[0];
        console.log(`ECONOMY: Handling ${cmd} for user ${message.author.id}`);
        console.log(`ECONOMY: Full message: ${message.content}`);

        let user = await User.findOne({ userId: message.author.id });
        if (!user) {
            console.log(`ECONOMY: Creating new user ${message.author.id}`);
            user = await User.create({ userId: message.author.id });
        }

        // --- !ISEKAI (PRESTIGE SYSTEM - MULTI LEVEL) ---
        if (cmd === '!isekai' || cmd === '!prestige') {
            // Removed hardcoded fib array
            const roles = ["Iron", "Bronze", "Silver", "Gold", "Platinum", "Diamond", "Master"];

            const currentLevel = user.prestige || 0;
            if (currentLevel >= 7) return message.reply("You're already at the top, baka! What more do you want from me?! (¬_¬)");
            const activeLoan = await Loan.findOne({ borrowerId: user.userId, status: { $in: ['ACTIVE', 'DEFAULTED'] } });
            if (activeLoan) return message.reply("Truck-kun doesn't pick up deadbeats. Repay your loans first, baka.");
            if (user.isSlave) return message.reply("A slave dreaming of reincarnation? Cute. Buy your freedom first, baka.");

            // 1. Calculate Max Reachable Level
            let reachableLevel = currentLevel;
            let accumulatedCost = 0;
            let remainingCoins = user.coins;

            // Loop to see how many levels we can buy
            const hasDiscount = user.isekaiDiscountActive;
            for (let i = currentLevel; i < 7; i++) {
                const levelCost = hasDiscount
                    ? Math.floor(config.ECONOMY.PRESTIGE_COSTS[i] * 0.75)
                    : config.ECONOMY.PRESTIGE_COSTS[i];
                if (remainingCoins >= levelCost) {
                    accumulatedCost += levelCost;
                    remainingCoins -= levelCost;
                    reachableLevel++;
                } else {
                    break;
                }
            }

            // 2. Check if they can afford even ONE level
            if (reachableLevel === currentLevel) {
                // Already at max level check (safety net in case first check was bypassed)
                if (currentLevel >= 7) {
                    return message.reply("🌟 **You're already maxed out!**\n*D-Don't think this makes you special or anything, baka! (¬_¬)*");
                }
                const nextCost = config.ECONOMY.PRESTIGE_COSTS[currentLevel];
                const nextRoleName = roles[currentLevel];
                return message.reply(`🚚 **Truck-kun is ignoring you.**\nYou need **${nextCost.toLocaleString('en-US')} Coins** to reach **${nextRoleName}**.\nCurrent Balance: ${user.coins.toLocaleString('en-US')}`);
            }

            // 4. Prepare Data for Embed
            const targetRole = roles[reachableLevel - 1];
            const levelsGained = reachableLevel - currentLevel;
            const wastedAmount = user.coins - accumulatedCost; // The "Change" that gets burned

            const embed = new EmbedBuilder()
                .setColor(0xFFFFFF)
                .setTitle("🚚 THE TRUCK APPROACHES...")
                .setDescription(
                    `Are you ready to throw it all away?\n\n` +
                    `**CURRENT RANK:** ${currentLevel === 0 ? "None" : roles[currentLevel - 1]}\n` +
                    `**TARGET RANK:** ${targetRole} (+${levelsGained} Levels)\n` +
                    `**TOTAL COST:** ${accumulatedCost.toLocaleString('en-US')} Coins\n` +
                    `**REMAINDER:** ${wastedAmount.toLocaleString('en-US')} Coins *(also burned — everything resets to 0)*\n\n` +
                    `*Everything (Coins, Inventory, Bounty) will be wiped.*`
                );

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`isekai_confirm_${message.author.id}`).setLabel(`JUMP to ${targetRole}!`).setStyle(ButtonStyle.Danger).setEmoji('🚚'),
                new ButtonBuilder().setCustomId(`isekai_cancel_${message.author.id}`).setLabel('Step Back').setStyle(ButtonStyle.Secondary)
            );

            return message.reply({ embeds: [embed], components: [row] });
        }

        // --- !BOUNTY (The PvP Sink) ---
        if (cmd === '!bounty' || cmd === '!wanted') {
            const args = message.content.split(' ');
            const sub = args[1]?.toLowerCase();

            // 1. VIEW WANTED LIST
            if (!sub || sub === 'list' || sub === 'top') {
                const bounties = await User.find({ bounty: { $gt: 0 } }).sort({ bounty: -1 }).limit(10);
                if (bounties.length === 0) return message.reply("🕊️ Peace... for now. No active bounties.");

                const desc = await Promise.all(bounties.map(async (u, i) => {
                    const name = await getDisplayName(u.userId, message.guild);
                    return `**${i + 1}. ${name}** — 🎯 **${u.bounty.toLocaleString('en-US')}** c`;
                }));

                const embed = new EmbedBuilder()
                    .setColor(0x8B0000) // Blood Red
                    .setTitle("📜 WANTED LIST")
                    .setDescription(desc.join('\n') || "None.")
                    .setFooter({ text: "Win a !duel against them to claim their bounty!" });
                return message.reply({ embeds: [embed] });
            }

            // 2. REMOVE BOUNTY (New Feature)
            if (sub === 'remove') {
                const target = message.mentions.users.first();
                if (!target) return message.reply("H-Hah? Remove bounty from who? The air? Tag someone! (¬_¬)");

                const targetUser = await User.findOne({ userId: target.id });
                if (!targetUser || !targetUser.activeBounties || targetUser.activeBounties.length === 0) {
                    return message.reply("They don't have any active bounties! Are you hallucinating?");
                }

                // Calculate refund from current snapshot
                let refundAmount = 0;
                targetUser.activeBounties.forEach(b => {
                    if (b.placerId === message.author.id) {
                        refundAmount += b.amount;
                    }
                });

                if (refundAmount === 0) return message.reply("You haven't placed any bounties on them! Stop trying to take credit for others' work! >///< ");

                // Atomic: pull my bounties from target, decrement their bounty total
                await User.findOneAndUpdate(
                    { userId: target.id },
                    {
                        $pull: { activeBounties: { placerId: message.author.id } },
                        $inc: { bounty: -refundAmount }
                    }
                );

                // Atomic: refund my coins
                await User.findOneAndUpdate(
                    { userId: message.author.id },
                    { $inc: { coins: refundAmount } }
                );

                return message.reply(`Hmph. Fine. I returned **${refundAmount}** coins to you. **${target.username}** is slightly safer now. Happy? (¬_¬)`);
            }

            // 3. PLACE BOUNTY
            const target = message.mentions.users.first();
            const amount = parseInt(args[2]);

            if (!target) return message.reply("Usage: `!bounty @user <amount>` or `!bounty remove @user`");
            if (target.id === message.author.id) return message.reply("Putting a hit on yourself? Wow, dramatic much. Go seek attention somewhere else.");
            if (target.bot) return message.reply("M-Me? Invincible, obviously. Don't waste your money trying, baka.");

            if (isNaN(amount) || amount < 1000) return message.reply("Minimum bounty is **1,000** coins. Don't be this cheap.");
            if (user.coins < amount) return message.reply(`You're too broke for revenge. Balance: ${user.coins}`);

            // 4. TRANSACTION
            const taxRate = 0.20;
            const tax = Math.floor(amount * taxRate);
            const reward = amount - tax;

            const targetUser = await User.findOne({ userId: target.id }) || await User.create({ userId: target.id });

            // BOUNTY SHIELD CHECK
            if (targetUser.bountyShieldExpiry > Date.now()) {
                const remaining = targetUser.bountyShieldExpiry - Date.now();
                const hours = Math.floor(remaining / 3600000);
                const mins = Math.floor((remaining % 3600000) / 60000);
                return message.reply(`🛡️ <@${target.id}> has a Bounty Shield! Can't place bounties on them for **${hours}h ${mins}m**. (¬_¬)`);
            }

            // Atomic deduction from placer
            const deducted = await User.findOneAndUpdate(
                { userId: message.author.id, coins: { $gte: amount } },
                { $inc: { coins: -amount, systemSpent: tax } },
                { new: true }
            );
            if (!deducted) return message.reply(`You're too broke for revenge. Balance: ${user.coins}`);
            user = deducted;

            // Atomic update on target: add bounty + tracking
            await User.findOneAndUpdate(
                { userId: target.id },
                {
                    $inc: { bounty: reward },
                    $push: { activeBounties: { placerId: message.author.id, amount: reward } }
                },
                { upsert: true }
            );
            // Re-fetch target for embed display
            const updatedTarget = await User.findOne({ userId: target.id });

            // 5. ANNOUNCEMENT
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle("🎯 CONTRACT KILLING")
                .setDescription(`**${message.author.username}** put a hit on **${target.username}**!`)
                .addFields(
                    { name: '💵 Paid', value: `${amount.toLocaleString('en-US')}`, inline: true },
                    { name: '🔥 Tax Burned', value: `${tax.toLocaleString('en-US')}`, inline: true },
                    { name: '💀 Reward Added', value: `${reward.toLocaleString('en-US')}`, inline: true },
                    { name: '🩸 Total Bounty', value: `${updatedTarget.bounty.toLocaleString('en-US')}`, inline: false }
                )
                .setThumbnail(target.displayAvatarURL())
                .setFooter({ text: "Next person to win a !duel against them gets the cash!" });

            return message.reply({ embeds: [embed] });
        }

        // --- !ROULETTE (MULTI-ROUND PROGRESSIVE) ---
        if (cmd === '!roulette' || cmd === '!rr') {
            const args = message.content.split(' ');
            const betArg = args[1]?.toLowerCase();
            const bet = betArg === 'all' ? Math.min(user.coins, config.ROULETTE.MAX_BET) : parseInt(args[1]);

            // Validation
            if (isNaN(bet) || bet < config.ROULETTE.MIN_BET) return message.reply(`Min bet: **${config.ROULETTE.MIN_BET.toLocaleString('en-US')}** coins. Stop trembling and bet properly, baka! (¬_¬)`);
            if (bet > config.ROULETTE.MAX_BET) return message.reply(`Max bet is **${config.ROULETTE.MAX_BET.toLocaleString('en-US')}** coins! Even I think that's reckless! (¬_¬)`);
            if (user.coins < bet) return message.reply(`You have **${user.coins.toLocaleString('en-US')}** coins. You're too broke to gamble, pathetic. (¬_¬)`);
            if (rrGames.get(message.author.id)) return message.reply("You're already in a game! Finish that one first, you scatterbrain! (¬_¬)");

            // Deduct bet atomically
            const deducted = await User.findOneAndUpdate(
                { userId: message.author.id, coins: { $gte: bet } },
                { $inc: { coins: -bet, systemSpent: bet } },
                { new: true }
            );
            if (!deducted) return message.reply(`You're too broke! Balance: **${user.coins.toLocaleString('en-US')}**. Earn something first, baka! (¬_¬)`);

            // Feed jackpot pool (atomic, capped)
            const jackpotContrib = Math.floor(bet * config.ROULETTE.JACKPOT_CONTRIBUTION);
            if (jackpotContrib > 0) {
                await ServerStats.findOneAndUpdate(
                    { guildId: message.guild.id, rouletteJackpot: { $lt: config.ROULETTE.JACKPOT_CAP } },
                    { $inc: { rouletteJackpot: jackpotContrib } }
                ).catch(e => console.error('[RR] Jackpot contribution failed:', e));
            }

            // Fetch current jackpot for display
            const stats = await ServerStats.findOne({ guildId: message.guild.id }).catch(() => null);
            const jackpotAmount = stats?.rouletteJackpot || config.ROULETTE.JACKPOT_SEED;

            // Store game state
            const gameState = {
                userId: message.author.id,
                guildId: message.guild.id,
                bet,
                round: 1,
                messageRef: null,
                autoTimeout: null,
                channelId: message.channel.id,
                jackpotDisplay: jackpotAmount,
            };
            rrGames.set(message.author.id, gameState);

            // Play Round 1 automatically
            await playRouletteRound(message, gameState, false);
            return;
        }

        // --- !TAX (OWNER ONLY) ---
        if (cmd === '!tax') {
            // Owner check from centralized config
            if (message.author.id !== config.OWNER_ID) return message.reply("H-Hah? Only the Owner can tax people! Know your place! (¬_¬)");

            const args = message.content.split(' ');
            const amount = parseInt(args[2]);

            // 1. Check for ROLE mention
            const targetRole = message.mentions.roles.first();
            if (targetRole) {
                if (isNaN(amount) || amount < 1) return message.reply("Usage: `!tax @role <amount>`");

                // Fetch members to err on side of caution
                await message.guild.members.fetch();
                const role = message.guild.roles.cache.get(targetRole.id);
                const members = role.members.filter(m => !m.user.bot);

                if (members.size === 0) return message.reply("That role has no potential taxpayers! (¬_¬)");

                let totalSeized = 0;
                let victimCount = 0;

                const statusMsg = await message.reply(`📉 **IRS RAID IN PROGRESS...**\nTargeting **${members.size}** members of ${targetRole.name}...`);

                // Arrays to perform bulk write for better performance/safety if needed, but sequential is safer for now to avoid locking
                for (const [memberId, member] of members) {
                    try {
                        // Atomic tax: clamp to victim's balance, deduct atomically
                        const victim = await User.findOne({ userId: memberId });
                        if (victim && victim.coins > 0) {
                            const tax = Math.min(amount, victim.coins);
                            if (tax > 0) {
                                await User.findOneAndUpdate(
                                    { userId: memberId, coins: { $gte: tax } },
                                    { $inc: { coins: -tax, systemSpent: tax } }
                                );
                                totalSeized += tax;
                                victimCount++;
                            }
                        }
                    } catch (e) {
                        console.error(`Failed to tax ${memberId}:`, e);
                    }
                }

                const embed = new EmbedBuilder()
                    .setColor(0xFF0000)
                    .setTitle("📉 MASS MARKET CRASH (IRS RAID)")
                    .setDescription(
                        `**Target:** ${targetRole}\n` +
                        `**Victims:** ${victimCount} / ${members.size}\n` +
                        `**Total Seized:** ${totalSeized.toLocaleString('en-US')} Coins\n` +
                        `**Tax Per Head:** ${amount.toLocaleString('en-US')} Coins (capped at balance)`
                    )
                    .setFooter({ text: "Don't blame me, blame the economy! (¬_¬)" });

                return statusMsg.edit({ content: null, embeds: [embed] });
            }

            // 2. USER Mention (Legacy)
            const target = message.mentions.users.first();
            if (!target || isNaN(amount) || amount < 1) return message.reply("Usage: `!tax @user/@role <amount>`");

            const victim = await User.findOne({ userId: target.id });
            if (!victim || victim.coins <= 0) return message.reply("They're already broke. Nice target, genius.");

            if (amount > victim.coins) return message.reply(`They only have **${victim.coins.toLocaleString('en-US')}** coins! Can't squeeze blood from a stone, baka! (¬_¬)`);
            const tax = amount;
            await User.findOneAndUpdate(
                { userId: target.id, coins: { $gte: tax } },
                { $inc: { coins: -tax, systemSpent: tax } }
            );

            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle("📉 MARKET CRASH (IRS RAID)")
                .setDescription(`**Seized:** ${tax.toLocaleString('en-US')} Coins from <@${target.id}>\n**Remaining:** ${(victim.coins - tax).toLocaleString('en-US')}`)

            return message.reply({ embeds: [embed] });
        }

        // --- !free ---
        if (cmd === '!free') {
            const now = Date.now();

            // --- LAZY RICH COOLDOWNS ---
            // Poor (<100k): 1 Hour
            // Rich (>100k): 4 Hours
            // Millionaire (>1M): 12 Hours
            let cooldownTime = config.ECONOMY.FREE_COOLDOWN_BASE;
            if (user.coins > config.ECONOMY.FREE_COOLDOWN_MILLIONAIRE_THRESHOLD) cooldownTime = config.ECONOMY.FREE_COOLDOWN_MILLIONAIRE_MULTIPLIER * config.ECONOMY.FREE_COOLDOWN_BASE;
            else if (user.coins > config.ECONOMY.FREE_COOLDOWN_RICH_THRESHOLD) cooldownTime = config.ECONOMY.FREE_COOLDOWN_RICH_MULTIPLIER * config.ECONOMY.FREE_COOLDOWN_BASE;

            if (now - user.lastHourly < cooldownTime) {
                const readyAt = Math.floor((user.lastHourly + cooldownTime) / 1000);
                return message.reply(`D-Don't be such a greedy pig! You're rich enough! Come back <t:${readyAt}:R>, you degenerate! (¬_¬)`);
            }

            // (Keep your existing scaling reward logic...)
            const reward = Math.max(config.ECONOMY.HOURLY_MIN_REWARD, Math.floor(user.coins * config.ECONOMY.HOURLY_PERCENTAGE));
            const log = await distributeIncome(message.author.id, reward);

            // Atomic cooldown update (prevents stale .save() from overwriting distributeIncome's coin changes)
            await User.findOneAndUpdate(
                { userId: message.author.id },
                { $set: { lastHourly: now } }
            );
            return message.reply(`F-Fine, take this! 💰 **+${reward.toLocaleString('en-US')} Coins** added. Don't waste it on stupid shit, idiot! >///<${log}`);
        }

        // --- !DAILY ---
        if (cmd === '!daily') {
            const now = Date.now();
            const gap = now - (user.lastDailyClaim || 0);

            // Cooldown: 20 hours
            if (user.lastDailyClaim > 0 && gap < config.ECONOMY.DAILY_COOLDOWN_MS) {
                const readyAt = Math.floor((user.lastDailyClaim + config.ECONOMY.DAILY_COOLDOWN_MS) / 1000);
                return message.reply(`You already claimed today! Come back <t:${readyAt}:R>, you impatient brat! (¬_¬)`);
            }

            let streakBeforeClaim = user.dailyStreak || 0;
            let freezeUsed = false;

            // Streak break: 36 hours since last claim
            if (user.lastDailyClaim > 0 && gap >= config.ECONOMY.DAILY_STREAK_BREAK_MS) {
                // Always re-fetch inventory fresh to avoid stale snapshot race
                const freshUser = await User.findOne({ userId: message.author.id }).select('inventory').lean();
                const freezeIndex = (freshUser?.inventory || []).indexOf('Streak Freeze');
                if (freezeIndex !== -1) {
                    // Atomically consume the Streak Freeze at the exact index found
                    const unsetObj = {};
                    unsetObj[`inventory.${freezeIndex}`] = 1;
                    const unsetResult = await User.updateOne(
                        { userId: message.author.id, [`inventory.${freezeIndex}`]: 'Streak Freeze' },
                        { $unset: unsetObj }
                    );
                    if (unsetResult.modifiedCount > 0) {
                        await User.updateOne({ userId: message.author.id }, { $pull: { inventory: null } });
                        freezeUsed = true;
                    }
                }
                if (!freezeUsed) {
                    streakBeforeClaim = 0;
                }
            }

            const newStreak = streakBeforeClaim + 1;

            // --- REWARD TABLE (descending priority, first match wins) ---
            let coinReward = 0;
            let nuggetReward = 0;
            let boxRewards = [];
            let titleReward = null;
            let rewardDesc = '';

            if (newStreak >= 100 && newStreak % 30 === 0 && newStreak !== 100) {
                coinReward = 5000000;
                nuggetReward = 2;
                rewardDesc = `💰 **+${coinReward.toLocaleString('en-US')} Coins** + 🪙 **+2 Nuggets**\n*Recurring milestone reward!*`;
            } else if (newStreak === 100) {
                coinReward = 50000000;
                nuggetReward = 10;
                rewardDesc = `💰 **+${coinReward.toLocaleString('en-US')} Coins** + 🪙 **+10 Nuggets**\n🏆 *CENTENNIAL MILESTONE! LEGENDARY!*`;
            } else if (newStreak === 60) {
                coinReward = 1000000;
                nuggetReward = 1;
                boxRewards = Array(10).fill('Gold Gacha Box');
                rewardDesc = `💰 **+${coinReward.toLocaleString('en-US')} Coins** + 🪙 **+1 Nugget** + 👑 **10x Gold Gacha Box**`;
            } else if (newStreak === 30) {
                coinReward = 500000;
                boxRewards = ['Gold Gacha Box'];
                rewardDesc = `💰 **+${coinReward.toLocaleString('en-US')} Coins** + 👑 **Gold Gacha Box**`;
            } else if (newStreak === 21) {
                coinReward = 300000;
                rewardDesc = `💰 **+${coinReward.toLocaleString('en-US')} Coins**`;
            } else if (newStreak === 14) {
                coinReward = 100000;
                boxRewards = ['Gold Gacha Box'];
                rewardDesc = `💰 **+${coinReward.toLocaleString('en-US')} Coins** + 👑 **Gold Gacha Box**`;
            } else if (newStreak === 10) {
                coinReward = 80000;
                rewardDesc = `💰 **+${coinReward.toLocaleString('en-US')} Coins**`;
            } else if (newStreak === 7) {
                coinReward = 50000;
                const pool = Math.random() < 0.5 ? 'COMMON' : 'RARE';
                const titles = GACHA_TITLES[pool];
                const picked = titles[Math.floor(Math.random() * titles.length)];
                if (user.inventory.includes(picked)) {
                    // Already owns this title — give fallback coins instead (matches gacha dupe behaviour)
                    const fallback = config.DUPLICATE_FALLBACK[pool];
                    coinReward += fallback;
                    rewardDesc = `💰 **+${coinReward.toLocaleString('en-US')} Coins** *(duplicate title — converted to ${fallback.toLocaleString('en-US')}c)*`;
                } else {
                    titleReward = picked;
                    rewardDesc = `💰 **+${coinReward.toLocaleString('en-US')} Coins** + 🏷️ **${titleReward}** *(${pool})*`;
                }
            } else if (newStreak === 5) {
                coinReward = 30000;
                rewardDesc = `💰 **+${coinReward.toLocaleString('en-US')} Coins**`;
            } else if (newStreak === 3) {
                coinReward = 10000;
                rewardDesc = `💰 **+${coinReward.toLocaleString('en-US')} Coins**`;
            } else if (newStreak === 2) {
                coinReward = 5000;
                rewardDesc = `💰 **+${coinReward.toLocaleString('en-US')} Coins**`;
            } else {
                coinReward = Math.floor(Math.min(newStreak * config.ECONOMY.DAILY_STREAK_MULTIPLIER, config.ECONOMY.DAILY_STREAK_CAP));
                rewardDesc = `💰 **+${coinReward.toLocaleString('en-US')} Coins**`;
            }

            // Distribute coins
            const log = await distributeIncome(message.author.id, coinReward);

            // Build atomic update
            const updateSet = {
                lastDailyClaim: now,
                dailyStreak: newStreak,
                longestDailyStreak: Math.max(user.longestDailyStreak || 0, newStreak)
            };
            const updateInc = {};
            const updatePush = {};
            if (nuggetReward > 0) updateInc.nuggets = nuggetReward;
            
            const itemsToPush = [...boxRewards];
            if (titleReward) itemsToPush.push(titleReward);
            
            if (itemsToPush.length > 0) {
                updatePush.inventory = { $each: itemsToPush };
            }

            const updateOps = { $set: updateSet };
            if (Object.keys(updateInc).length > 0) updateOps.$inc = updateInc;
            if (Object.keys(updatePush).length > 0) updateOps.$push = updatePush;

            await User.findOneAndUpdate({ userId: message.author.id }, updateOps);

            // Tsundere reply variants
            const tsundereMessages = [
                "D-Don't get used to this! I only give you things because I HAVE to! (¬_¬)",
                "H-Here! Take it and stop bugging me, you annoying leech! >////<",
                "Tch. Fine. You showed up. That's... not totally pathetic, I guess. (¬_¬)"
            ];
            const tsunMsg = tsundereMessages[Math.floor(Math.random() * tsundereMessages.length)];

            const isNewRecord = newStreak > (user.longestDailyStreak || 0);

            const embed = new EmbedBuilder()
                .setColor(0xFF69B4)
                .setTitle(`📅 Daily Streak — Day ${newStreak}!`)
                .setDescription(
                    `${tsunMsg}\n\n` +
                    `${rewardDesc}${log}\n\n` +
                    (freezeUsed ? '❄️ **Streak Freeze used!** Your streak was saved!\n\n' : '') +
                    `🔥 **Current Streak:** ${newStreak} day${newStreak !== 1 ? 's' : ''}\n` +
                    (isNewRecord ? `🏆 **NEW RECORD!** Previous best: ${user.longestDailyStreak || 0}\n` : `📊 **Longest:** ${Math.max(user.longestDailyStreak || 0, newStreak)}\n`) +
                    `⏰ **Next claim:** <t:${Math.floor((now + config.ECONOMY.DAILY_COOLDOWN_MS) / 1000)}:R>`
                )
                .setThumbnail(message.author.displayAvatarURL())
                .setFooter({ text: freezeUsed ? "Your Streak Freeze saved you! Buy more at !shop" : "Miss a day? Buy a Streak Freeze at !shop!" });

            // Milestone announcements in #general (fire-and-forget)
            if ([7, 30, 100].includes(newStreak)) {
                const generalChannel = message.guild.channels.cache.find(c => c.name === config.CHANNELS.GENERAL);
                if (generalChannel) {
                    const milestoneEmbed = new EmbedBuilder()
                        .setColor(newStreak === 100 ? 0xFFD700 : 0xFF69B4)
                        .setTitle(newStreak === 100 ? '🏆 CENTENNIAL STREAK' : '🔥 STREAK MILESTONE')
                        .setDescription(`<@${message.author.id}> has maintained their daily streak for **${newStreak} days**. D-Disgusting dedication. I respect it. >////<`);
                    generalChannel.send({ embeds: [milestoneEmbed] }).catch(() => {});
                }
            }

            return message.reply({ embeds: [embed] });
        }

        // --- !BAG ---
        if (cmd === '!bag' || cmd === '!inventory') {
            const args = message.content.split(' ');
            if (args[1]?.toLowerCase() === 'fish') {
                return require('./fishing').handleBag(message, client, user);
            }

            // Determine counts for stackable items using NON_TITLE_ITEMS

            const fields = [
                { name: '💳 Balance', value: `\`${user.coins.toLocaleString('en-US')} Coins\``, inline: true },
                { name: '💎 Nuggets', value: `\`${(user.nuggets || 0).toLocaleString('en-US')}\``, inline: true },
                { name: '🛡️ Shield', value: user.equippedShield ? '✅ Equipped' : '❌ None', inline: true },
                { name: '🪙 Amulet', value: user.equippedAmuletCount > 0 ? `✅ **${user.equippedAmuletCount}x** Equipped` : '❌ None', inline: true },
                { name: '🎨 Frame Color', value: `\`${user.frameColor || "Default"}\``, inline: true },
                { name: '📦 Total Items', value: `\`${user.inventory.length}\``, inline: true }
            ];

            // Active Effects
            const activeEffects = [];
            if (user.bountyShieldExpiry > Date.now()) {
                const remaining = user.bountyShieldExpiry - Date.now();
                const hours = Math.floor(remaining / 3600000);
                const mins = Math.floor((remaining % 3600000) / 60000);
                activeEffects.push(`🛡️ Bounty Shield — ${hours}h ${mins}m remaining`);
            }
            if (user.isekaiDiscountActive) activeEffects.push('🎫 Isekai Discount — Ready (next !isekai -25%)');
            if (user.doubleDipActive) activeEffects.push('✌️ Double Dip — Ready (next income doubled)');
            if (user.mediocrityExpiry > Date.now()) {
                const r = user.mediocrityExpiry - Date.now();
                activeEffects.push(`😈 Mediocrity Curse — Active for ${Math.floor(r / 3600000)}h ${Math.floor((r % 3600000) / 60000)}m (unknown origin)`);
            }
            if (activeEffects.length > 0) {
                fields.push({ name: '✨ Active Effects', value: activeEffects.join('\n'), inline: false });
            }

            const embed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle(`${message.author.username}'s Inventory 🎒`)
                .addFields(fields)
                .setFooter({ text: "H-Here's your overview... don't look at me like that! (¬_¬)" });

            const tabRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`bag_tab_overview_${message.author.id}`)
                    .setLabel('Overview')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('📋'),
                new ButtonBuilder()
                    .setCustomId(`bag_tab_titles_${message.author.id}_0`)
                    .setLabel('Titles')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('🏷️'),
                new ButtonBuilder()
                    .setCustomId(`bag_tab_items_${message.author.id}_0`)
                    .setLabel('Items & Consumables')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('⚔️')
            );

            return message.reply({ embeds: [embed], components: [tabRow] });
        }

        // --- !SHOP ---
        // --- !SHOP (UI UPDATE) ---
        if (cmd === '!shop') {
            const shopEmbed = new EmbedBuilder()
                .setColor(0x2B2D31) // Dark/Cool Gray
                .setTitle("🏪 THE TRASH TASTE MARKET")
                .setDescription(`**Welcome, ${message.author.username}.**\n\nSelect a category below to browse.\n\n💳 **Balance:** \`${user.coins.toLocaleString('en-US')} Coins\``)
                .setThumbnail(client.user.displayAvatarURL())
                .setFooter({ text: "I'll be here... n-not waiting for YOU specifically! (¬_¬)" });

            const row = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('shop_category_selector')
                    .setPlaceholder('🔻 Select a Category')
                    .addOptions(
                        { label: 'Titles', description: 'Flex your degeneracy.', value: 'cat_titles', emoji: '🏷️' },
                        { label: 'Items & Upgrades', description: 'Frames, Shields, Utility.', value: 'cat_items', emoji: '⚔️' },
                        { label: 'Special Services', description: 'Freedom & High Value items. Sugar role = one per season!', value: 'cat_special', emoji: '🔥' },
                        { label: 'Shady Merchant', description: 'Sell your junk for coins!', value: 'cat_merchant', emoji: '🏴‍☠️' },
                        { label: 'Fishing Gear', description: 'Rods and Bait.', value: 'cat_fishing', emoji: '🎣' }
                    )
            );
            return message.reply({ embeds: [shopEmbed], components: [row] });
        }

        // --- !EQUIP (TABBED) ---
        if (cmd === '!equip') {
            const embed = new EmbedBuilder()
                .setColor(0xFF69B4)
                .setTitle("🎒 Equipment Manager")
                .setDescription("H-Hurry up and pick a category, baka! It's not like I want to help you gear up or anything! (¬_¬)")
                .setThumbnail(client.user.displayAvatarURL())
                .setFooter({ text: "D-Don't take forever picking! I don't have all day! >///< " });

            const tabRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`equip_cat_titles_${message.author.id}_0`)
                    .setLabel('Titles')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('🏷️'),
                new ButtonBuilder()
                    .setCustomId(`equip_cat_items_${message.author.id}_0`)
                    .setLabel('Items')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('⚔️'),
                new ButtonBuilder()
                    .setCustomId(`equip_cat_fishing_${message.author.id}_0`)
                    .setLabel('Fishing')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('🎣')
            );

            return message.reply({ embeds: [embed], components: [tabRow] });
        }

        // --- !UNEQUIP ---
        if (cmd === '!unequip') {
            const equipped = [];
            const activeRodId = user.fishing?.gear?.activeRod || 'flimsy_stick';

            if (user.equippedTitle) {
                equipped.push({ label: `Title: ${user.equippedTitle}`, value: 'unequip_title', emoji: '🏷️' });
            }
            if (user.equippedShield) {
                equipped.push({ label: 'Elo Shield', value: 'unequip_shield', emoji: '🛡️' });
            }
            if (user.equippedAmuletCount > 0) {
                equipped.push({ label: `Coin Amulet (${user.equippedAmuletCount}x equipped)`, value: 'unequip_amulet', emoji: '🪙' });
            }
            if (activeRodId !== 'flimsy_stick') {
                const rodConf = config.FISHING?.GEAR?.RODS?.[activeRodId];
                equipped.push({ label: `Fishing Rod: ${rodConf?.name || activeRodId}`, value: 'unequip_rod', emoji: rodConf?.emoji || '🎣' });
            }
            const uneqBaitId = user.fishing?.gear?.activeBait || 'none';
            if (uneqBaitId !== 'none') {
                const baitConf = config.FISHING?.GEAR?.BAITS?.[uneqBaitId];
                equipped.push({ label: `Bait: ${baitConf?.name || uneqBaitId} (${user.fishing?.gear?.baitCount || 0} left)`, value: 'unequip_bait', emoji: baitConf?.emoji || '🪱' });
            }

            if (equipped.length === 0) {
                return message.reply("Y-You aren't wearing anything to take off! Don't be weird! >///<");
            }

            const embed = new EmbedBuilder()
                .setColor(0xFF4500)
                .setTitle("🔓 Unequip Manager")
                .setDescription(
                    `*"W-What, you wanna strip down?! Fine, pick what to remove!"* (¬_¬)\n\n` +
                    `**Currently Equipped:**\n` +
                    (user.equippedTitle ? `🏷️ Title: **${user.equippedTitle}**\n` : '') +
                    (user.equippedShield ? `🛡️ Elo Shield: **Equipped**\n` : '') +
                    (user.equippedAmuletCount > 0 ? `🪙 Amulets: **${user.equippedAmuletCount}x** Stacked\n` : '') +
                    (activeRodId !== 'flimsy_stick' ? `${config.FISHING?.GEAR?.RODS?.[activeRodId]?.emoji || '🎣'} Rod: **${config.FISHING?.GEAR?.RODS?.[activeRodId]?.name || activeRodId}**\n` : '') +
                    (uneqBaitId !== 'none' ? `${config.FISHING?.GEAR?.BAITS?.[uneqBaitId]?.emoji || '🪱'} Bait: **${config.FISHING?.GEAR?.BAITS?.[uneqBaitId]?.name || uneqBaitId}** (${user.fishing?.gear?.baitCount || 0} left)\n` : '')
                )
                .setThumbnail(client.user.displayAvatarURL())
                .setFooter({ text: "Items will be returned to your inventory." });

            const selectRow = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('unequip_selector')
                    .setPlaceholder('🔻 Select item to unequip...')
                    .addOptions(equipped)
            );

            const buttonRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('unequip_all')
                    .setLabel('Unequip Everything')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('💥')
            );

            return message.reply({ embeds: [embed], components: [selectRow, buttonRow] });
        }

        // --- !CURSE ---
        if (cmd.startsWith('!curse')) {
            const target = message.mentions.users.first();
            if (!target) return message.reply("Tag someone to curse! (¬_¬)");

            const hasTrash = user.inventory.includes('Trash Curse');
            const hasMediocrity = user.inventory.includes('Curse of Mediocrity');

            if (!hasTrash && !hasMediocrity) return message.reply("You don't have any curses! Go buy one from `!shop`! (¬_¬)");

            // Determine which curse to use
            const args = message.content.split(/\s+/);
            let curseType = null;
            if (hasTrash && hasMediocrity) {
                // Both owned — require explicit subcommand
                const sub = args[1]?.toLowerCase();
                if (sub === 'trash') curseType = 'trash';
                else if (sub === 'mediocrity') curseType = 'mediocrity';
                else return message.reply('You have both curses! Specify: `!curse trash @target` or `!curse mediocrity @target` (¬_¬)');
            } else {
                curseType = hasTrash ? 'trash' : 'mediocrity';
            }

            // Remove item from inventory
            const itemName = curseType === 'trash' ? 'Trash Curse' : 'Curse of Mediocrity';
            const freshUser = await User.findOne({ userId: message.author.id });
            const itemIndex = freshUser.inventory.indexOf(itemName);
            if (itemIndex !== -1) {
                const unsetObj = {};
                unsetObj[`inventory.${itemIndex}`] = 1;
                await User.updateOne({ userId: message.author.id }, { $unset: unsetObj });
                await User.updateOne({ userId: message.author.id }, { $pull: { inventory: null } });
            }

            if (curseType === 'trash') {
                await User.findOneAndUpdate(
                    { userId: target.id },
                    { trashTasteExpiry: Date.now() + config.CURSE_DURATION },
                    { upsert: true }
                );
                return message.reply(`👻 **CURSED!** ${target.username} loses 2x Elo on defeat, gains half on win (24h)!`);
            } else {
                // Mediocrity: silent curse — target sees it in bag but not who did it
                await User.updateOne(
                    { userId: target.id },
                    { $set: { mediocrityExpiry: Date.now() + config.CURSE_DURATION } }
                );
                return message.reply('Curse deployed. They have no idea. (¬_¬)')
                    .then((m) => {
                        setTimeout(() => m.delete().catch(() => {}), 3000);
                    });
            }
        }

        // --- !TOSS (RIGGED FOR THE RICH) ---
        if (cmd === '!toss') {
            const args = message.content.split(' ');
            if (args.length < 3) return message.reply("Usage: `!toss heads/tails <amount>` (¬_¬)");

            let choice = args[1].toLowerCase();
            let amount = args[2] === 'all' ? user.coins : parseInt(args[2]);

            // Normalize input: accept head/heads/h -> heads, tail/tails/t -> tails
            if (['head', 'heads', 'h'].includes(choice)) choice = 'heads';
            else if (['tail', 'tails', 't'].includes(choice)) choice = 'tails';
            else return message.reply("Choose `heads` or `tails`! (h/t works too, you lazy bum!) (¬_¬)");

            if (amount === 'all') amount = user.coins;
            if (isNaN(amount) || amount <= 0) return message.reply("Bet a positive amount!");
            if (user.coins < amount) return message.reply(`You're too poor! Balance: ${user.coins.toLocaleString('en-US')}`);

            // --- GIVE GAMBLING ROLE ---
            try {
                const role = message.guild.roles.cache.find(r => r.name === config.ROLES.GAMBLING);
                if (role && !message.member.roles.cache.has(role.id)) {
                    await message.member.roles.add(role);
                }
            } catch (e) { console.log("Failed to give Gambling role."); }


            // Standard Toss Logic
            const isRich = user.coins > 100000;
            // Removed 100k limit as requested

            // DEDUCT BET FIRST (atomic, prevents double-spend)
            const tossDeduct = await User.findOneAndUpdate(
                { userId: message.author.id, coins: { $gte: amount } },
                { $inc: { coins: -amount, systemSpent: amount } },
                { new: true }
            );
            if (!tossDeduct) return message.reply(`You're too poor! Balance: ${user.coins.toLocaleString('en-US')}`);

            const rng = Math.random() * 100;

            // --- ODDS CONFIGURATION ---
            const isOwner = message.author.id === config.OWNER_ID;
            let jackpotThreshold = isOwner ? 8   : (isRich ? 0.5 : 2);
            let sewerThreshold =   isOwner ? 8   : (isRich ? 6.0 : 6);
            let riggedThreshold =  isOwner ? 8   : (isRich ? 14.0 : 8);
            let headsThreshold =   isOwner ? 90  : (isRich ? 57.0 : 55);
            // Tails is the remainder (Rich: 43% | Normal: 47%)

            // 1. JACKPOT (Win 3x)
            if (rng < jackpotThreshold) {
                const profit = amount * 3;
                await User.findOneAndUpdate(
                    { userId: message.author.id },
                    { $inc: { coins: amount, systemSpent: -amount } } // Return bet
                );
                const log = await distributeIncome(message.author.id, profit);
                const freshUser = await User.findOne({ userId: message.author.id });
                return message.reply(`✨ **MIRACLE!** The coin landed on its edge?! \n💰 **JACKPOT!** You win **${profit.toLocaleString('en-US')} Coins** (3x profit)! D-Don't get cocky!${log}\n💳 **Balance:** ${freshUser.coins.toLocaleString('en-US')} — d-don't let it go to your head! (¬_¬)`);
            }

            // 2. SEWER LOSS (House Edge)
            if (rng >= jackpotThreshold && rng < sewerThreshold) {
                return message.reply(`💸 **Uh oh...** The coin rolled into the sewer! You lost everything! (House Edge) 🐀\n💳 **Balance:** ${tossDeduct.coins.toLocaleString('en-US')}`);
            }

            // 3. RIGGED LOSS (For Rich People - 8%)
            // Forces the result to be the OPPOSITE of what they picked
            if (rng >= sewerThreshold && rng < riggedThreshold) {
                const forcedLoss = choice === 'heads' ? 'tails' : 'heads';
                return message.reply(`🪙 **${forcedLoss.toUpperCase()}!** You lost! 💸 **-${amount.toLocaleString('en-US')} Coins**\n💳 **Balance:** ${tossDeduct.coins.toLocaleString('en-US')}`);
            }

            // 4. STANDARD TOSS
            const result = rng < headsThreshold ? 'heads' : 'tails';
            const won = result === choice;

            if (won) {
                await User.findOneAndUpdate(
                    { userId: message.author.id },
                    { $inc: { coins: amount, systemSpent: -amount } } // Return bet
                );
                const log = await distributeIncome(message.author.id, amount);
                const freshUser = await User.findOne({ userId: message.author.id });
                return message.reply(`🪙 **${result.toUpperCase()}!** You won! 💰 **+${amount.toLocaleString('en-US')} Coins**${log}\n💳 **Balance:** ${freshUser.coins.toLocaleString('en-US')}`);
            } else {
                return message.reply(`🪙 **${result.toUpperCase()}!** You lost! 💸 **-${amount.toLocaleString('en-US')} Coins**\n💳 **Balance:** ${tossDeduct.coins.toLocaleString('en-US')}`);
            }
        }



        // --- !SLOTS ---
        if (cmd.startsWith('!slots')) {
            const args = message.content.split(' ');
            const bet = parseInt(args[1]);

            if (isNaN(bet) || !Number.isInteger(bet) || bet < 10 || bet > 1000000) {
                return message.reply("Usage: `!slots [amount]` (Min 10, Max 1,000,000, whole numbers only)");
            }
            if (user.coins < bet) {
                return message.reply(`🚫 You're broke! Balance: **${user.coins}**.`);
            }

            const now = Date.now();
            const lastSpin = slotsCooldowns.get(message.author.id) || 0;
            if (now - lastSpin < 3000) {
                return message.reply("Slow down! Wait 3 seconds between spins.");
            }
            slotsCooldowns.set(message.author.id, now);

            // Atomic bet deduction (prevents double-spend)
            const slotsDeduct = await User.findOneAndUpdate(
                { userId: message.author.id, coins: { $gte: bet } },
                { $inc: { coins: -bet, systemSpent: bet } },
                { new: true }
            );
            if (!slotsDeduct) return message.reply(`🚫 You're broke! Balance: **${user.coins}**.`);

            const symbols = ['❤️‍🩹', '✌️', '🔥', '🥀', '❤️‍🩹', '💔', '🙏'];
            const spin = () => symbols[Math.floor(Math.random() * symbols.length)];

            const r1 = spin();
            const r2 = spin();
            const r3 = spin();

            let multiplier = 0;
            let resultText = "You lost. Pathetic... try using your brain next time, baka.";

            if (r1 === r2 && r2 === r3) {
                if (r1 === '🙏') multiplier = 10;
                else if (r1 === '🔥') multiplier = 5;
                else multiplier = 3;
                resultText = "🎉 **JACKPOT!!** UNBELIEVABLE!!";
            }
            else if (r1 === r2 || r2 === r3 || r1 === r3) {
                multiplier = 2;
                resultText = "Not bad. Just a tiny win, don't get smug.";
            }

            const winnings = bet * multiplier;
            const profit = winnings - bet;  // Actual profit after getting bet back
            let log = "";
            if (profit > 0) {
                // Return the original bet using atomic $inc (prevents race conditions with distributeIncome)
                await User.findOneAndUpdate(
                    { userId: message.author.id },
                    { $inc: { coins: bet, systemSpent: -bet } }
                );
                // Then distribute only the profit
                log = await distributeIncome(message.author.id, profit);
            }

            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const msg = await message.channel.send(`🎰 **SLOTS** | Bet: ${bet}\n**[ 🔄 | 🔄 | 🔄 ]**\n*Spinning...*`);

            try {
                await sleep(1000);
                await msg.edit(`🎰 **SLOTS** | Bet: ${bet}\n**[ ${r1} | 🔄 | 🔄 ]**\n*Spinning...*`);
                await sleep(1000);
                await msg.edit(`🎰 **SLOTS** | Bet: ${bet}\n**[ ${r1} | ${r2} | 🔄 ]**\n*Almost there...*`);
                await sleep(1000);

                const freshUser = await User.findOne({ userId: message.author.id });
                const color = winnings > 0 ? 0x00FF00 : 0xFF0000;
                const embed = new EmbedBuilder()
                    .setColor(color)
                    .setTitle("🎰 Tsundere Slots")
                    .setDescription(
                        `**[ ${r1} | ${r2} | ${r3} ]**\n\n` +
                        `${winnings > 0 ? `💰 **WON: ${winnings} Coins**` : `💸 **LOST: ${bet} Coins**`}\n` +
                        `*${resultText}*\n` +
                        `${log}\n` +
                        `💳 New Balance: ${freshUser.coins}`
                    );

                await msg.edit({ content: null, embeds: [embed] });
            } catch (editError) {
                const freshUser = await User.findOne({ userId: message.author.id });
                const color = winnings > 0 ? 0x00FF00 : 0xFF0000;
                const embed = new EmbedBuilder()
                    .setColor(color)
                    .setTitle("🎰 Tsundere Slots")
                    .setDescription(
                        `**[ ${r1} | ${r2} | ${r3} ]**\n\n` +
                        `${winnings > 0 ? `💰 **WON: ${winnings} Coins**` : `💸 **LOST: ${bet} Coins**`}\n` +
                        `*${resultText}*\n` +
                        `${log}\n` +
                        `💳 New Balance: ${freshUser.coins}`
                    );
                await message.channel.send({ embeds: [embed] });
            }
        }



        // --- !GACHA COMMAND ---
        if (cmd === '!gacha') {
            const args = message.content.split(' ');
            const tier = args[1]?.toLowerCase();

            if (!['bronze', 'silver', 'gold'].includes(tier)) {
                return showGachaDashboard(message, user);
            }

            if (args[2] && args[2] !== '10' && args[2] !== '1') {
                return message.reply("H-Hah?! You can either open **1** box or exactly **10** boxes at a time! What is this weird number?! Stop trying to break me, baka! (¬_¬)");
            }
            const pullCount = args[2] === '10' ? 10 : 1;

            return executeGachaPull(message, user, tier, pullCount, client);
        }

        // --- !SLAVE (MANAGEMENT / STATUS / CARROTS) ---
        if (cmd === '!slave') {
            const args = message.content.split(' ');
            const subCmd = args[1]?.toLowerCase();
            const now = Date.now();

            const safeDisplayName = async (userId) => {
                try {
                    const name = await getDisplayName(userId, message.guild);
                    return name || `<@${userId}>`;
                } catch (e) {
                    return `<@${userId}>`;
                }
            };

            const buildSlaveStatusEmbed = async (slaveUser, showResist = true, footerText = "Use !slave resist to sabotage the carrot once. One shot per master. Use it wisely.") => {
                const ownerName = slaveUser.slaveOwner ? await safeDisplayName(slaveUser.slaveOwner) : `<@${slaveUser.userId}>`;
                const ownerLabel = slaveUser.slaveOwner ? `<@${slaveUser.slaveOwner}> (${ownerName})` : ownerName;
                const loan = await Loan.findOne({
                    borrowerId: slaveUser.userId,
                    status: { $in: ACTIVE_LOAN_STATUSES }
                }).sort({ dueDate: 1 }).lean();

                const breakdown = calculateSlaveHourlyIncome(slaveUser, now);
                let debtText = "No active debt";
                if (loan) {
                    if (loan.status === 'DEFAULTED') {
                        debtText = `⚠️ DEFAULTED — ${loan.remainingAmount.toLocaleString('en-US')}c`;
                    } else {
                        debtText = `${loan.remainingAmount.toLocaleString('en-US')}c`;
                    }
                }

                let carrotText = "None";
                if ((slaveUser.activeCarrot?.expiresAt || 0) > now && (slaveUser.activeCarrot?.amount || 0) > 0) {
                    const carrotMs = slaveUser.activeCarrot.expiresAt - now;
                    carrotText = `${slaveUser.activeCarrot.amount.toLocaleString('en-US')}c — ${formatDurationCompact(carrotMs)} remaining (${(slaveUser.activeCarrot.bonusPerHr || 0).toLocaleString('en-US')}c bonus/hr)`;
                }

                let freedomText = "No active debt";
                if (loan?.remainingAmount > 0) {
                    if (breakdown.loanRepay > 0) {
                        const hoursToFreedom = Math.ceil(loan.remainingAmount / breakdown.loanRepay);
                        freedomText = `~${hoursToFreedom.toLocaleString('en-US')} hours`;
                    } else {
                        freedomText = "Unknown (repay rate is 0)";
                    }
                }

                const embed = new EmbedBuilder()
                    .setColor(0x8B0000)
                    .setTitle("⛓️ YOUR SLAVERY STATUS")
                    .setThumbnail(client.user.displayAvatarURL())
                    .setDescription("You're someone's property right now. H-How humiliating... (¬_¬)")
                    .addFields(
                        { name: '👑 Owner', value: ownerLabel, inline: false },
                        { name: '💸 Remaining debt', value: debtText, inline: false },
                        {
                            name: '📊 Income breakdown (per hour)',
                            value:
                                `Your hourly: ${breakdown.hourlyIncome.toLocaleString('en-US')}c\n` +
                                `├ 40% → Owner: ${breakdown.ownerCut.toLocaleString('en-US')}c\n` +
                                `├ 20% → Loan repayment: ${breakdown.loanRepay.toLocaleString('en-US')}c\n` +
                                `└ 40% → You: ${breakdown.selfKeep.toLocaleString('en-US')}c`,
                            inline: false
                        },
                        { name: '🥕 Active carrot', value: carrotText, inline: false },
                        { name: '⚡ Estimated freedom', value: freedomText, inline: false }
                    )
                    .setTimestamp()
                    .setFooter({ text: footerText, iconURL: client.user.displayAvatarURL() });

                if (showResist) {
                    let resistText = "Available! Use !slave resist";
                    if ((slaveUser.resistExpiresAt || 0) > now) {
                        resistText = `⏳ Recovering (${formatDurationCompact(slaveUser.resistExpiresAt - now)} left)`;
                    } else if (slaveUser.carrotResistUsed) {
                        resistText = "❌ Used";
                    }
                    embed.addFields({ name: '🛡️ Resist', value: resistText, inline: false });
                }

                return embed;
            };

            if (subCmd === 'top') {
                const topOwners = await User.find({ totalCarrotsSpent: { $gt: 0 } })
                    .sort({ totalCarrotsSpent: -1 })
                    .limit(10)
                    .lean();

                if (topOwners.length === 0) {
                    return message.reply("No one has wasted money on carrots yet. Smart. (¬_¬)");
                }

                const totalAgg = await User.aggregate([
                    { $group: { _id: null, total: { $sum: '$totalCarrotsSpent' } } }
                ]);
                const totalSpent = totalAgg[0]?.total || 0;

                const rankFields = [];
                for (let i = 0; i < topOwners.length; i++) {
                    const owner = topOwners[i];
                    const name = await safeDisplayName(owner.userId);
                    rankFields.push({
                        name: `#${i + 1}. ${name}`,
                        value: `${owner.totalCarrotsSpent.toLocaleString('en-US')}c spent`,
                        inline: false
                    });
                }

                const embed = new EmbedBuilder()
                    .setColor(0xFF8C00)
                    .setTitle("🥕 MOST GENEROUS OWNERS")
                    .setThumbnail(client.user.displayAvatarURL())
                    .setDescription("Generous or just bad at math? You decide. (¬_¬)")
                    .addFields(rankFields)
                    .setTimestamp()
                    .setFooter({
                        text: `Total carrots burned by the community: ${totalSpent.toLocaleString('en-US')}c`,
                        iconURL: client.user.displayAvatarURL()
                    });

                return message.reply({ embeds: [embed] });
            }

            if (subCmd === 'carrot') {
                const target = message.mentions.users.first();
                if (!target) return message.reply("Tag your slave, idiot! `!slave carrot @user [amount]` (¬_¬)");

                const targetUser = await User.findOne({ userId: target.id }).lean();
                if (!targetUser?.isSlave) return message.reply("They're not even a slave! Stop wasting my time! (¬_¬)");
                if (targetUser.slaveOwner !== message.author.id) return message.reply("That's not YOUR slave! Back off! (¬_¬)");

                const amount = parseInt(args[3]);
                if (isNaN(amount) || amount < config.ECONOMY.CARROT_MIN) {
                    return message.reply(`Minimum carrot is **${config.ECONOMY.CARROT_MIN.toLocaleString('en-US')}c**! Don't be cheap! (¬_¬)`);
                }

                const loan = await Loan.findOne({
                    borrowerId: target.id,
                    status: { $in: ACTIVE_LOAN_STATUSES }
                }).sort({ dueDate: 1 }).lean();
                if (!loan) {
                    return message.reply("No debt record found — this slave may have been freed already. Use `!loan forgive` to clean up.");
                }

                const maxAllowed = Math.floor(loan.remainingAmount * config.ECONOMY.CARROT_MAX_RATIO);
                if (amount > maxAllowed) {
                    return message.reply(`That's too much! You'd free them instantly, you idiot! Max is **${maxAllowed.toLocaleString('en-US')}c** (${config.ECONOMY.CARROT_MAX_RATIO}× their debt). (¬_¬)`);
                }

                if ((targetUser.activeCarrot?.expiresAt || 0) > now) {
                    return message.reply("There's already an active carrot on them! Wait for it to expire first! (¬_¬)");
                }

                if (user.coins < amount) {
                    return message.reply(`You're too broke to motivate anyone! Balance: **${user.coins.toLocaleString('en-US')}c** (¬_¬)`);
                }

                const bonusPerHr = Math.floor(amount / Math.max(1, (loan.remainingAmount / 100)));
                const expiresAt = now + config.ECONOMY.CARROT_DURATION_MS;

                const ownerUpdated = await User.findOneAndUpdate(
                    { userId: message.author.id, coins: { $gte: amount } },
                    { $inc: { coins: -amount, totalCarrotsSpent: amount } },
                    { new: true }
                );
                if (!ownerUpdated) {
                    return message.reply(`You're too broke to motivate anyone! Balance: **${user.coins.toLocaleString('en-US')}c** (¬_¬)`);
                }

                const carrotApplied = await User.findOneAndUpdate(
                    {
                        userId: target.id,
                        isSlave: true,
                        slaveOwner: message.author.id,
                        'activeCarrot.expiresAt': { $lte: now }
                    },
                    {
                        $set: {
                            'activeCarrot.amount': amount,
                            'activeCarrot.bonusPerHr': bonusPerHr,
                            'activeCarrot.expiresAt': expiresAt,
                            'activeCarrot.ownerId': message.author.id
                        }
                    },
                    { new: true }
                );

                if (!carrotApplied) {
                    await User.findOneAndUpdate(
                        { userId: message.author.id },
                        { $inc: { coins: amount, totalCarrotsSpent: -amount } }
                    );
                    const freshTarget = await User.findOne({ userId: target.id }).lean();
                    if (!freshTarget || !freshTarget.isSlave || freshTarget.slaveOwner !== message.author.id) {
                        return message.reply("They're no longer your slave! (¬_¬)");
                    }
                    return message.reply("There's already an active carrot on them! Wait for it to expire first! (¬_¬)");
                }

                const projected = calculateSlaveHourlyIncome(carrotApplied.toObject(), now);
                const projectedLoanRepay = Math.floor(projected.hourlyIncome * config.ECONOMY.LOAN_REPAY_RATE);

                const embed = new EmbedBuilder()
                    .setColor(0xFF8C00)
                    .setTitle("🥕 CARROT APPLIED")
                    .setThumbnail(client.user.displayAvatarURL())
                    .setDescription(`You spent **${amount.toLocaleString('en-US')}c** motivating your slave. I hope you know what you're doing, idiot. (¬_¬)`)
                    .addFields(
                        { name: '💸 Carrot amount', value: `${amount.toLocaleString('en-US')}c`, inline: true },
                        { name: '⚡ Bonus per hour', value: `+${bonusPerHr.toLocaleString('en-US')}c added to their generation`, inline: true },
                        { name: '⏱️ Duration', value: `24 hours (expires <t:${Math.floor(expiresAt / 1000)}:R>)`, inline: false },
                        { name: '💀 Risk', value: `Their debt is ${loan.remainingAmount.toLocaleString('en-US')}c — at this rate they repay ~${projectedLoanRepay.toLocaleString('en-US')}c/hr toward freedom.`, inline: false },
                        { name: '⚠️ Warning', value: "If they repay their loan while the carrot is active, you LOSE the remaining carrot value. Do the math next time.", inline: false }
                    )
                    .setTimestamp()
                    .setFooter({
                        text: "Beware: !slave resist can nullify this for 6 hours. They get one shot per ownership.",
                        iconURL: client.user.displayAvatarURL()
                    });

                return message.reply({ embeds: [embed] });
            }

            if (subCmd === 'resist') {
                if (!user.isSlave) return message.reply("You're not even enslaved! What are you resisting? (¬_¬)");

                let freshSlave = await User.findOne({ userId: message.author.id }).lean();
                if (!freshSlave || (freshSlave.activeCarrot?.expiresAt || 0) <= now) {
                    return message.reply("There's no active carrot to resist! Your owner isn't even motivating you... pathetic. (¬_¬)");
                }

                if (freshSlave.carrotResistUsed) {
                    if ((freshSlave.resistExpiresAt || 0) > now) {
                        return message.reply(`You're already resisting! ${formatDurationCompact(freshSlave.resistExpiresAt - now)} remaining. (¬_¬)`);
                    }

                    await User.findOneAndUpdate(
                        { userId: message.author.id, carrotResistUsed: true, resistExpiresAt: { $lte: now } },
                        { $set: { carrotResistUsed: false, resistExpiresAt: 0 } }
                    );
                    freshSlave = { ...freshSlave, carrotResistUsed: false, resistExpiresAt: 0 };
                }

                if ((freshSlave.resistExpiresAt || 0) > now) {
                    return message.reply(`You're already resisting! ${formatDurationCompact(freshSlave.resistExpiresAt - now)} remaining. (¬_¬)`);
                }

                const resistUntil = now + config.ECONOMY.CARROT_RESIST_MS;
                const resistUpdated = await User.findOneAndUpdate(
                    { userId: message.author.id, isSlave: true },
                    { $set: { carrotResistUsed: true, resistExpiresAt: resistUntil } },
                    { new: true }
                );
                if (!resistUpdated) {
                    return message.reply("Resist failed. Tch... try again, baka. (¬_¬)");
                }

                const embed = new EmbedBuilder()
                    .setColor(0x8B0000)
                    .setTitle("🛡️ RESISTANCE ACTIVATED")
                    .setThumbnail(client.user.displayAvatarURL())
                    .setDescription("You're slacking off for the next 6 hours! Your owner's carrot does NOTHING! Hah! >///<")
                    .addFields(
                        { name: '⏱️ Resist active until', value: `<t:${Math.floor(resistUntil / 1000)}:R>`, inline: false },
                        { name: '⚠️ One-time use', value: 'This is your only resist per ownership. Use it wisely.', inline: false }
                    )
                    .setTimestamp()
                    .setFooter({
                        text: "Your owner will NOT be notified... unless you tell them yourself. (¬_¬)",
                        iconURL: client.user.displayAvatarURL()
                    });

                return message.reply({ embeds: [embed] });
            }

            if (subCmd === 'info') {
                const target = message.mentions.users.first();
                if (!target) return message.reply("Tag someone to look up! (¬_¬)");

                const targetUser = await User.findOne({ userId: target.id }).lean();
                if (!targetUser?.isSlave) return message.reply("They're not enslaved. Lucky them. (¬_¬)");

                const embed = await buildSlaveStatusEmbed(
                    targetUser,
                    false,
                    "Public status only. Private resist details are hidden, idiot. (¬_¬)"
                );
                embed.setTitle("⛓️ SLAVE STATUS LOOKUP");

                return message.reply({ embeds: [embed] });
            }

            const shouldShowSlaveView = user.isSlave && (!subCmd || subCmd === 'status');
            if (shouldShowSlaveView) {
                const myUser = await User.findOne({ userId: message.author.id }).lean();
                const embed = await buildSlaveStatusEmbed(myUser, true);
                const ownedCount = await User.countDocuments({ slaveOwner: message.author.id, isSlave: true });
                if (ownedCount > 0) {
                    embed.addFields({ name: '📌 Note', value: `You also own ${ownedCount} slave(s). Use \`!slave list\` to view them.`, inline: false });
                }
                return message.reply({ embeds: [embed] });
            }

            if (!subCmd || subCmd === 'list') {
                const ownedSlaves = await User.find({ slaveOwner: message.author.id, isSlave: true }).lean();
                if (ownedSlaves.length === 0) {
                    const emptyEmbed = new EmbedBuilder()
                        .setColor(0xFF1493)
                        .setTitle("⛓️ Your Slaves")
                        .setThumbnail(client.user.displayAvatarURL())
                        .setDescription("H-Hah? You don't own anyone! Go make some loans, idiot! (¬_¬)")
                        .setTimestamp()
                        .setFooter({ text: "No property report for deadbeats. Try again later. (¬_¬)", iconURL: client.user.displayAvatarURL() });
                    return message.reply({ embeds: [emptyEmbed] });
                }

                const slaveIds = ownedSlaves.map(s => s.userId);
                const activeLoans = await Loan.find({
                    borrowerId: { $in: slaveIds },
                    lenderId: message.author.id,
                    status: { $in: ACTIVE_LOAN_STATUSES }
                }).lean();
                const loanBySlave = new Map(activeLoans.map(l => [l.borrowerId, l]));

                const rows = await Promise.all(ownedSlaves.map(async (slaveUser) => {
                    const displayName = await safeDisplayName(slaveUser.userId);
                    const loan = loanBySlave.get(slaveUser.userId);
                    const breakdown = calculateSlaveHourlyIncome(slaveUser, now);

                    let debtText = "No active debt";
                    if (loan) {
                        const statusPrefix = loan.status === 'DEFAULTED' ? "⚠️ Defaulted — " : "";
                        debtText = `${statusPrefix}${loan.remainingAmount.toLocaleString('en-US')}c`;
                    }

                    let carrotText = "No carrot active";
                    if ((slaveUser.activeCarrot?.expiresAt || 0) > now && (slaveUser.activeCarrot?.amount || 0) > 0) {
                        carrotText = `${slaveUser.activeCarrot.amount.toLocaleString('en-US')}c — ${formatDurationCompact(slaveUser.activeCarrot.expiresAt - now)} remaining`;
                    }

                    let freedomText = "No active debt";
                    if (loan?.remainingAmount > 0) {
                        if (breakdown.loanRepay > 0) {
                            const hours = Math.ceil(loan.remainingAmount / breakdown.loanRepay);
                            freedomText = `~${hours.toLocaleString('en-US')} hours`;
                        } else {
                            freedomText = "Unknown (repay rate is 0)";
                        }
                    }

                    return {
                        name: `👤 ${displayName}`,
                        value:
                            `💸 Debt remaining: ${debtText}\n` +
                            `⏱️ Hourly gen: ${breakdown.hourlyIncome.toLocaleString('en-US')}c → You get ${breakdown.ownerCut.toLocaleString('en-US')}c (40%)\n` +
                            `🥕 Carrot: ${carrotText}\n` +
                            `⚡ Est. freedom: ${freedomText}`
                    };
                }));

                const totalHourly = rows.reduce((sum, row, idx) => {
                    const slave = ownedSlaves[idx];
                    return sum + calculateSlaveHourlyIncome(slave, now).hourlyIncome;
                }, 0);
                const totalCarrotsSpent = user.totalCarrotsSpent || 0;

                const pageSize = 10;
                const totalPages = Math.ceil(rows.length / pageSize);
                const embeds = [];
                for (let i = 0; i < rows.length; i += pageSize) {
                    const pageRows = rows.slice(i, i + pageSize);
                    const page = Math.floor(i / pageSize) + 1;
                    const listEmbed = new EmbedBuilder()
                        .setColor(0xFF1493)
                        .setTitle(`⛓️ YOUR SLAVES (${ownedSlaves.length} owned)`)
                        .setThumbnail(client.user.displayAvatarURL())
                        .setDescription("Hmph. Here's your property report, master. Don't thank me. (¬_¬)")
                        .addFields(pageRows)
                        .addFields({
                            name: '📌 Summary',
                            value:
                                `💰 Total hourly from all slaves: ${totalHourly.toLocaleString('en-US')}c\n` +
                                `🥕 Total carrots spent (lifetime): ${totalCarrotsSpent.toLocaleString('en-US')}c`,
                            inline: false
                        })
                        .setTimestamp()
                        .setFooter({
                            text: `Page ${page}/${totalPages} • Keep your slaves productive, baka. (¬_¬)`,
                            iconURL: client.user.displayAvatarURL()
                        });
                    embeds.push(listEmbed);
                }

                await message.reply({ embeds: [embeds[0]] });
                for (let i = 1; i < embeds.length; i++) {
                    await message.channel.send({ embeds: [embeds[i]] });
                }
                return;
            }

            // --- !SLAVE RENAME ---
            if (subCmd === 'rename') {
                const target = message.mentions.users.first();
                if (!target) return message.reply("Tag your slave to rename! `!slave rename @slave [NewName]` or `clear` to reset (¬_¬)");

                const targetUser = await User.findOne({ userId: target.id }).lean();

                // Ownership check — bot owner bypasses
                if (message.author.id !== config.OWNER_ID) {
                    if (!targetUser?.isSlave) {
                        return message.reply("They're not even a slave! ...W-Why are you trying to rename a free person? Weirdo! (¬_¬)");
                    }
                    if (targetUser.slaveOwner !== message.author.id) {
                        return message.reply("That's not YOUR slave! Keep your naming fantasies to your own property, idiot! (¬_¬)");
                    }
                }

                const newName = args.slice(3).join(' ').trim();

                // CLEAR forced nickname
                if (!newName || newName.toLowerCase() === 'clear') {
                    await User.updateOne({ userId: target.id }, { $set: { forcedNickname: null } });

                    // Restore default slave suffix if still a slave
                    if (targetUser?.isSlave && targetUser.slaveOwner) {
                        try {
                            const member = await message.guild.members.fetch(target.id);
                            const ownerMember = await message.guild.members.fetch(targetUser.slaveOwner).catch(() => null);
                            let ownerLabel = ownerMember?.displayName || 'Master';
                            if (ownerLabel.length > 15) ownerLabel = ownerLabel.substring(0, 15) + '..';
                            const suffix = ` (${ownerLabel}'s Slave)`;
                            const baseName = member.user.username;
                            const maxLen = Math.max(1, 32 - suffix.length);
                            const restored = baseName.substring(0, maxLen) + suffix;
                            if (member.manageable) await member.setNickname(restored);
                        } catch (e) {
                            console.error("Failed to restore slave nick:", e);
                        }
                    }

                    const embed = new EmbedBuilder()
                        .setColor(0x2ECC71)
                        .setTitle("📛 SLAVE NAME CLEARED")
                        .setThumbnail(client.user.displayAvatarURL())
                        .setDescription(
                            `<@${target.id}>'s custom name has been removed.\n` +
                            `They're back to their default slave tag. How merciful of you. (¬_¬)`
                        )
                        .setTimestamp()
                        .setFooter({ text: "Use !slave rename @user [name] to set a new one.", iconURL: client.user.displayAvatarURL() });

                    return message.reply({ embeds: [embed] });
                }

                // 32-char limit check
                if (newName.length > 32) {
                    return message.reply(`That name is **${newName.length}** characters! Discord only allows **32**, you illiterate moron! Shorten it and try again! (¬_¬)`);
                }

                // SET forced nickname
                await User.updateOne(
                    { userId: target.id },
                    { $set: { forcedNickname: newName } },
                    { upsert: true }
                );

                // Apply immediately
                try {
                    const member = await message.guild.members.fetch(target.id);
                    if (member.manageable) await member.setNickname(newName);
                } catch (e) {
                    console.error("Failed to set slave nickname:", e);
                }

                const embed = new EmbedBuilder()
                    .setColor(0xFF1493)
                    .setTitle("⛓️ SLAVE RENAMED")
                    .setThumbnail(client.user.displayAvatarURL())
                    .setDescription(
                        `<@${target.id}> has been branded with a new identity!\n\n` +
                        `📛 **New Name:** \`${newName}\`\n\n` +
                        `They can't change it. They can't escape it. Serves them right. (¬_¬)`
                    )
                    .addFields(
                        { name: '🔒 Enforcement', value: 'Any attempt to change this name will be **reverted instantly**.', inline: false },
                        { name: '🧹 Clear', value: '`!slave rename @user clear` to remove the custom name.', inline: false }
                    )
                    .setTimestamp()
                    .setFooter({ text: "The name stays until you clear it or the season resets.", iconURL: client.user.displayAvatarURL() });

                return message.reply({ embeds: [embed] });
            }

            return message.reply("Usage: `!slave`, `!slave list`, `!slave rename @user [name]`, `!slave carrot @user [amount]`, `!slave resist`, `!slave info @user`, `!slave top`");
        }

        // --- !FREEDOM COMMAND ---
        if (cmd === '!freedom') {
            // Check if user has the ticket
            if (!user.inventory.includes('Slave Freedom Ticket')) {
                return message.reply("🚫 You don't have a **Slave Freedom Ticket**! Get one from gacha boxes or trade for one with other players! (¬_¬)");
            }

            // Check if user is actually a slave
            if (!user.isSlave || !user.slaveOwner) {
                return message.reply("H-Hah? You're not even a slave! Stop wasting my time with this ticket! \u003e///\u003c");
            }

            // Block if user still has outstanding debt — ticket only removes the slave tag
            const activeLoan = await Loan.findOne({ borrowerId: user.userId, status: { $in: ACTIVE_LOAN_STATUSES }, remainingAmount: { $gt: 0 } });
            if (activeLoan) {
                return message.reply(`🚫 You still owe **${activeLoan.remainingAmount.toLocaleString('en-US')}** coins! Pay off your debt first, THEN use the ticket to remove your slave tag. I'm not running a charity here! (¬_¬)`);
            }

            const masterName = await getDisplayName(user.slaveOwner, message.guild);

            // REMOVE TICKET & FREE SLAVE ATOMICALLY
            const freshUser = await User.findOne({ userId: user.userId }).lean();
            const ticketIndex = freshUser.inventory.indexOf('Slave Freedom Ticket');
            if (ticketIndex === -1) {
                return message.reply("Your Freedom Ticket vanished... that's suspicious. Try again, baka. (¬_¬)");
            }
            const nextInventory = [...freshUser.inventory];
            nextInventory.splice(ticketIndex, 1);
            await User.findOneAndUpdate(
                { userId: user.userId },
                {
                    $set: {
                        inventory: nextInventory,
                        isSlave: false,
                        slaveOwner: null,
                        carrotResistUsed: false,
                        resistExpiresAt: 0,
                        ...CARROT_RESET_SET
                    }
                }
            );

            // FIX NICKNAME
            try {
                const member = await message.guild.members.fetch(message.author.id);
                if (member.nickname && member.nickname.includes("'s Slave)")) {
                    const cleanName = member.nickname.replace(/\s\([^)]*'s Slave\)$/, "");
                    if (member.manageable) {
                        await member.setNickname(cleanName);
                    }
                }
            } catch (e) {
                console.log("Failed to reset nickname:", e);
            }

            // Restore relationship suffix if dating/married (fire-and-forget)
            (async () => {
                try {
                    const fRel = await Relationship.findOne({
                        $or: [
                            { user1Id: message.author.id, status: { $in: ['dating', 'married'] } },
                            { user2Id: message.author.id, status: { $in: ['dating', 'married'] } }
                        ]
                    });
                    if (fRel) {
                        const pId = fRel.user1Id === message.author.id ? fRel.user2Id : fRel.user1Id;
                        await applyRelationshipSuffix(message.guild, message.author.id, pId, fRel.status);
                    }
                } catch (e) { }
            })();

            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle("🎉 FREEDOM ACHIEVED!")
                .setDescription(
                    `**${message.author.username}** has broken their chains!\n\n` +
                    `⛓️ **Former Master:** ${masterName}\n` +
                    `🏃 **Status:** FREE\n\n` +
                    `*D-Don't get captured again, you fool! I won't always have tickets to save you! \u003e///\u003c*`
                )
                .setThumbnail(message.author.displayAvatarURL());

            // Notify in channel
            await message.channel.send({ embeds: [embed] });

            // Optional: DM the former master
            try {
                const masterUser = await message.client.users.fetch(formerMaster);
                await masterUser.send(`💔 Your slave **${message.author.username}** has bought their freedom with a Slave Freedom Ticket. They are no longer under your control.`);
            } catch (e) {
                // Master has DMs off or error
            }
        }


        // === SLAVE AUCTION SYSTEM ===
        if (cmd === '!auction') {
            const args = message.content.split(' ');
            const subCmd = args[1]?.toLowerCase();

            // CREATE AUCTION: !auction list @slave
            if (subCmd === 'list' && message.mentions.users.size > 0) {
                const slave = message.mentions.users.first();
                const slaveUser = await User.findOne({ userId: slave.id });

                if (!slaveUser || !slaveUser.isSlave || slaveUser.slaveOwner !== message.author.id) {
                    return message.reply("🚫 You don't own this slave! You can't auction someone else's property! (¬_¬)");
                }

                // Check if slave is already in an auction
                const existingAuction = await Auction.findOne({ slaveId: slave.id, active: true });
                if (existingAuction) {
                    return message.reply("This slave is already up for auction!");
                }

                // Calculate minimum bid based on all-time messages
                const allTimeMessages = slaveUser.stats?.allTime?.messages || 0;
                const minimumBid = allTimeMessages * 10;

                if (minimumBid < 1000) {
                    return message.reply(`This slave has only sent **${allTimeMessages}** messages total. Minimum bid would be **${minimumBid}** coins. That's too worthless to auction! Make them chat more first! (¬_¬)`);
                }

                // Create auction
                const auctionId = `${message.guild.id}-${slave.id}-${Date.now()}`;
                const auction = new Auction({
                    auctionId,
                    slaveId: slave.id,
                    sellerId: message.author.id,
                    minimumBid,
                    endTime: Date.now() + (24 * 60 * 60 * 1000), // 24 hours
                    guildId: message.guild.id
                });
                await auction.save();

                const endTimestamp = Math.floor(auction.endTime / 1000);

                const embed = new EmbedBuilder()
                    .setColor(0xFF6B6B)
                    .setTitle("🔨 SLAVE AUCTION CREATED!")
                    .setDescription(
                        `**${slave.username}** is now up for sale!\n\n` +
                        `📊 **All-Time Messages:** ${allTimeMessages.toLocaleString('en-US')}\n` +
                        `💰 **Minimum Bid:** ${minimumBid.toLocaleString('en-US')} coins\n` +
                        `⏰ **Ends:** <t:${endTimestamp}:R>\n\n` +
                        `Type \`!auction bid [amount]\` to place a bid!`
                    )
                    .setThumbnail(slave.displayAvatarURL());

                return message.channel.send({ embeds: [embed] });
            }

            // PLACE BID: !auction bid [amount]
            if (subCmd === 'bid') {
                const bidAmount = parseInt(args[2]);
                if (isNaN(bidAmount) || bidAmount <= 0) {
                    return message.reply("Specify a valid bid amount, you fool! Example: `!auction bid 10000` (¬_¬)");
                }

                // Find active auction in this guild
                const auctions = await Auction.find({ guildId: message.guild.id, active: true });
                if (auctions.length === 0) {
                    return message.reply("There are no active auctions right now! Start one with `!auction list @slave`!");
                }

                if (auctions.length > 1) {
                    return message.reply(`Multiple auctions active! Use \`!auction list\` to see all, then I'll add multi-auction bidding later... (¬_¬)`);
                }

                const auction = auctions[0];

                // Can't bid on own slave
                if (auction.sellerId === message.author.id) {
                    return message.reply("You can't bid on your own slave! That's cheating, you greedy bastard! >:/");
                }

                // Check minimum bid or 5% increase
                const requiredBid = auction.currentBid > 0 ? Math.ceil(auction.currentBid * 1.05) : auction.minimumBid;
                if (bidAmount < requiredBid) {
                    return message.reply(`🚫 Bid too low! Minimum: **${requiredBid.toLocaleString('en-US')}** coins (5% higher than current).`);
                }

                // Check balance
                if (user.coins < bidAmount) {
                    return message.reply(`You're too broke! You need **${bidAmount.toLocaleString('en-US')}** coins but only have **${user.coins.toLocaleString('en-US')}**!`);
                }

                // Atomic: escrow new bid (deduct from bidder)
                const bidDeduct = await User.findOneAndUpdate(
                    { userId: message.author.id, coins: { $gte: bidAmount } },
                    { $inc: { coins: -bidAmount } },
                    { new: true }
                );
                if (!bidDeduct) return message.reply(`You're too broke! You need **${bidAmount.toLocaleString('en-US')}** coins but only have **${user.coins.toLocaleString('en-US')}**!`);

                // Atomic: update auction with optimistic lock on currentBid
                const updatedAuction = await Auction.findOneAndUpdate(
                    { _id: auction._id, currentBid: auction.currentBid },
                    { $set: { currentBid: bidAmount, currentBidder: message.author.id } },
                    { new: true }
                );
                if (!updatedAuction) {
                    // Refund the bidder since auction was modified concurrently
                    await User.findOneAndUpdate(
                        { userId: message.author.id },
                        { $inc: { coins: bidAmount } }
                    );
                    return message.reply(`Someone outbid you while you were placing your bid! Try again!`);
                }

                // Atomic: refund previous bidder
                if (auction.currentBidder) {
                    await User.findOneAndUpdate(
                        { userId: auction.currentBidder },
                        { $inc: { coins: auction.currentBid } }
                    );

                    try {
                        const prevUser = await client.users.fetch(auction.currentBidder);
                        await prevUser.send(`💸 You've been outbid! Your bid of **${auction.currentBid.toLocaleString('en-US')}** coins has been refunded.`);
                    } catch (e) { }
                }

                const slaveName = await getDisplayName(auction.slaveId, message.guild);
                const timeLeft = Math.floor(auction.endTime / 1000);

                const embed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setTitle("✅ BID PLACED!")
                    .setDescription(
                        `**${message.author.username}** bid **${bidAmount.toLocaleString('en-US')}** coins!\n\n` +
                        `🏷️ **Slave:** ${slaveName}\n` +
                        `💰 **Current Bid:** ${bidAmount.toLocaleString('en-US')}\n` +
                        `⏰ **Ends:** <t:${timeLeft}:R>`
                    );

                return message.channel.send({ embeds: [embed] });
            }

            // VIEW ALL AUCTIONS: !auction list (no mention)
            if (subCmd === 'list' && message.mentions.users.size === 0) {
                const auctions = await Auction.find({ guildId: message.guild.id, active: true });

                if (auctions.length === 0) {
                    return message.reply("No active auctions! Enslave someone and sell them with `!auction list @slave`! >:)");
                }

                const auctionList = await Promise.all(auctions.map(async (auction, index) => {
                    const slaveName = await getDisplayName(auction.slaveId, message.guild);
                    const sellerName = await getDisplayName(auction.sellerId, message.guild);
                    const bidderName = auction.currentBidder ? await getDisplayName(auction.currentBidder, message.guild) : 'None';
                    const timeLeft = Math.floor(auction.endTime / 1000);

                    return `**${index + 1}.** **${slaveName}** (Owner: ${sellerName})\n` +
                        `   💰 Current Bid: ${auction.currentBid.toLocaleString('en-US')} | Bidder: ${bidderName}\n` +
                        `   ⏰ Ends: <t:${timeLeft}:R>`;
                }));

                const embed = new EmbedBuilder()
                    .setColor(0xFFD700)
                    .setTitle("🔨 Active Slave Auctions")
                    .setDescription(auctionList.join('\n\n') + '\n\nUse `!auction bid [amount]` to bid!')
                    .setFooter({ text: `Total: ${auctions.length} auction(s)` });

                return message.channel.send({ embeds: [embed] });
            }

            // VIEW SPECIFIC AUCTION: !auction view [number]
            if (subCmd === 'view') {
                const auctionIndex = parseInt(args[2]) - 1;
                const auctions = await Auction.find({ guildId: message.guild.id, active: true });

                if (isNaN(auctionIndex) || auctionIndex < 0 || auctionIndex >= auctions.length) {
                    return message.reply(`Invalid auction number! Use \`!auction list\` to see all.`);
                }

                const auction = auctions[auctionIndex];
                const slaveData = await User.findOne({ userId: auction.slaveId });
                const slaveName = await getDisplayName(auction.slaveId, message.guild);
                const sellerName = await getDisplayName(auction.sellerId, message.guild);
                const bidderName = auction.currentBidder ? await getDisplayName(auction.currentBidder, message.guild) : 'None yet';

                // Get loan info
                const loan = await Loan.findOne({ borrowerId: auction.slaveId, lenderId: auction.sellerId, status: { $in: ['ACTIVE', 'DEFAULTED'] } });
                const debt = loan ? loan.remainingAmount : 0;

                const allTimeMessages = slaveData?.stats?.allTime?.messages || 0;
                const prestige = slaveData?.prestige || 0;
                const elo = slaveData?.elo || 1000;
                const wins = slaveData?.wins || 0;
                const losses = slaveData?.losses || 0;

                const timeLeft = Math.floor(auction.endTime / 1000);

                const embed = new EmbedBuilder()
                    .setColor(0xFF1493)
                    .setTitle(`🔍 Auction Details: ${slaveName}`)
                    .setDescription(
                        `**Current Owner:** ${sellerName}\n` +
                        `**Outstanding Debt:** ${debt.toLocaleString('en-US')} coins\n\n` +
                        `📊 **Stats:**\n` +
                        `• All-Time Messages: ${allTimeMessages.toLocaleString('en-US')}\n` +
                        `• Prestige Level: ${prestige}\n` +
                        `• Combat Elo: ${elo}\n` +
                        `• W/L Ratio: ${wins}/${losses}\n\n` +
                        `💰 **Bidding:**\n` +
                        `• Minimum Bid: ${auction.minimumBid.toLocaleString('en-US')}\n` +
                        `• Current Bid: ${auction.currentBid.toLocaleString('en-US')}\n` +
                        `• High Bidder: ${bidderName}\n\n` +
                        `⏰ **Ends:** <t:${timeLeft}:R>`
                    )
                    .setThumbnail(slaveData ? (await message.guild.members.fetch(auction.slaveId).catch(() => null))?.user.displayAvatarURL() : null);

                return message.channel.send({ embeds: [embed] });
            }

            // CANCEL AUCTION: !auction cancel
            if (subCmd === 'cancel') {
                const auction = await Auction.findOne({ sellerId: message.author.id, guildId: message.guild.id, active: true });

                if (!auction) {
                    return message.reply("You don't have any active auctions to cancel!");
                }

                if (auction.currentBid > 0) {
                    return message.reply("🚫 Can't cancel! Someone already bid! The auction must complete! (¬_¬)");
                }

                auction.active = false;
                await auction.save();

                return message.reply("✅ Auction cancelled. Your slave remains yours (for now...).");
            }

            // HELP
            return message.reply(
                "**🔨 Auction Commands:**\n" +
                "• `!auction list @slave` - Create 24h auction\n" +
                "• `!auction bid [amount]` - Place bid\n" +
                "• `!auction list` - View all auctions\n" +
                "• `!auction view [number]` - View details\n" +
                "• `!auction cancel` - Cancel (only if zero bids)"
            );
        }

        // --- !LOAN ---
        if (cmd === '!loan') {
            const args = message.content.split(' ');

            // 1. DASHBOARD VIEW (No Args)
            if (args.length === 1) {
                let myDebt = await Loan.findOne({ borrowerId: message.author.id, status: { $in: ACTIVE_LOAN_STATUSES } });
                if (!myDebt) myDebt = await Loan.findOne({ borrowerId: message.author.id }).sort({ dueDate: -1 });

                const loansGiven = await Loan.find({ lenderId: message.author.id, status: 'ACTIVE' });
                const mySlaves = await User.find({ slaveOwner: message.author.id });

                const embed = new EmbedBuilder()
                    .setColor(0xFEE75C)
                    .setTitle(`🏦 ${message.author.username}'s Loan Dashboard`);

                if (myDebt) {
                    const repaid = myDebt.totalRepayment - myDebt.remainingAmount;
                    let timeStr = "";
                    if (myDebt.status === 'DEFAULTED') timeStr = "❌ **DEFAULTED (Slave)**";
                    else if (myDebt.status === 'PAID') timeStr = "✅ **Paid Off**";
                    else timeStr = `<t:${Math.floor(myDebt.dueDate / 1000)}:R>`;

                    embed.addFields({
                        name: '📉 My Debt',
                        value: `**Lender:** <@${myDebt.lenderId}>\n**Paid:** ${repaid} / ${myDebt.totalRepayment}\n**Owe:** ${myDebt.remainingAmount}\n**Status:** ${timeStr}`
                    });
                } else {
                    embed.addFields({ name: '📉 My Debt', value: "You are debt-free! (For now...)" });
                }

                if (loansGiven.length > 0) {
                    const givenList = await Promise.all(loansGiven.map(async l => {
                        const name = await getDisplayName(l.borrowerId, message.guild);
                        const repaid = l.totalRepayment - l.remainingAmount;
                        return `• **${name}**: Paid ${repaid}/${l.totalRepayment}. (Slave in <t:${Math.floor(l.dueDate / 1000)}:R>)`;
                    }));
                    embed.addFields({ name: '📈 Active Loans Given', value: givenList.join('\n') });
                } else {
                    embed.addFields({ name: '📈 Active Loans Given', value: "You haven't lent money to anyone." });
                }

                if (mySlaves.length > 0) {
                    const slaveList = await Promise.all(mySlaves.map(async s => {
                        const name = await getDisplayName(s.userId, message.guild);
                        let sLoan = await Loan.findOne({ borrowerId: s.userId, lenderId: message.author.id, status: { $in: ACTIVE_LOAN_STATUSES } });
                        if (!sLoan) sLoan = await Loan.findOne({ borrowerId: s.userId, lenderId: message.author.id }).sort({ dueDate: -1 });

                        let debtStatus = "Unknown";
                        if (sLoan) {
                            if (sLoan.remainingAmount <= 0) debtStatus = "✅ Paid (Still Slave)";
                            else debtStatus = `❌ Owes ${sLoan.remainingAmount}`;
                        }

                        // Calculate hourly passive income (matches index.js calculation)
                        const dailyMessages = s.stats?.daily?.messages || 0;
                        const prestige = s.prestige || 0;
                        const prestigeMultiplier = 1.0 + (prestige * 0.2);
                        const hourlyIncome = Math.floor(config.ECONOMY.SLAVE_BASE_INCOME + (dailyMessages / config.ECONOMY.SLAVE_MESSAGE_DIVISOR) * prestigeMultiplier);

                        // Get total income generated by this slave
                        const totalGenerated = s.slaveIncomeGenerated || 0;

                        return `• **${name}**: ${debtStatus}\n  💰 Hourly: **${hourlyIncome}** coins/hour | Total Generated: **${totalGenerated.toLocaleString('en-US')}** coins`;
                    }));
                    let slaveValue = '';
                    let shown = 0;
                    for (const entry of slaveList) {
                        const suffix = `\n*...and ${slaveList.length - shown - 1} more slave(s). You absolute tyrant. (¬_¬)*`;
                        if (slaveValue.length + entry.length + 1 > 1024 - suffix.length) {
                            slaveValue += `\n*...and ${slaveList.length - shown} more slave(s). You absolute tyrant. (¬_¬)*`;
                            break;
                        }
                        if (shown > 0) slaveValue += '\n';
                        slaveValue += entry;
                        shown++;
                    }
                    embed.addFields({ name: '⛓️ My Slaves', value: slaveValue });
                } else {
                    embed.addFields({ name: '⛓️ My Slaves', value: "You own no slaves. Pathetic." });
                }

                return message.reply({ embeds: [embed] });
            }

            // 2. REPAY
            if (args[1] && args[1].toLowerCase() === 'repay') {
                const loan = await Loan.findOne({ borrowerId: message.author.id, status: { $in: ACTIVE_LOAN_STATUSES } });
                if (!loan) return message.reply("You don't have any debts, idiot! Stop trying to give me money! (¬_¬)");
                if (user.coins < loan.remainingAmount) return message.reply(`You're too poor to repay your debt! You owe **${loan.remainingAmount}** but only have **${user.coins}**! Pathetic!`);

                const repaidAmount = loan.remainingAmount;

                // Atomic: deduct borrower first; never credit lender if this fails.
                const borrowerDeducted = await User.findOneAndUpdate(
                    { userId: message.author.id, coins: { $gte: repaidAmount } },
                    { $inc: { coins: -repaidAmount } },
                    { new: true }
                );
                if (!borrowerDeducted) {
                    return message.reply(`You're too poor to repay your debt! You owe **${repaidAmount}** but can't pay right now!`);
                }

                // Atomic loan close with optimistic lock; rollback borrower if race lost.
                const updatedLoan = await Loan.findOneAndUpdate(
                    { _id: loan._id, status: { $in: ACTIVE_LOAN_STATUSES }, remainingAmount: repaidAmount },
                    { $set: { status: 'PAID', remainingAmount: 0 } },
                    { new: true }
                );
                
                if (!updatedLoan) {
                    await User.updateOne({ userId: message.author.id }, { $inc: { coins: repaidAmount } });
                    return message.reply("Loan state changed while processing. No coins were taken; try again. (¬_¬)");
                }

                // Atomic: credit lender
                await User.findOneAndUpdate({ userId: updatedLoan.lenderId }, { $inc: { coins: repaidAmount } }, { upsert: true });

                // Free borrower (if enslaved) and reset carrot state.
                await User.findOneAndUpdate(
                    { userId: message.author.id },
                    {
                        $set: {
                            isSlave: false,
                            slaveOwner: null,
                            carrotResistUsed: false,
                            resistExpiresAt: 0,
                            ...CARROT_RESET_SET
                        }
                    }
                );

                try {
                    const member = await message.guild.members.fetch(message.author.id);
                    if (member.manageable) {
                        const oldName = member.displayName;
                        const newName = oldName.replace(/\s\([^)]*'s Slave\)$/, "");
                        if (newName !== oldName) await member.setNickname(newName);
                    }
                } catch (e) { }

                // Restore relationship suffix if dating/married (fire-and-forget)
                (async () => {
                    try {
                        const rel = await Relationship.findOne({
                            $or: [
                                { user1Id: message.author.id, status: { $in: ['dating', 'married'] } },
                                { user2Id: message.author.id, status: { $in: ['dating', 'married'] } }
                            ]
                        });
                        if (rel) {
                            const partnerId = rel.user1Id === message.author.id ? rel.user2Id : rel.user1Id;
                            await applyRelationshipSuffix(message.guild, message.author.id, partnerId, rel.status);
                        }
                    } catch (e) { }
                })();

                return message.reply(`💸 **DEBT CLEARED!** You repaid **${repaidAmount} coins** to <@${updatedLoan.lenderId}>! You're finally free... for now!`);
            }

            // 3. FORGIVE (NEW COMMAND)
            if (args[1] && args[1].toLowerCase() === 'forgive') {
                const target = message.mentions.users.first();
                if (!target) return message.reply("Who are you forgiving? The air? Tag someone, baka! (¬_¬)");

                const targetUser = await User.findOne({ userId: target.id });
                const isMySlave = targetUser && targetUser.isSlave && targetUser.slaveOwner === message.author.id;

                const activeLoan = await Loan.findOne({
                    lenderId: message.author.id,
                    borrowerId: target.id,
                    status: { $in: ACTIVE_LOAN_STATUSES }
                });

                if (!isMySlave && !activeLoan) return message.reply(`**${target.username}** isn't your slave and doesn't owe you anything! Stop acting like a savior! (¬_¬)`);

                let msg = `😤 **Hmph!** You're way too soft!`;

                if (activeLoan) {
                    const updateResult = await Loan.findOneAndUpdate(
                        { _id: activeLoan._id, lenderId: message.author.id, status: { $in: ACTIVE_LOAN_STATUSES } },
                        { $set: { remainingAmount: 0, status: 'PAID' } }
                    );
                    if (updateResult) {
                        msg += `\n💸 Debt forgiven...`;
                    } else {
                        return message.reply("The loan state changed while I was looking! Try again. (¬_¬)");
                    }
                }

                if (isMySlave || (targetUser && targetUser.isSlave && activeLoan)) {
                    if (targetUser.isSlave && targetUser.slaveOwner === message.author.id) {
                        await User.findOneAndUpdate(
                            { userId: target.id, isSlave: true, slaveOwner: message.author.id },
                            {
                                $set: {
                                    isSlave: false,
                                    slaveOwner: null,
                                    carrotResistUsed: false,
                                    resistExpiresAt: 0,
                                    ...CARROT_RESET_SET
                                }
                            }
                        );
                        msg += `\n🕊️ Slave status revoked...`;

                        try {
                            const member = await message.guild.members.fetch(target.id);
                            if (member.manageable) {
                                const oldName = member.displayName;
                                const newName = oldName.replace(/\s\([^)]*'s Slave\)$/, "");
                                if (newName !== oldName) await member.setNickname(newName);
                            }
                        } catch (e) { }

                        // Restore relationship suffix if dating/married (fire-and-forget)
                        (async () => {
                            try {
                                const fRel = await Relationship.findOne({
                                    $or: [
                                        { user1Id: target.id, status: { $in: ['dating', 'married'] } },
                                        { user2Id: target.id, status: { $in: ['dating', 'married'] } }
                                    ]
                                });
                                if (fRel) {
                                    const pId = fRel.user1Id === target.id ? fRel.user2Id : fRel.user1Id;
                                    await applyRelationshipSuffix(message.guild, target.id, pId, fRel.status);
                                }
                            } catch (e) { }
                        })();
                    }
                }

                msg += `\n\n*I-It's not like I think that was kind or anything...* >///<`;
                return message.reply(msg);
            }


            // 4. CREATE LOAN
            if (args.length < 4) return message.reply("Usage: `!loan @user [amount] [interest(1-20)]` or `!loan repay/forgive`");

            const target = message.mentions.users.first();
            if (!target) return message.reply("Tag a user to loan money to, baka! (¬_¬)");
            if (target.id === message.author.id) return message.reply("You can't loan money to yourself, idiot!");
            if (target.bot) return message.reply("I don't need your money! >///<");

            const amount = parseInt(args[2]);
            const interest = parseInt(args[3]);

            if (isNaN(amount) || amount <= 0) return message.reply("Invalid amount! Are you stupid?");
            if (isNaN(interest) || interest < 1 || interest > 20) return message.reply("Interest must be between 1% and 20%, you greedy pig!");

            if (user.coins < amount) return message.reply(`You're too broke to loan that much! Balance: ${user.coins.toLocaleString('en-US')}`);
            const activeLoansCount = await Loan.countDocuments({ lenderId: message.author.id, status: 'ACTIVE' });
            if (activeLoansCount >= 6) {
                return message.reply("H-Hah? You're lending to too many people! I'm not your personal accountant! Collect your debts first, you generous idiot! (¬_¬)");
            }
            // --------------------------------
            const borrower = await User.findOne({ userId: target.id }) || new User({ userId: target.id });

            if (borrower.isSlave) return message.reply(`🚫 **${target.username}** is already a slave! They have no financial rights!`);

            const activeLoan = await Loan.findOne({ borrowerId: target.id, status: { $in: ['ACTIVE', 'DEFAULTED'] } });
            if (activeLoan) return message.reply(`🚫 **${target.username}** already has an active debt! Don't pile it on!`);

            const totalRepay = Math.floor(amount * (1 + interest / 100));

            const embed = new EmbedBuilder()
                .setColor(0xFEE75C)
                .setTitle("💸 Loan Offer")
                .setDescription(
                    `**${message.author.username}** is offering a loan to **${target.username}**!\n\n` +
                    `💰 **Amount:** ${amount.toLocaleString('en-US')}\n` +
                    `📈 **Interest:** ${interest}%\n` +
                    `💸 **Repayment:** ${totalRepay.toLocaleString('en-US')}\n` +
                    `⏳ **Due:** 3 Days\n\n` +
                    `*Do you accept these terms?*`
                );

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`loan_accept_${message.author.id}_${target.id}_${amount}_${interest}`)
                    .setLabel('Accept Loan')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('🤝'),
                new ButtonBuilder()
                    .setCustomId(`loan_decline_${message.author.id}_${target.id}`)
                    .setLabel('Decline')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('✖️')
            );

            return message.reply({ content: `<@${target.id}>`, embeds: [embed], components: [row] });
        }

        // --- !VAULT SYSTEM ---
        if (cmd === '!vault') {
            // Always refresh before vault operations to avoid stale balances/limits.
            user = await User.findOne({ userId: message.author.id });
            if (!user) user = await User.create({ userId: message.author.id });

            const args = message.content.split(' ');
            const subCmd = args[1]?.toLowerCase();
            const amount = args[2] === 'all' ? 'all' : parseInt(args[2]?.replace(/,/g, ''));

            // Calculate Max Capacity from shared utility
            const prestigeLevel = user.prestige || 0;
            const vaultTier = user.upgrades?.vaultTier || 0;
            const titanVaultUsed = !!user.titanVaultUsed;
            const maxCapacity = getVaultCap(prestigeLevel, vaultTier, titanVaultUsed);
            const interestRate = (config.VAULT.INTEREST_RATE * 100).toFixed(0);
            const withdrawLimitPercent = (config.VAULT.WITHDRAWAL_LIMIT * 100).toFixed(0);

            // 1. DEPOSIT
            if (subCmd === 'deposit' || subCmd === 'dep') {
                let depAmount = amount;
                if (amount === 'all') depAmount = user.coins;

                if (isNaN(depAmount) || depAmount <= 0) return message.reply("Hah? How much? Speak up! (¬_¬)");
                if (user.isSlave) return message.reply("Slaves can't use the vault! Pay your debts first, trash! (¬_¬)");
                if (user.coins < depAmount) return message.reply(`You're too poor for that. Wallet: **${user.coins.toLocaleString('en-US')}**.`);

                const currentVault = user.vaultCoins || 0;

                if (currentVault + depAmount > maxCapacity) {
                    const spaceLeft = maxCapacity - currentVault;
                    return message.reply(`Tch. It won't fit. Space left: **${spaceLeft.toLocaleString('en-US')}**.`);
                }

                const depositUpdate = { $inc: { coins: -depAmount, vaultCoins: depAmount } };
                    if (!user.lastVaultInterest || user.lastVaultInterest === 0) {
                        depositUpdate.$set = { lastVaultInterest: Date.now() };
                    }

                    // Atomic deposit: checks both balance and capacity in the query filter
                    const depResult = await User.findOneAndUpdate(
                        {
                            userId: message.author.id,
                            coins: { $gte: depAmount },
                            vaultCoins: { $lte: maxCapacity - depAmount }
                        },
                        depositUpdate,
                        { new: true }
                    );
                    if (!depResult) {
                        // Distinguish between broke and vault-full so the error is accurate
                        const freshCheck = await User.findOne({ userId: message.author.id }).select('coins vaultCoins').lean();
                        const spaceLeft = maxCapacity - (freshCheck?.vaultCoins || 0);
                        if ((freshCheck?.coins || 0) < depAmount) {
                            return message.reply(`You're too poor for that. Wallet: **${(freshCheck?.coins || 0).toLocaleString('en-US')}**.`);
                        }
                        return message.reply(
                            `🏦 **Vault can't fit that!**\n` +
                            `Space remaining: **${spaceLeft.toLocaleString('en-US')}** / ${maxCapacity.toLocaleString('en-US')}\n` +
                            `You tried to deposit: **${depAmount.toLocaleString('en-US')}**\n\n` +
                            `*Withdraw something first, you hoarder! (¬_¬)*`
                        );
                    }
                    user = depResult;

                const embed = new EmbedBuilder()
                    .setColor(0xC0C0C0) // Silver
                    .setDescription(
                        `**[VAULT DEPOSIT]**\n` +
                        `Stored **${depAmount.toLocaleString('en-US')}** coins.\n` +
                        `\`Balance: ${user.vaultCoins.toLocaleString('en-US')} / ${maxCapacity.toLocaleString('en-US')}\`\n\n` +
                        `*I'll keep it safe. Don't expect me to thank you.*`
                    );
                return message.reply({ embeds: [embed] });
            }

            // 2. WITHDRAW
            if (subCmd === 'withdraw' || subCmd === 'with') {
                const freshUser = await User.findOne({ userId: message.author.id }).lean();
                if (!freshUser) {
                    return message.reply("Something shifted while processing — your vault or limit may have changed. Check !vault and try again! (¬_¬)");
                }

                const currentVault = freshUser.vaultCoins || 0;
                let withAmount = amount;

                // Calculate Daily Limit
                const dailyLimit = currentVault > 0
                    ? Math.max(1, Math.floor(currentVault * config.VAULT.WITHDRAWAL_LIMIT))
                    : 0;
                const alreadyWithdrawn = freshUser.vaultDailyWithdrawn || 0;
                const remainingLimit = Math.max(0, dailyLimit - alreadyWithdrawn);

                if (amount === 'all') {
                    if (remainingLimit <= 0) return message.reply("You've already hit your daily limit, you addict! (¬_¬)");
                    withAmount = remainingLimit;
                }

                if (isNaN(withAmount) || withAmount <= 0) return message.reply("Withdraw how much? Don't waste my time.");
                if (currentVault < withAmount) return message.reply(`You don't have that much. Vault: **${currentVault.toLocaleString('en-US')}**.`);

                // Restrict to Limit
                if (withAmount > remainingLimit) {
                    return message.reply(
                        `**[ACCESS DENIED]**\n` +
                        `Daily Limit reached (${withdrawLimitPercent}%).\n` +
                        `Remaining: **${remainingLimit.toLocaleString('en-US')}** coins.\n\n` +
                        `*Learn some self-control, idiot.*`
                    );
                }

                const forgeBonusCap = (freshUser.upgrades?.walletTier || 0) * config.ECONOMY.FORGE_WALLET_CAP_PER_TIER;
                const walletCap = config.ECONOMY.BASE_WALLET_CAP + ((freshUser.prestige || 0) * config.ECONOMY.WALLET_CAP_PER_LEVEL) + forgeBonusCap;
                const walletSpace = Math.max(0, walletCap - (freshUser.coins || 0));
                if (walletSpace === 0) {
                    return message.reply("Your wallet is full! You can't hold any more coins. (¬_¬)");
                }

                let clampedByWallet = false;
                if (withAmount > walletSpace) {
                    withAmount = walletSpace;
                    clampedByWallet = true;
                }

                // Atomic withdrawal: checks vault balance and daily limit in query filter
                const withResult = await User.findOneAndUpdate(
                    {
                        userId: message.author.id,
                        vaultCoins: { $gte: withAmount },
                        vaultDailyWithdrawn: { $lte: dailyLimit - withAmount }
                    },
                    {
                        $inc: { vaultCoins: -withAmount, coins: withAmount, vaultDailyWithdrawn: withAmount }
                    },
                    { new: true }
                );
                if (!withResult) return message.reply("Something shifted while processing — your vault or limit may have changed. Check !vault and try again! (¬_¬)");
                user = withResult;

                const newDailyLimit = user.vaultCoins > 0
                    ? Math.max(1, Math.floor(user.vaultCoins * config.VAULT.WITHDRAWAL_LIMIT))
                    : 0;
                const newUsed = user.vaultDailyWithdrawn || 0;
                const newRemaining = Math.max(0, newDailyLimit - newUsed);
                const clampWarning = clampedByWallet
                    ? `\n⚠️ Clamped to ${withAmount.toLocaleString('en-US')}c — your wallet can't hold more without burning it.`
                    : '';

                const embed = new EmbedBuilder()
                    .setColor(0xC0C0C0)
                    .setDescription(
                        `**[VAULT WITHDRAWAL]**\n` +
                        `Withdrew **${withAmount.toLocaleString('en-US')}** coins.\n` +
                        `\`Remaining Limit: ${newRemaining.toLocaleString('en-US')} / ${newDailyLimit.toLocaleString('en-US')}\`` +
                        `${clampWarning}\n\n` +
                        `*Spending it already? Pathetic.*`
                    );
                return message.reply({ embeds: [embed] });
            }

            // 3. STATUS (Default)
            const dailyLimit = (user.vaultCoins || 0) > 0
                ? Math.max(1, Math.floor((user.vaultCoins || 0) * config.VAULT.WITHDRAWAL_LIMIT))
                : 0;
            const used = user.vaultDailyWithdrawn || 0;
            const remaining = Math.max(0, dailyLimit - used);

            // Activity Check
            const now = Date.now();
            const lastActive = user.lastActiveTime || 0;
            const isActive = (now - lastActive) < (24 * 60 * 60 * 1000);
            const statusText = isActive ? "Active" : "Inactive (No Interest)";

            const embed = new EmbedBuilder()
                .setColor(0xC0C0C0)
                .setTitle(`🏦 ${message.author.username}'s Vault`)
                .setDescription(
                    `\`\`\`ini\n` +
                    `[ CAPACITY ]\n` +
                    `Balance : ${(user.vaultCoins || 0).toLocaleString('en-US')} / ${maxCapacity.toLocaleString('en-US')}\n` +
                    `Wallet  : ${user.coins.toLocaleString('en-US')}\n\n` +
                    `[ INTEREST ]\n` +
                    `Rate    : ${interestRate}% Daily\n` +
                    `Status  : ${statusText}\n\n` +
                    `[ LIMITS ]\n` +
                    `Daily   : ${withdrawLimitPercent}%\n` +
                    `Used    : ${used.toLocaleString('en-US')} / ${dailyLimit.toLocaleString('en-US')}\n` +
                    `\`\`\`\n` +
                    `*It's not like I'm guarding this for you... I just like counting money.*`
                )
                .setFooter({ text: "!vault deposit <amt> | !vault withdraw <amt>" });

            return message.reply({ embeds: [embed] });
        }
    },

    // --- INTERACTION HANDLER ---
    handleInteraction: async (interaction, client) => {

        if (interaction.isStringSelectMenu() && interaction.customId.startsWith('gacha_tier_select')) {
            const ownerId = interaction.customId.split('_')[3];
            if (ownerId && interaction.user.id !== ownerId) return interaction.reply({ content: "This isn't your dashboard! (¬_¬)", ephemeral: true });
            await handleGachaDashboardSelect(interaction, client);
            return;
        }

        if (interaction.isButton()) {
            if (interaction.customId.startsWith('gacha_dashboard')) {
                const ownerId = interaction.customId.split('_')[2];
                if (ownerId && interaction.user.id !== ownerId) return interaction.reply({ content: "This isn't your dashboard! (¬_¬)", ephemeral: true });
                const freshUser = await User.findOne({ userId: interaction.user.id });
                await showGachaDashboard(interaction, freshUser);
                return;
            }

            if (interaction.customId.startsWith('gacha_pull_')) {
                const parts = interaction.customId.split('_');
                const pullCount = parseInt(parts[2]);
                const tier = parts[3];
                const ownerId = parts[4];
                
                if (ownerId && interaction.user.id !== ownerId) return interaction.reply({ content: "This isn't your dashboard! Type `!gacha` to spawn your own! (¬_¬)", ephemeral: true });
                if (tier === 'none') return interaction.reply({ content: 'Select a banner first! (¬_¬)', ephemeral: true });

                const freshUser = await User.findOne({ userId: interaction.user.id });
                if (!freshUser) return interaction.reply({ content: "You don't exist in my database! (¬_¬)", ephemeral: true });
                
                await executeGachaPull(interaction, freshUser, tier, pullCount, client);
                return;
            }

            // --- ROULETTE BUTTONS ---
            if (interaction.customId.startsWith('rr_continue_') || interaction.customId.startsWith('rr_cashout_')) {
                const parts = interaction.customId.split('_');
                const action = parts[1]; // 'continue' or 'cashout'
                const ownerId = parts[2];

                if (interaction.user.id !== ownerId) {
                    return interaction.reply({ content: "Not your gun, not your game! Back off, baka! (¬_¬)", flags: MessageFlags.Ephemeral });
                }

                const game = rrGames.get(ownerId);
                if (!game) {
                    return interaction.update({ content: "This game already ended! Start a new one with `!rr <bet>`, baka! (¬_¬)", embeds: [], components: [] });
                }

                // Clear auto-cashout timeout
                if (game.autoTimeout) clearTimeout(game.autoTimeout);

                if (action === 'cashout') {
                    await rouletteCashout(game, 'manual');
                } else {
                    game.round++;
                    await playRouletteRound(interaction, game, true);
                }
                return;
            }
        }

        if (!interaction.guild) return;
        // Only handle economy-related interactions
        const id = interaction.customId;
        if (!id) return;
        const ECONOMY_PREFIXES = ['rr_', 'isekai_', 'shop_', 'merchant_', 'equip_', 'unequip_', 'gacha_', 'amulet_', 'loan_', 'bag_page_', 'bag_tab_', 'color_modal', 'snatch_modal', 'sugar_', 'bait_buy_modal'];
        if (!ECONOMY_PREFIXES.some(p => id.startsWith(p))) return;

        let user = await User.findOne({ userId: interaction.user.id });
        if (!user) user = await User.create({ userId: interaction.user.id });

        // --- ISEKAI BUTTONS ---
        if (interaction.customId.startsWith('isekai_cancel')) {
            const parts = interaction.customId.split('_');
            const targetUserId = parts[2];
            if (targetUserId && interaction.user.id !== targetUserId) {
                return interaction.reply({ content: "That's not your truck! Back off! (¬_¬)", flags: MessageFlags.Ephemeral });
            }
            return interaction.update({ content: "🚚 Truck-kun drives away. You live another day.", embeds: [], components: [] });
        }

        if (interaction.customId.startsWith('isekai_confirm')) {
            const parts = interaction.customId.split('_');
            const targetUserId = parts[2];
            if (targetUserId && interaction.user.id !== targetUserId) {
                return interaction.reply({ content: "That's not your truck! Back off! (¬_¬)", flags: MessageFlags.Ephemeral });
            }
            const roles = config.ROLES.PRESTIGE || ["Iron", "Bronze", "Silver", "Gold", "Platinum", "Diamond", "Master"];
            const costs = config.ECONOMY.PRESTIGE_COSTS;

            const freshUser = await User.findOne({ userId: interaction.user.id });
            
            const activeLoan = await Loan.findOne({ borrowerId: interaction.user.id, status: { $in: ['ACTIVE', 'DEFAULTED'] } });
            if (activeLoan) return interaction.reply({ content: "Truck-kun doesn't pick up deadbeats. Repay your loans first, baka.", flags: MessageFlags.Ephemeral });
            if (freshUser.isSlave) return interaction.reply({ content: "A slave dreaming of reincarnation? Cute. Buy your freedom first, baka.", flags: MessageFlags.Ephemeral });

            const currentLevel = freshUser.prestige || 0;

            // Recalculate Max Level (To prevent glitches/money changes)
            let reachableLevel = currentLevel;
            let accumulatedCost = 0;
            let remainingCoins = freshUser.coins;

            const hasDiscount = freshUser.isekaiDiscountActive;
            for (let i = currentLevel; i < 7; i++) {
                const levelCost = hasDiscount
                    ? Math.floor(costs[i] * 0.75)
                    : costs[i];
                if (remainingCoins >= levelCost) {
                    accumulatedCost += levelCost;
                    remainingCoins -= levelCost;
                    reachableLevel++;
                } else {
                    break;
                }
            }

            if (reachableLevel === currentLevel) {
                return interaction.update({ content: "🚫 You went broke before the truck hit you! Transaction failed!", embeds: [], components: [] });
            }

            // 1. THE WIPE (atomic: verify prestige hasn't changed since calculation)
            const oldTitle = freshUser.equippedTitle;
            const wipeResult = await User.findOneAndUpdate(
                { userId: interaction.user.id, prestige: currentLevel, coins: { $gte: accumulatedCost } },
                {
                    $set: {
                        coins: 0,
                        inventory: [],
                        bounty: 0,
                        prestige: reachableLevel,
                        equippedTitle: null,
                        frameColor: null,
                        equippedShield: false,
                        equippedAmuletCount: 0,
                        isekaiDiscountActive: false,
                        'fishing.inventory': [],
                        'fishing.gear.ownedBaits': {},
                        'fishing.gear.activeBait': 'none',
                        'fishing.gear.baitCount': 0,
                        'fishing.dailyBounty.targetBiome': null,
                        'fishing.dailyBounty.targetRarity': null,
                        'fishing.dailyBounty.amountNeeded': 0,
                        'fishing.dailyBounty.amountCaught': 0,
                        'fishing.dailyBounty.rewardTier': null,
                        'fishing.dailyBounty.expiresAt': 0
                    }
                },
                { new: true }
            );
            if (!wipeResult) {
                return interaction.update({ content: "\ud83d\udeab You went broke before the truck hit you! Transaction failed!", embeds: [], components: [] });
            }

            // Remove old title role from Discord
            if (oldTitle) {
                await roleSync.syncUserTitleRole(interaction.guild, interaction.user.id, null, oldTitle);
            }

            // 2. ROLE UPDATE
            try {
                const member = await interaction.guild.members.fetch(interaction.user.id);
                // Remove ALL prestige roles to be safe (case-insensitive matching)
                const allPrestigeRoles = roles.map(r => interaction.guild.roles.cache.find(gr => gr.name.toLowerCase() === r.toLowerCase())).filter(r => r);
                if (allPrestigeRoles.length > 0) await member.roles.remove(allPrestigeRoles);

                // Add the new Target role (case-insensitive matching)
                const targetRoleName = roles[reachableLevel - 1];
                const newRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === targetRoleName.toLowerCase());
                if (newRole) {
                    await member.roles.add(newRole);
                } else {
                    console.log(`⚠️ Prestige role "${targetRoleName}" not found in server!`);
                }
            } catch (e) {
                console.log("Isekai Role Error (Check Bot Permissions):", e);
            }

            const successEmbed = new EmbedBuilder()
                .setColor(0x00FFFF)
                .setTitle("✨ REINCARNATION COMPLETE ✨")
                .setDescription(
                    `**${interaction.user.username}** died and was reborn!\n\n` +
                    `🌟 **New Rank:** ${roles[reachableLevel - 1]}\n` +
                    `📈 **Levels Gained:** +${reachableLevel - currentLevel}\n` +
                    `💀 **Legacy:** They burned **${accumulatedCost.toLocaleString('en-US')}** coins.`
                )

            // Master bonus: +3 nuggets at prestige 7
            if (reachableLevel === 7 && currentLevel < 7) {
                await User.updateOne(
                    { userId: interaction.user.id },
                    { $inc: { nuggets: 3 } }
                );
                successEmbed.data.description += '\n\n💎 **MASTER BONUS: +3 Nuggets!**';
            }

            // Isekai Discount consumed
            if (hasDiscount) {
                successEmbed.data.description += '\n🎫 **Isekai Discount applied** — 25% off! What a steal! (¬_¬)';
            }

            return interaction.update({ content: null, embeds: [successEmbed], components: [] });
        }

        // SHOP CATEGORY HANDLING
        if (interaction.customId === 'shop_category_selector') {
            const cat = interaction.values[0];

            // --- INFLATION CALC HELPER ---
            const getPrice = (base) => base + Math.floor((user.coins || 0) * config.SHOP_PRICES.WEALTH_TAX_RATE);
            const p = (base) => getPrice(base).toLocaleString('en-US'); // Format number
            // -----------------------------

            let options = [];
            let desc = "";

            if (cat === 'cat_titles') {
                desc = `**🏷️ TITLES**\n*Price = Base + 10% of net worth.*`;
                const cost = p(50000); // Titles base cost

                options = [
                    { label: `Onee-san's FuckToy (${cost}c)`, value: "title_Onee-sans_FuckToy" },
                    { label: `2D > 3D (${cost}c)`, value: "title_2D_>_3D" },
                    { label: `Lewd Handholding (${cost}c)`, value: "title_Lewd_Handholding" },
                    { label: `Cutiepie (${cost}c)`, value: "title_Cutiepie" },
                    { label: `IDF Soldier (${cost}c)`, value: "title_IDF_Soldier" },
                    { label: `Seinen Addict (${cost}c)`, value: "title_seinen_addict" },
                    { label: `NTR Enjoyer (${cost}c)`, value: "title_ntr_enjoyer" },
                    { label: `Ugly Bastard (${cost}c)`, value: "title_ugly_bastard" },
                    { label: `Facing Allegations (${cost}c)`, value: "title_facing_allegations" },
                    { label: `Certified Gambler (${cost}c)`, value: "title_certified_gambler" }
                ];
            } else if (cat === 'cat_items') {
                desc = "**⚔️ ITEMS & UPGRADES**\n*Price = Base + 10% of net worth.*";
                options = [
                    { label: `Random Frame (${p(2000)}c)`, value: "frame_random" },
                    { label: `Custom Frame (${p(5000)}c)`, value: "frame_custom" },
                    { label: `Elo Shield (${p(40000)}c)`, value: "item_shield" },
                    { label: `Coin Amulet (${p(1000)}c)`, value: "item_amulet", description: `Stack up to 50! You have ${user.inventory.filter(i => i === 'Coin Amulet').length + user.equippedAmuletCount}` },
                    { label: `Trash Curse (${p(40000)}c)`, value: "curse_trash" },
                    { label: `Curse of Mediocrity (${Math.max(config.SHOP_PRICES["Curse of Mediocrity"].BASE, Math.floor((user.coins || 0) * config.SHOP_PRICES["Curse of Mediocrity"].WALLET_RATE)).toLocaleString('en-US')}c)`, value: "curse_mediocrity", description: "Nerf someone's gacha for 24h" },
                    { label: `Reset Cooldowns (${p(15000)}c)`, value: "reset_cd" },
                    { label: `Streak Freeze (${Math.max(config.SHOP_PRICES["Streak Freeze"].BASE, Math.floor((user.coins || 0) * config.SHOP_PRICES["Streak Freeze"].WALLET_RATE)).toLocaleString('en-US')}c)`, value: "item_streak_freeze", description: "Auto-saves streak if you miss a day. One use." }
                ];
            } else if (cat === 'cat_special') {
                desc = "**🔥 SPECIAL SERVICES**\n*Price = Base + 10% of net worth*";

                options = [
                    { label: `Slave Tag Remover (${p(10000)}c)`, value: "item_slave_remove", description: "Buy Freedom." },
                    { label: `Role: Sugar Daddy/Mommy (${p(config.SHOP_PRICES.SUGAR_ROLE)}c)`, value: "role_sugar", description: "⚠️ One role per season. Free switch if you own either." }
                ];
            } else if (cat === 'cat_fishing') {
                const ownedBaitsObj = user?.fishing?.gear?.ownedBaits instanceof Map ? Object.fromEntries(user.fishing.gear.ownedBaits) : (user?.fishing?.gear?.ownedBaits || {});
                const baitStock = Object.entries(ownedBaitsObj)
                    .filter(([_, count]) => count > 0)
                    .map(([id, count]) => {
                        const bConf = config.FISHING.GEAR.BAITS[id];
                        return `${bConf ? bConf.emoji : '🪱'} ${bConf ? bConf.name : id}: **${count}**`;
                    }).join(' | ');

                desc = `**🎣 FISHING GEAR**\n*Buy your gear here, idiot! Rods cost Nuggets, Baits scale with your fat wallet! Don't come crying when your rod snaps! (¬_¬)*\n\n📦 **Your Baits:** ${baitStock || 'None! You broke loser! (¬_¬)'}`;
                const pBait = (baitId) => {
                    const b = config.FISHING.GEAR.BAITS[baitId];
                    let cost = b.costBase + Math.floor((user.coins || 0) * b.costScaleMult);
                    return Math.min(cost, b.maxCost).toLocaleString('en-US');
                };
                options = [
                    { label: `Flimsy Stick (Free)`, value: "rod_flimsy_stick", description: "Infinite durability. Basic rewards.", emoji: '🎋' },
                    { label: `Carbon Rod (2 Nuggets)`, value: "rod_carbon_rod", description: "1.5x Rewards. 100 Durability.", emoji: '🎣' },
                    { label: `Deep Sea Rod (5 Nuggets)`, value: "rod_deep_sea_rod", description: "3x Rewards. 200 Durability.", emoji: '🔱' },
                    { label: `Abyssal Rod (10 Nuggets)`, value: "rod_abyssal_rod", description: "7x Rewards. 400 Durability.", emoji: '🌌' },
                    { label: `Worm (${pBait('worm')}c ea)`, value: "bait_worm", description: "+10% Rare+ chance. Pick your qty!", emoji: '🪱' },
                    { label: `Glow Worm (${pBait('glow_worm')}c ea)`, value: "bait_glow_worm", description: "+25% Rare+ chance. Pick your qty!", emoji: '✨' },
                    { label: `Golden Worm (1 Nugget ea)`, value: "bait_golden_worm", description: "Guarantees UR+. Pick your qty!", emoji: '🌟' }
                ];
            } else if (cat === 'cat_merchant') {
                // --- SHADY MERCHANT LOGIC ---
                const SELLABLE_ITEMS = {
                    "Coin Amulet": { base: 1000, minMult: 0.5, maxMult: 1.5 },
                    "Elo Shield": { base: 5000, minMult: 0.1, maxMult: 2.0 },
                    "Trash Curse": { base: 40000, minMult: 0.1, maxMult: 1.5 },
                    "Slave Tag Remover": { base: 10000, minMult: 0.1, maxMult: 1.5 },
                    "Slave Freedom Ticket": { base: 65000, minMult: 0.77, maxMult: 1.23 }
                };

                const MERCHANT_MOODS = [
                    "Tch... back again? Fine, show me your junk. (¬_¬)",
                    "W-What do you want?! I'm not desperate for business!",
                    "Hmph! I MIGHT buy something... if you're lucky.",
                    "Oh, it's YOU again. What garbage are you selling today?",
                    "D-Don't expect good prices! I'm not a charity! >///< "
                ];

                const now = Date.now();
                const oneDayMs = 24 * 60 * 60 * 1000;

                // Check if we need to reset daily values (24h since last refresh)
                if (now - user.merchantLastRefresh >= oneDayMs) {
                    user.merchantDailySold = 0;
                    user.merchantFreeRefreshUsed = false;
                    user.merchantPrices = new Map();
                }

                // Generate prices if none exist
                if (!user.merchantPrices || user.merchantPrices.size === 0) {
                    user.merchantPrices = new Map();
                    for (const [item, config] of Object.entries(SELLABLE_ITEMS)) {
                        const mult = config.minMult + Math.random() * (config.maxMult - config.minMult);
                        const price = Math.floor(config.base * mult);
                        user.merchantPrices.set(item, price);
                    }
                    user.merchantLastRefresh = now;
                    await User.updateOne(
                        { userId: user.userId },
                        { $set: { merchantPrices: user.merchantPrices, merchantLastRefresh: user.merchantLastRefresh } }
                    );
                }

                // Get user's sellable inventory
                const sellableOwned = [];
                for (const itemName of Object.keys(SELLABLE_ITEMS)) {
                    const count = user.inventory.filter(i => i === itemName).length;
                    if (count > 0) {
                        const price = user.merchantPrices.get(itemName) || SELLABLE_ITEMS[itemName].base;
                        sellableOwned.push({ name: itemName, count, price });
                    }
                }

                const dailyRemaining = Math.max(0, 200000 - user.merchantDailySold);
                const refreshCost = user.merchantFreeRefreshUsed ? Math.floor(5000 + (user.coins / 30)) : 0;
                const nextFreeRefresh = user.merchantLastRefresh + oneDayMs;

                const mood = MERCHANT_MOODS[Math.floor(Math.random() * MERCHANT_MOODS.length)];

                const embed = new EmbedBuilder()
                    .setColor(0x4A0080) // Dark purple for shady vibes
                    .setTitle("🏴‍☠️ SHADY MERCHANT")
                    .setDescription(
                        `*"${mood}"*\n\n` +
                        `📦 **Select an item to sell from the dropdown.**\n\n` +
                        `💰 **Daily Limit:** ${dailyRemaining.toLocaleString('en-US')} / 200,000 remaining\n` +
                        `🔄 **Free Refresh:** ${user.merchantFreeRefreshUsed ? `<t:${Math.floor(nextFreeRefresh / 1000)}:R>` : '✅ Available!'}\n` +
                        `⏰ **Prices Reset:** <t:${Math.floor(nextFreeRefresh / 1000)}:R>\n\n` +
                        (sellableOwned.length === 0 ? "❌ *You have nothing to sell! Come back with some items!*" : "")
                    )
                    .setThumbnail(client.user.displayAvatarURL())
                    .setFooter({ text: "Prices reset daily. Use Refresh to reroll!" });

                // Add price list field if they have items
                if (sellableOwned.length > 0) {
                    const priceList = sellableOwned.map(i =>
                        `• **${i.name}** x${i.count} → 🪙 ${i.price.toLocaleString('en-US')}c each`
                    ).join('\n');
                    embed.addFields({ name: "📊 Today's Prices", value: priceList, inline: false });
                }

                const components = [];

                // Only show dropdown if they have items
                if (sellableOwned.length > 0) {
                    const options = sellableOwned.map(i => ({
                        label: `${i.name} (${i.price.toLocaleString('en-US')}c)`,
                        description: `You own: ${i.count}`,
                        value: `merchant_sell_${i.name}`,
                        emoji: i.name === 'Coin Amulet' ? '🪙' : (i.name === 'Elo Shield' ? '🛡️' : '📦')
                    }));

                    const selectRow = new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId('merchant_item_selector')
                            .setPlaceholder('📦 Select item to sell...')
                            .addOptions(options.slice(0, 25))
                    );
                    components.push(selectRow);
                }

                // Refresh button
                const refreshLabel = user.merchantFreeRefreshUsed
                    ? `🔄 Refresh (${refreshCost.toLocaleString('en-US')}c)`
                    : '🔄 Free Refresh!';

                const buttonRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('merchant_refresh')
                        .setLabel(refreshLabel)
                        .setStyle(user.merchantFreeRefreshUsed ? ButtonStyle.Secondary : ButtonStyle.Success)
                        .setDisabled(user.merchantFreeRefreshUsed && user.coins < refreshCost),
                    new ButtonBuilder()
                        .setCustomId('merchant_back')
                        .setLabel('← Back to Shop')
                        .setStyle(ButtonStyle.Danger)
                );
                components.push(buttonRow);

                await interaction.update({ embeds: [embed], components });
                return;
            }

            const embed = new EmbedBuilder()
                .setColor(0x2B2D31)
                .setTitle("MARKETPLACE")
                .setDescription(desc)
                .setThumbnail(client.user.displayAvatarURL());

            const row = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('shop_purchase')
                    .setPlaceholder('Select Item to Buy')
                    .addOptions(options)
            );

            await interaction.update({ embeds: [embed], components: [row] });
            return;
        }

        // 1. LOAN BUTTONS
        if (interaction.customId.startsWith('loan_')) {
            const parts = interaction.customId.split('_');
            const action = parts[1];
            const lenderId = parts[2];
            const borrowerId = parts[3];

            if (interaction.user.id !== borrowerId) {
                return interaction.reply({ content: "This isn't for you, butt out! (¬_¬)", ephemeral: true });
            }

            if (action === 'decline') {
                await interaction.update({ content: "🚫 **Loan Declined!** What a waste of time...", embeds: [], components: [] });
                return;
            }

            if (action === 'accept') {
                // PREVENT DOUBLE CLICK GLITCH: Check if components are already removed by a concurrent click
                if (interaction.message.components.length === 0 || (interaction.message.components[0].components[0] && interaction.message.components[0].components[0].disabled)) {
                    return interaction.reply({ content: "⏳ **Already processing this interaction!** Hold your horses! (¬_¬)", ephemeral: true }); // Ignore duplicate clicks safely
                }
                
                // Immediately disable buttons to lock further clicks
                try {
                    const disabledRow = new ActionRowBuilder().addComponents(
                        interaction.message.components[0].components.map(c => ButtonBuilder.from(c).setDisabled(true))
                    );
                    await interaction.update({ components: [disabledRow] });
                } catch (e) {
                    return; // If it fails here, interaction was likely already acknowledged
                }

                const amount = parseInt(parts[4]);
                const interest = parseInt(parts[5]);
                if (loanAcceptLocks.has(borrowerId)) {
                    return interaction.editReply({ content: "⏳ **Loan is already being processed.** Try again in a moment.", embeds: [], components: [] });
                }
                loanAcceptLocks.add(borrowerId);
                try {
                    // Atomic: check lender balance and deduct
                    const updatedLender = await User.findOneAndUpdate(
                        { userId: lenderId, coins: { $gte: amount } },
                        { $inc: { coins: -amount } },
                        { new: true }
                    );
                    if (!updatedLender) {
                        return interaction.editReply({ content: "🚫 **Loan Failed!** The lender went broke! Unbelievable!", embeds: [], components: [] });
                    }

                    // Atomic: check no existing loan for borrower
                    const existingLoan = await Loan.findOne({ borrowerId: borrowerId, status: { $in: ['ACTIVE', 'DEFAULTED'] } });
                    if (existingLoan) {
                        // Refund lender since loan can't proceed
                        await User.findOneAndUpdate(
                            { userId: lenderId },
                            { $inc: { coins: amount } }
                        );
                        return interaction.editReply({ content: "🚫 **Loan Failed!** You already have a loan! Don't be greedy!", embeds: [], components: [] });
                    }

                    // Atomic: credit borrower with wallet cap enforcement
                    // We cannot use distributeIncome here — it would apply slave tax, rich tax,
                    // prestige bonus, and loan repayment to a loan principal, all of which are wrong.
                    // We only need the wallet cap check, so we do it inline.
                    const borrowerForCap = await User.findOne({ userId: borrowerId }).select('coins prestige upgrades').lean();
                    const borrowerCoins = borrowerForCap?.coins || 0;
                    const borrowerPrestige = borrowerForCap?.prestige || 0;
                    const borrowerForgeTier = borrowerForCap?.upgrades?.walletTier || 0;
                    const borrowerWalletCap = config.ECONOMY.BASE_WALLET_CAP
                        + (borrowerPrestige * config.ECONOMY.WALLET_CAP_PER_LEVEL)
                        + (borrowerForgeTier * config.ECONOMY.FORGE_WALLET_CAP_PER_TIER);
                    const actualCredit = Math.min(amount, Math.max(0, borrowerWalletCap - borrowerCoins));

                    if (actualCredit <= 0) {
                        // Borrower's wallet is full — refund lender and abort
                        await User.findOneAndUpdate(
                            { userId: lenderId },
                            { $inc: { coins: amount } }
                        );
                        return interaction.editReply({
                            content: `🚫 **Loan Failed!** The borrower's wallet is full and can't receive the funds! (¬_¬)`,
                            embeds: [],
                            components: []
                        });
                    }

                    await User.findOneAndUpdate(
                        { userId: borrowerId },
                        { $inc: { coins: actualCredit } },
                        { upsert: true }
                    );

                    // Refund the excess to the lender if wallet cap capped the credit
                    const refundAmount = amount - actualCredit;
                    if (refundAmount > 0) {
                        await User.findOneAndUpdate(
                            { userId: lenderId },
                            { $inc: { coins: refundAmount } }
                        );
                    }

                    // Warn if loan was partially credited due to wallet cap
                    const partialWarning = actualCredit < amount
                        ? `\n⚠️ *Note: Only **${actualCredit.toLocaleString('en-US')}** of **${amount.toLocaleString('en-US')}** coins fit in their wallet — **${refundAmount.toLocaleString('en-US')}** refunded to the lender.*`
                        : '';

                    // Debt is based on what was ACTUALLY credited, not the full amount
                    const totalRepay = Math.floor(actualCredit * (1 + interest / 100));
                    try {
                        await Loan.create({
                            lenderId: lenderId,
                            borrowerId: borrowerId,
                            initialAmount: actualCredit,
                            remainingAmount: totalRepay,
                            interestRate: interest,
                            totalRepayment: totalRepay,
                            dueDate: Date.now() + (3 * 24 * 60 * 60 * 1000)
                        });
                    } catch (loanCreateErr) {
                        // Roll back both balances if loan creation fails.
                        await User.updateOne({ userId: borrowerId }, { $inc: { coins: -actualCredit } });
                        await User.updateOne({ userId: lenderId }, { $inc: { coins: actualCredit } });
                        return interaction.editReply({ content: "🚫 **Loan Failed!** Could not finalize loan record; balances were reverted.", embeds: [], components: [] });
                    }

                    const successEmbed = new EmbedBuilder()
                        .setColor(0x57F287)
                        .setTitle("🤝 Loan Established!")
                        .setDescription(
                            `**${interaction.user.username}** has accepted the loan!\n\n` +
                            `💳 **Received:** ${actualCredit.toLocaleString('en-US')} Coins\n` +
                            `💸 **Debt:** ${totalRepay.toLocaleString('en-US')} Coins\n` +
                            `📅 **Due Date:** <t:${Math.floor((Date.now() + 259200000) / 1000)}:R>\n\n` +
                            `*Better pay it back, or else...*${partialWarning}`
                        );

                    return interaction.editReply({ content: null, embeds: [successEmbed], components: [] });
                } finally {
                    loanAcceptLocks.delete(borrowerId);
                }
            }
        }


        // 2. EQUIP PAGINATION
        // --- SUGAR DADDY / SUGAR MOMMY PICKER ---
        if (interaction.customId.startsWith('sugar_daddy_') || interaction.customId.startsWith('sugar_mommy_')) {
            const parts = interaction.customId.split('_');
            // customId format: sugar_daddy_{userId} or sugar_mommy_{userId}
            const targetUserId = parts[parts.length - 1];
            const isPickingDaddy = interaction.customId.startsWith('sugar_daddy_');

            // Only the original buyer can click
            if (interaction.user.id !== targetUserId) {
                return interaction.reply({ content: "H-Hey! That's not your picker! (¬_¬)", flags: MessageFlags.Ephemeral });
            }

            const daddyRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === config.ROLES.SUGAR_DADDY.toLowerCase());
            const mommyRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === config.ROLES.SUGAR_MOMMY.toLowerCase());

            if (!daddyRole || !mommyRole) {
                return interaction.reply({ content: "⚠️ Roles missing from server! Contact the owner. (¬_¬)", flags: MessageFlags.Ephemeral });
            }

            const roleToAdd = isPickingDaddy ? daddyRole : mommyRole;
            const roleToRemove = isPickingDaddy ? mommyRole : daddyRole;
            const roleName = isPickingDaddy ? config.ROLES.SUGAR_DADDY : config.ROLES.SUGAR_MOMMY;

            try {
                const member = await interaction.guild.members.fetch(interaction.user.id);
                const alreadyOwnsEither = member.roles.cache.has(daddyRole.id) || member.roles.cache.has(mommyRole.id);

                // First-time buyers: deduct coins NOW (not in the shop handler)
                if (!alreadyOwnsEither) {
                    const cost = config.SHOP_PRICES.SUGAR_ROLE;
                    const updateRes = await User.findOneAndUpdate(
                        { userId: interaction.user.id, coins: { $gte: cost } },
                        { $inc: { coins: -cost, systemSpent: cost } },
                        { new: true }
                    );
                    if (!updateRes) {
                        return interaction.reply({ content: `🚫 You need **${cost.toLocaleString('en-US')}** coins! You're too broke! (¬_¬)`, flags: MessageFlags.Ephemeral });
                    }
                }

                // Remove the other role if they have it
                if (member.roles.cache.has(roleToRemove.id)) {
                    await member.roles.remove(roleToRemove);
                }
                await member.roles.add(roleToAdd);

                const confirmEmbed = new EmbedBuilder()
                    .setColor(isPickingDaddy ? 0xFFD700 : 0xFF69B4)
                    .setDescription(`${isPickingDaddy ? '💰' : '🌸'} **${roleName}** granted to <@${interaction.user.id}>! ${isPickingDaddy ? 'D-Don\'t spend it all at once! (¬_¬)' : 'I-It suits you, I guess! >////<'}`);

                return interaction.update({ embeds: [confirmEmbed], components: [] });
            } catch (e) {
                console.error(`Sugar role grant failed for ${interaction.user.id}:`, e.message);
                return interaction.reply({ content: "⚠️ Failed to grant role! Check bot permissions. (¬_¬)", flags: MessageFlags.Ephemeral });
            }
        }

        // 2. EQUIP PAGINATION
        // 4. EQUIP TABS & PAGINATION
        if (interaction.customId.startsWith('equip_cat_')) {
            const parts = interaction.customId.split('_');
            const cat = parts[2]; // titles, items, fishing
            const ownerId = parts[3];
            const targetPage = parseInt(parts[4]) || 0;

            if (interaction.user.id !== ownerId) {
                return interaction.reply({ content: "H-Hey! That's not YOUR equipment! Keep your grubby hands off! (¬_¬)", ephemeral: true });
            }

            // Re-fetch user for latest inventory
            const freshUser = await User.findOne({ userId: interaction.user.id }).lean();
            if (!freshUser) return interaction.reply({ content: "Error loading your data! Tch... something broke.", ephemeral: true });

            let allEquippables = [];

            if (cat === 'titles') {
                const myTitles = (freshUser.inventory || []).filter(item => !NON_TITLE_ITEMS.includes(item));
                const uniqueTitles = [...new Set(myTitles)];
                allEquippables = uniqueTitles.map(title => ({ label: title, value: `equip_${title}`, emoji: '🏷️' }));
            } else if (cat === 'items') {
                const inv = freshUser.inventory || [];
                if (inv.includes("Elo Shield") && !freshUser.equippedShield) {
                    allEquippables.push({ label: 'Elo Shield', value: 'equip_Elo Shield', emoji: '🛡️' });
                }
                if (inv.includes("Bounty Shield")) {
                    allEquippables.push({ label: 'Bounty Shield', value: 'equip_Bounty Shield', emoji: '🛡️' });
                }
                const amuletCount = inv.filter(i => i === "Coin Amulet").length;
                if (amuletCount > 0) {
                    allEquippables.push({ label: `Coin Amulet (${amuletCount} owned)`, value: 'equip_Coin Amulet', emoji: '🪙' });
                }
                if (inv.includes('Debt Eraser')) {
                    allEquippables.push({ label: 'Debt Eraser', value: 'equip_Debt Eraser', emoji: '📄' });
                }
                if (inv.includes('Isekai Discount')) {
                    allEquippables.push({ label: 'Isekai Discount', value: 'equip_Isekai Discount', emoji: '🎫' });
                }
                if (inv.includes('Double Dip')) {
                    allEquippables.push({ label: 'Double Dip', value: 'equip_Double Dip', emoji: '✌️' });
                }
                if (inv.includes('Slave Snatcher')) {
                    allEquippables.push({ label: 'Slave Snatcher', value: 'equip_Slave Snatcher', emoji: '🎣' });
                }
            } else if (cat === 'fishing') {
                const activeRodId = freshUser.fishing?.gear?.activeRod || 'flimsy_stick';
                const ownedRodsRaw = freshUser.fishing?.gear?.ownedRods || {};
                const ownedRods = ownedRodsRaw instanceof Map ? Object.fromEntries(ownedRodsRaw) : ownedRodsRaw;
                for (const [rodId, durability] of Object.entries(ownedRods)) {
                    if (rodId === activeRodId) continue;
                    const rodConf = config.FISHING?.GEAR?.RODS?.[rodId];
                    if (!rodConf) continue;
                    const durStr = durability > 0 ? `${durability}/${rodConf.maxDurability}` : '⚠️ BROKEN';
                    allEquippables.push({ label: `${rodConf.name} (${durStr})`, value: `equip_rod_${rodId}`, emoji: rodConf.emoji });
                }

                const activeBaitId = freshUser.fishing?.gear?.activeBait || 'none';
                const ownedBaitsRaw = freshUser.fishing?.gear?.ownedBaits || {};
                const ownedBaitsObj = ownedBaitsRaw instanceof Map ? Object.fromEntries(ownedBaitsRaw) : ownedBaitsRaw;
                for (const [baitId, count] of Object.entries(ownedBaitsObj)) {
                    if (baitId === activeBaitId || count <= 0) continue;
                    const baitConf = config.FISHING?.GEAR?.BAITS?.[baitId];
                    if (!baitConf || baitId === 'none') continue;
                    allEquippables.push({ label: `${baitConf.name} (${count} left)`, value: `equip_bait_${baitId}`, emoji: baitConf.emoji });
                }
            }

            const pageSize = 25;
            const totalPages = Math.max(1, Math.ceil(allEquippables.length / pageSize));
            const page = Math.max(0, Math.min(targetPage, totalPages - 1));
            const start = page * pageSize;
            const end = start + pageSize;
            const pageItems = allEquippables.slice(start, end);

            const embed = new EmbedBuilder()
                .setColor(0xFF69B4)
                .setTitle("🎒 Equipment Manager")
                .setDescription(
                    `H-Here's your stuff... not that I care what you wear! (¬_¬)\n\n` +
                    `**Current Title:** ${freshUser.equippedTitle ? `🏷️ ${freshUser.equippedTitle}` : "*None... loser!*"}\n` +
                    `**Shield:** ${freshUser.equippedShield ? "🛡️ Equipped" : "❌ Not equipped"}\n` +
                    `**Amulet:** ${freshUser.equippedAmuletCount > 0 ? `🪙 **${freshUser.equippedAmuletCount}x** Stacked` : "❌ Not equipped"}\n\n` +
                    `📦 **${cat.toUpperCase()}** (${allEquippables.length} available) | **Page:** ${page + 1}/${totalPages}`
                )
                .setThumbnail(client.user.displayAvatarURL())
                .setFooter({ text: `D-Don't take forever picking! I don't have all day! >///< ` });

            const components = [];

            // Add Tab Buttons
            const tabRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`equip_cat_titles_${ownerId}_0`)
                    .setLabel('Titles')
                    .setStyle(cat === 'titles' ? ButtonStyle.Success : ButtonStyle.Primary)
                    .setEmoji('🏷️'),
                new ButtonBuilder()
                    .setCustomId(`equip_cat_items_${ownerId}_0`)
                    .setLabel('Items')
                    .setStyle(cat === 'items' ? ButtonStyle.Success : ButtonStyle.Primary)
                    .setEmoji('⚔️'),
                new ButtonBuilder()
                    .setCustomId(`equip_cat_fishing_${ownerId}_0`)
                    .setLabel('Fishing')
                    .setStyle(cat === 'fishing' ? ButtonStyle.Success : ButtonStyle.Primary)
                    .setEmoji('🎣')
            );
            components.push(tabRow);

            if (pageItems.length > 0) {
                const selectRow = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(`equip_selector_${page}`)
                        .setPlaceholder('✨ Select something to equip...')
                        .addOptions(pageItems)
                );
                components.push(selectRow);
            }

            // Add Navigation Buttons if needed
            if (totalPages > 1) {
                const buttonRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`equip_cat_${cat}_${ownerId}_${page - 1}`)
                        .setLabel('Previous')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('⬅️')
                        .setDisabled(page === 0),
                    new ButtonBuilder()
                        .setCustomId(`equip_page_info_${page}`)
                        .setLabel(`Page ${page + 1}/${totalPages}`)
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(true),
                    new ButtonBuilder()
                        .setCustomId(`equip_cat_${cat}_${ownerId}_${page + 1}`)
                        .setLabel('Next')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('➡️')
                        .setDisabled(page >= totalPages - 1)
                );
                components.push(buttonRow);
            }

            return interaction.update({ embeds: [embed], components });
        }

        // 3. BAG/INVENTORY TABS & PAGINATION
        if (interaction.customId.startsWith('bag_tab_')) {
            const parts = interaction.customId.split('_');
            const tab = parts[2]; // overview, titles, items
            const ownerId = parts[3];
            const targetPage = parseInt(parts[4]) || 0;

            // Only the owner can navigate their bag
            if (interaction.user.id !== ownerId) {
                return interaction.reply({ content: "H-Hey! That's not YOUR inventory! Keep your grubby hands off! (¬_¬)", ephemeral: true });
            }

            // Re-fetch user for latest inventory
            const freshUser = await User.findOne({ userId: interaction.user.id });
            if (!freshUser) return interaction.reply({ content: "Error loading your data! Tch... something broke.", ephemeral: true });

            const embed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle(`${interaction.user.username}'s Inventory 🎒`);

            const components = [];

            // Always add the tab row at the top
            const tabRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`bag_tab_overview_${ownerId}`)
                    .setLabel('Overview')
                    .setStyle(tab === 'overview' ? ButtonStyle.Success : ButtonStyle.Primary)
                    .setEmoji('📋'),
                new ButtonBuilder()
                    .setCustomId(`bag_tab_titles_${ownerId}_0`)
                    .setLabel('Titles')
                    .setStyle(tab === 'titles' ? ButtonStyle.Success : ButtonStyle.Secondary)
                    .setEmoji('🏷️'),
                new ButtonBuilder()
                    .setCustomId(`bag_tab_items_${ownerId}_0`)
                    .setLabel('Items & Consumables')
                    .setStyle(tab === 'items' ? ButtonStyle.Success : ButtonStyle.Secondary)
                    .setEmoji('⚔️')
            );
            components.push(tabRow);

            if (tab === 'overview') {
                const fields = [
                    { name: '💳 Balance', value: `\`${freshUser.coins.toLocaleString('en-US')} Coins\``, inline: true },
                    { name: '💎 Nuggets', value: `\`${(freshUser.nuggets || 0).toLocaleString('en-US')}\``, inline: true },
                    { name: '🛡️ Shield', value: freshUser.equippedShield ? '✅ Equipped' : '❌ None', inline: true },
                    { name: '🪙 Amulet', value: freshUser.equippedAmuletCount > 0 ? `✅ **${freshUser.equippedAmuletCount}x** Equipped` : '❌ None', inline: true },
                    { name: '🎨 Frame Color', value: `\`${freshUser.frameColor || "Default"}\``, inline: true },
                    { name: '📦 Total Items', value: `\`${freshUser.inventory.length}\``, inline: true }
                ];

                const activeEffects = [];
                if (freshUser.bountyShieldExpiry > Date.now()) {
                    const remaining = freshUser.bountyShieldExpiry - Date.now();
                    const hours = Math.floor(remaining / 3600000);
                    const mins = Math.floor((remaining % 3600000) / 60000);
                    activeEffects.push(`🛡️ Bounty Shield — ${hours}h ${mins}m remaining`);
                }
                if (freshUser.isekaiDiscountActive) activeEffects.push('🎫 Isekai Discount — Ready (next !isekai -25%)');
                if (freshUser.doubleDipActive) activeEffects.push('✌️ Double Dip — Ready (next income doubled)');
                if (freshUser.mediocrityExpiry > Date.now()) {
                    const r = freshUser.mediocrityExpiry - Date.now();
                    activeEffects.push(`😈 Mediocrity Curse — Active for ${Math.floor(r / 3600000)}h ${Math.floor((r % 3600000) / 60000)}m (unknown origin)`);
                }
                if (activeEffects.length > 0) {
                    fields.push({ name: '✨ Active Effects', value: activeEffects.join('\n'), inline: false });
                }

                embed.addFields(fields);
                embed.setFooter({ text: "H-Here's your overview... don't look at me like that! (¬_¬)" });

            } else {
                // Titles or Items pagination
                const itemCounts = {};
                for (const item of freshUser.inventory) {
                    itemCounts[item] = (itemCounts[item] || 0) + 1;
                }

                const listItems = [];
                for (const [item, count] of Object.entries(itemCounts)) {
                    if (tab === 'items' && NON_TITLE_ITEMS.includes(item)) {
                        listItems.push(`• ${count > 1 ? `${item} **x${count}**` : item}`);
                    } else if (tab === 'titles' && !NON_TITLE_ITEMS.includes(item)) {
                        const isEquipped = freshUser.equippedTitle === item;
                        listItems.push(`• ${isEquipped ? `🏷️ **${item}** *(equipped)*` : item}`);
                    }
                }

                const pageSize = 15;
                const totalPages = Math.max(1, Math.ceil(listItems.length / pageSize));
                const page = Math.max(0, Math.min(targetPage, totalPages - 1));

                const start = page * pageSize;
                const end = start + pageSize;
                const pageItems = listItems.slice(start, end);

                const displayStr = pageItems.length > 0 
                    ? pageItems.join('\n') 
                    : `*No ${tab === 'titles' ? 'titles' : 'items'} found... go grind, peasant!*`;

                embed.setDescription(`**${tab === 'titles' ? '🏷️ Your Titles' : '⚔️ Your Items'}**\n\n${displayStr}`);
                embed.setFooter({ text: `Page ${page + 1}/${totalPages} • H-Here's your stuff... don't stare! (¬_¬)` });

                if (totalPages > 1) {
                    const buttonRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`bag_tab_${tab}_${ownerId}_${page - 1}`)
                            .setLabel('Previous')
                            .setStyle(ButtonStyle.Secondary)
                            .setEmoji('⬅️')
                            .setDisabled(page === 0),
                        new ButtonBuilder()
                            .setCustomId(`bag_page_info`)
                            .setLabel(`Page ${page + 1}/${totalPages}`)
                            .setStyle(ButtonStyle.Primary)
                            .setDisabled(true),
                        new ButtonBuilder()
                            .setCustomId(`bag_tab_${tab}_${ownerId}_${page + 1}`)
                            .setLabel('Next')
                            .setStyle(ButtonStyle.Secondary)
                            .setEmoji('➡️')
                            .setDisabled(page >= totalPages - 1)
                    );
                    components.push(buttonRow);
                }
            }

            return interaction.update({ embeds: [embed], components });
        }

        // 2. EQUIP SELECTOR
        if (interaction.customId.startsWith('equip_selector')) {
            // Locate the row with the select menu (type 3 is StringSelect)
            const selectRowIndex = interaction.message.components.findIndex(row => 
                row.components[0] && row.components[0].type === 3
            );
            
            // PREVENT DOUBLE CLICK GLITCH
            if (selectRowIndex === -1 || interaction.message.components[selectRowIndex].components[0].disabled) {
                return;
            }

            // Slave Snatcher: must show modal BEFORE any other response (update/reply)
            const selectedItem = interaction.values[0].replace('equip_', '');
            if (selectedItem === 'Slave Snatcher') {
                if (!user.inventory.includes('Slave Snatcher')) {
                    return interaction.reply({ content: "You don't have a Slave Snatcher! (¬_¬)", flags: MessageFlags.Ephemeral });
                }
                const modal = new ModalBuilder()
                    .setCustomId('snatch_modal')
                    .setTitle('Slave Snatcher');
                const input = new TextInputBuilder()
                    .setCustomId('snatch_target')
                    .setLabel('Target User ID or @mention')
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder('e.g. 123456789012345678')
                    .setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(input));
                return interaction.showModal(modal);
            }

            try {
                // Update components preserving all other rows (tabs, pagination)
                const updatedComponents = interaction.message.components.map((row, index) => {
                    if (index === selectRowIndex) {
                        return new ActionRowBuilder().addComponents(
                            new StringSelectMenuBuilder(row.components[0].data).setDisabled(true)
                        );
                    }
                    return row;
                });
                
                await interaction.update({ components: updatedComponents });
            } catch (e) {
                return;
            }

            const item = interaction.values[0].replace('equip_', '');

            let confirmMsg = "";
            if (item === "Elo Shield") {
                // Re-fetch fresh data for guard check
                const freshUser = await User.findOne({ userId: interaction.user.id });
                if (!freshUser.inventory.includes("Elo Shield") || freshUser.equippedShield) {
                    return interaction.followUp({ content: "H-Hah?! You don't own an Elo Shield or it's already equipped, baka! (¬_¬)", ephemeral: true });
                }
                
                // Atomically equip and remove 1 Elo Shield without wiping background item drops
                const itemIndex = freshUser.inventory.indexOf("Elo Shield");
                if (itemIndex !== -1) {
                    const unsetObj = {};
                    unsetObj[`inventory.${itemIndex}`] = 1;
                    await User.updateOne({ userId: interaction.user.id }, { $unset: unsetObj });
                    await User.updateOne({ userId: interaction.user.id }, { 
                        $pull: { inventory: null },
                        $set: { equippedShield: true }
                    });
                }
                user.equippedShield = true; // Update local state
                confirmMsg = "F-Fine! I equipped your **Elo Shield**... not that I'm protecting you or anything! >///< ";
            } else if (item === "Bounty Shield") {
                // Re-fetch fresh data for guard check
                const freshUserBS = await User.findOne({ userId: interaction.user.id });
                if (!freshUserBS.inventory.includes("Bounty Shield")) {
                    return interaction.followUp({ content: "You don't own a Bounty Shield! Stop hallucinating! (¬_¬)", ephemeral: true });
                }
                // Activate: remove from inventory, set expiry to now + 48h
                const freshUser = await User.findOne({ userId: interaction.user.id });
                const itemIndex = freshUser.inventory.indexOf("Bounty Shield");
                if (itemIndex !== -1) {
                    const unsetObj = {};
                    unsetObj[`inventory.${itemIndex}`] = 1;
                    await User.updateOne({ userId: interaction.user.id }, { $unset: unsetObj });
                    await User.updateOne({ userId: interaction.user.id }, {
                        $pull: { inventory: null },
                        $set: { bountyShieldExpiry: Date.now() + 172800000 }
                    });
                }
                confirmMsg = "🛡️ Bounty Shield active for **48 hours**. D-Don't think this makes you special! >////<";
            } else if (item === "Coin Amulet") {
                // Re-fetch fresh data for guard check
                const freshUserAm = await User.findOne({ userId: interaction.user.id });
                const amuletCount = freshUserAm.inventory.filter(i => i === "Coin Amulet").length;
                if (amuletCount === 0) {
                    return interaction.followUp({ content: "Tch! You don't own any Coin Amulets! Stop wasting my time! (¬_¬)", ephemeral: true });
                }

                // If only 1 amulet, auto-equip it
                if (amuletCount === 1) {
                    const amCount = freshUserAm.equippedAmuletCount || 0;
                    
                    // Return currently equipped amulets + remove 1 from inventory in fewer ops
                    if (amCount > 0) {
                        await User.updateOne({ userId: interaction.user.id }, { $push: { inventory: { $each: Array(amCount).fill("Coin Amulet") } } });
                    }
                    
                    // Re-fetch after returning amulets, then atomically remove 1 and equip
                    const freshUserAgain = await User.findOne({ userId: interaction.user.id });
                    const itemIndex = freshUserAgain.inventory.indexOf("Coin Amulet");
                    if (itemIndex !== -1) {
                        const unsetObj = {};
                        unsetObj[`inventory.${itemIndex}`] = 1;
                        await User.updateOne({ userId: interaction.user.id }, { $unset: unsetObj });
                        await User.updateOne({ userId: interaction.user.id }, { 
                            $pull: { inventory: null },
                            $set: { equippedAmuletCount: 1 }
                        });
                    }
                    user.equippedAmuletCount = 1; // Update local state

                    const embed = new EmbedBuilder()
                        .setColor(0x00FF00)
                        .setTitle("🪙 Amulet Equipped!")
                        .setDescription("W-Whatever... I put on your **1x Coin Amulet** (1.5x multiplier)... it's not like I want you to get richer! (¬_¬)")
                        .setThumbnail(interaction.user.displayAvatarURL());
                    return interaction.editReply({ embeds: [embed], components: [] });
                }

                // If >1 amulets, show stacking UI
                const maxStack = Math.min(amuletCount, 50);
                const embed = new EmbedBuilder()
                    .setColor(0xFFD700)
                    .setTitle("🪙 AMULET STACKING")
                    .setDescription(
                        `*"H-How many do you want to stack?! D-Don't be greedy!"* >///< \n\n` +
                        `**📊 Stacking Bonuses:**\n` +
                        `• 1 Amulet = **${config.AMULET_TIERS.BASE}x** multiplier\n` +
                        `• 2-10: +**${config.AMULET_TIERS.TIER1_RATE}x** each (10 = ${(config.AMULET_TIERS.BASE + 9 * config.AMULET_TIERS.TIER1_RATE).toFixed(2)}x)\n` +
                        `• 11-30: +**${config.AMULET_TIERS.TIER2_RATE}x** each (30 = ${(config.AMULET_TIERS.BASE + 9 * config.AMULET_TIERS.TIER1_RATE + 20 * config.AMULET_TIERS.TIER2_RATE).toFixed(2)}x)\n` +
                        `• 31-50: +**${config.AMULET_TIERS.TIER3_RATE}x** each (50 = ${(config.AMULET_TIERS.BASE + 9 * config.AMULET_TIERS.TIER1_RATE + 20 * config.AMULET_TIERS.TIER2_RATE + 20 * config.AMULET_TIERS.TIER3_RATE).toFixed(2)}x)\n\n` +
                        `📦 **You own:** ${amuletCount} | ⚠️ **Max stack:** 50\n` +
                        `🪙 **Currently equipped:** ${user.equippedAmuletCount}\n\n` +
                        `*All equipped amulets are consumed on duel WIN!*`
                    )
                    .setThumbnail(client.user.displayAvatarURL())
                    .setFooter({ text: "Choose wisely, baka!" });

                const buttonRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('amulet_none')
                        .setLabel('❌ No Amulet')
                        .setStyle(ButtonStyle.Danger),
                    new ButtonBuilder()
                        .setCustomId('amulet_custom')
                        .setLabel(`📦 Custom (1-${maxStack})`)
                        .setStyle(ButtonStyle.Primary)
                );

                return interaction.editReply({ embeds: [embed], components: [buttonRow] });
            } else if (item === 'Debt Eraser') {
                if (!user.inventory.includes('Debt Eraser')) {
                    return interaction.followUp({ content: "You don't have a Debt Eraser! Stop making things up! (¬_¬)", ephemeral: true });
                }
                const loan = await Loan.findOne({ borrowerId: interaction.user.id, status: { $in: ['ACTIVE', 'DEFAULTED'] } }).sort({ dueDate: 1 });
                if (!loan) {
                    return interaction.followUp({ content: "You don't even have a loan! Why would you waste this?! (¬_¬)", ephemeral: true });
                }
                const reduction = Math.floor(loan.remainingAmount * config.ECONOMY.DEBT_ERASER_POWER);
                const newRemaining = loan.remainingAmount - reduction;

                // Remove item from inventory safely (Bug #3 fix reverted to preserve stacking)
                const freshUser = await User.findOne({ userId: interaction.user.id });
                if (!freshUser || !freshUser.inventory.includes('Debt Eraser')) {
                    return interaction.followUp({ content: "Failed to consume item! I couldn't find the Debt Eraser! Try again. (¬_¬)", ephemeral: true });
                }
                const itemIndex = freshUser.inventory.indexOf('Debt Eraser');
                if (itemIndex !== -1) {
                    const unsetObj = {};
                    unsetObj[`inventory.${itemIndex}`] = 1;
                    await User.updateOne({ userId: interaction.user.id }, { $unset: unsetObj });
                    await User.updateOne({ userId: interaction.user.id }, { $pull: { inventory: null } });
                }

                // Credit lender (Bug #4)
                await User.findOneAndUpdate(
                    { userId: loan.lenderId },
                    { $inc: { coins: reduction } },
                    { upsert: true }
                );

                if (newRemaining <= 0) {
                    await Loan.updateOne({ _id: loan._id }, { $set: { remainingAmount: 0, status: 'PAID' } });
                    // Full cleanup: free from slavery + clear carrot
                    if (freshUser.isSlave) {
                        await User.updateOne({ userId: interaction.user.id }, {
                            $set: {
                                isSlave: false, slaveOwner: null,
                                carrotResistUsed: false, resistExpiresAt: 0,
                                'activeCarrot.amount': 0, 'activeCarrot.bonusPerHr': 0,
                                'activeCarrot.expiresAt': 0, 'activeCarrot.ownerId': null
                            }
                        });
                    }
                    confirmMsg = `📄 Debt **WIPED**! ${reduction.toLocaleString('en-US')} erased — loan fully paid! ${freshUser.isSlave ? '⛓️ You are FREE!' : ''} You're welcome, baka! >////<`;
                } else {
                    await Loan.updateOne({ _id: loan._id }, { $set: { remainingAmount: newRemaining } });
                    confirmMsg = `📄 Debt reduced by **${reduction.toLocaleString('en-US')}**! Remaining: **${newRemaining.toLocaleString('en-US')}**. You're welcome, baka! >////<`;
                }
            } else if (item === 'Isekai Discount') {
                // Re-fetch fresh data for guard checks
                const freshUserID = await User.findOne({ userId: interaction.user.id });
                if (!freshUserID.inventory.includes('Isekai Discount')) {
                    return interaction.followUp({ content: "You don't have an Isekai Discount! (¬_¬)", ephemeral: true });
                }
                if (freshUserID.isekaiDiscountActive) {
                    return interaction.followUp({ content: "You already have one queued up! Use it first with `!isekai`! (¬_¬)", ephemeral: true });
                }
                const freshUser = await User.findOne({ userId: interaction.user.id });
                const itemIndex = freshUser.inventory.indexOf('Isekai Discount');
                if (itemIndex !== -1) {
                    const unsetObj = {};
                    unsetObj[`inventory.${itemIndex}`] = 1;
                    await User.updateOne({ userId: interaction.user.id }, { $unset: unsetObj });
                    await User.updateOne({ userId: interaction.user.id }, {
                        $pull: { inventory: null },
                        $set: { isekaiDiscountActive: true }
                    });
                }
                confirmMsg = '🎫 Next `!isekai` costs **25% less**. D-Don\'t blow it! >////<';
            } else if (item.startsWith('rod_')) {
                // Fishing rod equip
                if (fishingSystem.activeGames.get(interaction.user.id)) {
                    return interaction.followUp({ content: "You're currently fishing! Finish reeling it in first, baka! (¬_¬)", flags: MessageFlags.Ephemeral });
                }
                const rodId = item.replace('rod_', '');
                const rodConf = config.FISHING?.GEAR?.RODS?.[rodId];
                if (!rodConf) return interaction.followUp({ content: "That rod doesn't exist! Stop hacking! (¬_¬)", flags: MessageFlags.Ephemeral });

                const freshUser = await User.findOne({ userId: interaction.user.id }).lean();
                const ownedRods = freshUser?.fishing?.gear?.ownedRods || {};
                if (ownedRods[rodId] === undefined) {
                    return interaction.followUp({ content: `You don't own the **${rodConf.name}**! Buy it from \`!shop\` first! (¬_¬)`, flags: MessageFlags.Ephemeral });
                }
                const currentRod = freshUser?.fishing?.gear?.activeRod || 'flimsy_stick';
                if (currentRod === rodId) {
                    return interaction.followUp({ content: `That rod is already equipped, baka! (¬_¬)`, flags: MessageFlags.Ephemeral });
                }

                const oldDur = freshUser?.fishing?.gear?.rodDurability || 0;
                const newDur = ownedRods[rodId] || 0;
                const setFields = {
                    'fishing.gear.activeRod': rodId,
                    'fishing.gear.rodDurability': newDur
                };
                if (currentRod !== 'flimsy_stick') setFields[`fishing.gear.ownedRods.${currentRod}`] = oldDur;

                await User.updateOne({ userId: interaction.user.id }, { $set: setFields });
                const durStr = newDur > 0 ? `${newDur}/${rodConf.maxDurability}` : '\u26a0\ufe0f BROKEN \u2014 repair it!';
                confirmMsg = `${rodConf.emoji} Switched to **${rodConf.name}**! Durability: ${durStr}. Now go catch something! (\u00ac_\u00ac)`;
            } else if (item.startsWith('bait_')) {
                // Bait equip
                const baitId = item.replace('bait_', '');
                const baitConf = config.FISHING?.GEAR?.BAITS?.[baitId];
                if (!baitConf || baitId === 'none') return interaction.followUp({ content: "That bait doesn't exist! Stop making things up! (¬_¬)", flags: MessageFlags.Ephemeral });

                const freshUser = await User.findOne({ userId: interaction.user.id }).lean();
                const ob = freshUser?.fishing?.gear?.ownedBaits || {};
                const baitCount = ob[baitId] || 0;
                if (baitCount <= 0) {
                    return interaction.followUp({ content: `You don't have any **${baitConf.name}** left! Buy some from \`!shop\` first! (¬_¬)`, flags: MessageFlags.Ephemeral });
                }
                const currentBait = freshUser?.fishing?.gear?.activeBait || 'none';
                if (currentBait === baitId) {
                    return interaction.followUp({ content: `That bait is already equipped, baka! (¬_¬)`, flags: MessageFlags.Ephemeral });
                }

                await User.updateOne({ userId: interaction.user.id }, {
                    $set: {
                        'fishing.gear.activeBait': baitId,
                        'fishing.gear.baitCount': baitCount
                    }
                });
                confirmMsg = `${baitConf.emoji} Equipped **${baitConf.name}** (${baitCount} left)! ${baitConf.description || ''} Now go catch something! (¬_¬)`;
            } else if (item === 'Double Dip') {
                // Re-fetch fresh data for guard checks
                const freshUserDD = await User.findOne({ userId: interaction.user.id });
                if (!freshUserDD.inventory.includes('Double Dip')) {
                    return interaction.followUp({ content: "You don't have a Double Dip! (¬_¬)", ephemeral: true });
                }
                if (freshUserDD.doubleDipActive) {
                    return interaction.followUp({ content: "You already have one active! Be patient! (¬_¬)", ephemeral: true });
                }
                const freshUser = await User.findOne({ userId: interaction.user.id });
                const itemIndex = freshUser.inventory.indexOf('Double Dip');
                if (itemIndex !== -1) {
                    const unsetObj = {};
                    unsetObj[`inventory.${itemIndex}`] = 1;
                    await User.updateOne({ userId: interaction.user.id }, { $unset: unsetObj });
                    await User.updateOne({ userId: interaction.user.id }, {
                        $pull: { inventory: null },
                        $set: { doubleDipActive: true }
                    });
                }
                confirmMsg = '✌️ Next income source pays **DOUBLE**! D-Don\'t waste it! >////<';
            } else {
                if (!user.inventory.includes(item)) {
                    return interaction.followUp({ content: "Y-You don't even own that title! Stop trying to flex things you don't have, idiot! (¬_¬)", ephemeral: true });
                }

                // Swap Roles (Remove old, Add new)
                const oldTitle = user.equippedTitle;
                await roleSync.syncUserTitleRole(interaction.guild, interaction.user.id, item, oldTitle);

                user.equippedTitle = item;
                confirmMsg = `H-Hmph! There, I set your title to **${item}**... not that it makes you look any cooler! >///< `;
                await User.updateOne({ userId: interaction.user.id }, { $set: { equippedTitle: item } });
            }

            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle("✅ Equipment Updated!")
                .setDescription(confirmMsg)
                .setThumbnail(interaction.user.displayAvatarURL())
                .setFooter({ text: "Now stop bothering me! (¬_¬)" });

            return interaction.editReply({ embeds: [embed], components: [] });
        }

        // 3. UNEQUIP SELECTOR (dropdown)
        if (interaction.customId === 'unequip_selector') {
            const selected = interaction.values[0];

            try {
                // Disable UI immediately to prevent double-click
                await interaction.update({ components: [] });
            } catch (e) {
                return;
            }

            let resultMsg = '';

            if (selected === 'unequip_title') {
                // Read current title atomically
                const freshUser = await User.findOne({ userId: interaction.user.id });
                const oldTitle = freshUser?.equippedTitle;
                if (!oldTitle) {
                    return interaction.followUp({ content: "You don't have a title equipped! Were you seeing things?! (¬_¬)", flags: MessageFlags.Ephemeral });
                }

                // Strip Discord role FIRST — if this fails, we abort and nothing is lost
                try {
                    await roleSync.syncUserTitleRole(interaction.guild, interaction.user.id, null, oldTitle);
                } catch (e) {
                    return interaction.followUp({ content: "S-Something went wrong removing your role! Try again! >///< ", flags: MessageFlags.Ephemeral });
                }

                // Only clear DB after role strip succeeded
                const result = await User.findOneAndUpdate(
                    { userId: interaction.user.id, equippedTitle: oldTitle },
                    { $set: { equippedTitle: null } },
                    { new: true }
                );
                if (!result) {
                    return interaction.followUp({ content: "Title already removed! Someone beat me to it! (¬_¬)", flags: MessageFlags.Ephemeral });
                }
                resultMsg = `🏷️ Unequipped title **${oldTitle}**. It's still in your inventory.`;

            } else if (selected === 'unequip_shield') {
                // Atomic: only refund if shield is actually equipped right now
                const result = await User.findOneAndUpdate(
                    { userId: interaction.user.id, equippedShield: true },
                    { $set: { equippedShield: false }, $push: { inventory: "Elo Shield" } },
                    { new: true }
                );
                if (!result) {
                    return interaction.followUp({ content: "Shield's already gone! Did you just lose a duel?! (¬_¬)", flags: MessageFlags.Ephemeral });
                }
                resultMsg = '🛡️ Elo Shield unequipped and returned to your inventory.';

            } else if (selected === 'unequip_amulet') {
                // Atomic: read-and-zero, return pre-update count
                const preUpdate = await User.findOneAndUpdate(
                    { userId: interaction.user.id, equippedAmuletCount: { $gt: 0 } },
                    { $set: { equippedAmuletCount: 0 } },
                    { new: false }
                );
                const count = preUpdate?.equippedAmuletCount || 0;
                if (count === 0) {
                    return interaction.followUp({ content: "No amulets equipped! Are you hallucinating?! (¬_¬)", flags: MessageFlags.Ephemeral });
                }
                // Push them all back into inventory
                await User.updateOne(
                    { userId: interaction.user.id },
                    { $push: { inventory: { $each: Array(count).fill("Coin Amulet") } } }
                );
                resultMsg = `🪙 **${count}x** Coin Amulets unequipped and returned to your inventory.`;

            } else if (selected === 'unequip_rod') {
                if (fishingSystem.activeGames.get(interaction.user.id)) {
                    return interaction.followUp({ content: "You're currently fishing! Finish reeling it in first, baka! (¬_¬)", flags: MessageFlags.Ephemeral });
                }
                const freshUser = await User.findOne({ userId: interaction.user.id }).lean();
                const currentRod = freshUser?.fishing?.gear?.activeRod || 'flimsy_stick';
                if (currentRod === 'flimsy_stick') {
                    return interaction.followUp({ content: "You're already using the Flimsy Stick! Can't go lower than that, baka! (¬_¬)", flags: MessageFlags.Ephemeral });
                }
                const rodConf = config.FISHING?.GEAR?.RODS?.[currentRod];
                const oldDur = freshUser?.fishing?.gear?.rodDurability || 0;
                await User.updateOne({ userId: interaction.user.id }, {
                    $set: {
                        'fishing.gear.activeRod': 'flimsy_stick',
                        'fishing.gear.rodDurability': 0,
                        [`fishing.gear.ownedRods.${currentRod}`]: oldDur
                    }
                });
                resultMsg = `${rodConf?.emoji || '🎣'} Unequipped **${rodConf?.name || currentRod}**. Back to the Flimsy Stick... pathetic. (¬_¬)`;

            } else if (selected === 'unequip_bait') {
                const freshUser = await User.findOne({ userId: interaction.user.id }).lean();
                const curBait = freshUser?.fishing?.gear?.activeBait || 'none';
                if (curBait === 'none') {
                    return interaction.followUp({ content: "You don't have any bait equipped! (¬_¬)", flags: MessageFlags.Ephemeral });
                }
                const baitConf = config.FISHING?.GEAR?.BAITS?.[curBait];
                // Save remaining count back to ownedBaits, then clear active
                const remaining = freshUser?.fishing?.gear?.baitCount || 0;
                const updateOps = {
                    $set: { 'fishing.gear.activeBait': 'none', 'fishing.gear.baitCount': 0 }
                };
                if (remaining > 0) {
                    updateOps.$set[`fishing.gear.ownedBaits.${curBait}`] = remaining;
                }
                await User.updateOne(
                    { userId: interaction.user.id, 'fishing.gear.activeBait': curBait },
                    updateOps
                );
                resultMsg = `${baitConf?.emoji || '🪱'} Unequipped **${baitConf?.name || curBait}** (${remaining} saved). You're going baitless... your loss! (¬_¬)`;
            }

            const embed = new EmbedBuilder()
                .setColor(0xFF4500)
                .setTitle("🔓 Item Unequipped!")
                .setDescription(`*"T-There! Happy now?!"* (¬_¬)\n\n${resultMsg}`)
                .setThumbnail(interaction.user.displayAvatarURL())
                .setFooter({ text: "Use !equip to put stuff back on." });

            return interaction.followUp({ embeds: [embed] });
        }

        // 4. UNEQUIP ALL (button)
        if (interaction.customId === 'unequip_all') {
            if (fishingSystem.activeGames.get(interaction.user.id)) {
                return interaction.reply({ content: "You're currently fishing! Finish reeling it in first, baka! (¬_¬)", flags: MessageFlags.Ephemeral });
            }
            try {
                // Disable UI immediately
                await interaction.update({ components: [] });
            } catch (e) {
                return;
            }

            const freshUser = await User.findOne({ userId: interaction.user.id });
            if (!freshUser) {
                return interaction.followUp({ content: "Who are you?! I can't find your data! >///< ", flags: MessageFlags.Ephemeral });
            }

            const results = [];

            // 1. Title
            if (freshUser.equippedTitle) {
                const oldTitle = freshUser.equippedTitle;
                try {
                    await roleSync.syncUserTitleRole(interaction.guild, interaction.user.id, null, oldTitle);
                } catch (e) {
                    results.push(`⚠️ Title role removal failed (Discord error), title kept equipped.`);
                }
                if (!results.some(r => r.includes('Title role removal failed'))) {
                    await User.updateOne(
                        { userId: interaction.user.id },
                        { $set: { equippedTitle: null } }
                    );
                    results.push(`🏷️ Title **${oldTitle}** unequipped (still in inventory).`);
                }
            }

            // 2. Shield
            if (freshUser.equippedShield) {
                const shieldResult = await User.findOneAndUpdate(
                    { userId: interaction.user.id, equippedShield: true },
                    { $set: { equippedShield: false }, $push: { inventory: "Elo Shield" } },
                    { new: true }
                );
                if (shieldResult) {
                    results.push('🛡️ Elo Shield returned to inventory.');
                }
            }

            // 3. Amulets
            if (freshUser.equippedAmuletCount > 0) {
                const preUpdate = await User.findOneAndUpdate(
                    { userId: interaction.user.id, equippedAmuletCount: { $gt: 0 } },
                    { $set: { equippedAmuletCount: 0 } },
                    { new: false }
                );
                const count = preUpdate?.equippedAmuletCount || 0;
                if (count > 0) {
                    await User.updateOne(
                        { userId: interaction.user.id },
                        { $push: { inventory: { $each: Array(count).fill("Coin Amulet") } } }
                    );
                    results.push(`🪙 **${count}x** Coin Amulets returned to inventory.`);
                }
            }

            // 4. Fishing Rod — read the current rod atomically and swap to flimsy
            const activeRodId = freshUser.fishing?.gear?.activeRod || 'flimsy_stick';
            if (activeRodId !== 'flimsy_stick') {
                const oldDur = freshUser.fishing?.gear?.rodDurability || 0;
                const rodResult = await User.findOneAndUpdate(
                    { userId: interaction.user.id, 'fishing.gear.activeRod': activeRodId },
                    { $set: {
                        'fishing.gear.activeRod': 'flimsy_stick',
                        'fishing.gear.rodDurability': 0,
                        [`fishing.gear.ownedRods.${activeRodId}`]: oldDur
                    }},
                    { new: false }
                );
                if (rodResult) {
                    const rodConf = config.FISHING?.GEAR?.RODS?.[activeRodId];
                    results.push(`${rodConf?.emoji || '🎣'} Rod **${rodConf?.name || activeRodId}** unequipped (returned to Flimsy Stick).`);
                }
            }

            // 5. Bait
            const activeBait = freshUser.fishing?.gear?.activeBait || 'none';
            if (activeBait !== 'none') {
                const remaining = freshUser?.fishing?.gear?.baitCount || 0;
                const baitUpdate = {
                    $set: { 'fishing.gear.activeBait': 'none', 'fishing.gear.baitCount': 0 }
                };
                if (remaining > 0) {
                    baitUpdate.$set[`fishing.gear.ownedBaits.${activeBait}`] = remaining;
                }
                await User.updateOne(
                    { userId: interaction.user.id, 'fishing.gear.activeBait': activeBait },
                    baitUpdate
                );
                const baitConf = config.FISHING?.GEAR?.BAITS?.[activeBait];
                results.push(`${baitConf?.emoji || '🪱'} Bait **${baitConf?.name || activeBait}** unequipped (${remaining} saved).`);
            }

            if (results.length === 0) {
                return interaction.followUp({ content: "Nothing was equipped! You're already naked! B-Baka! >///< ", flags: MessageFlags.Ephemeral });
            }

            const embed = new EmbedBuilder()
                .setColor(0xFF4500)
                .setTitle("💥 Everything Unequipped!")
                .setDescription(`*"F-Fine! I stripped everything off you! A-Are you happy now?!"* >///<\n\n${results.join('\n')}`)
                .setThumbnail(interaction.user.displayAvatarURL())
                .setFooter({ text: "Use !equip to put stuff back on." });

            return interaction.followUp({ embeds: [embed] });
        }

        // --- SNATCH MODAL SUBMIT ---
        if (interaction.customId === 'snatch_modal') {
            try {
                const rawInput = interaction.fields.getTextInputValue('snatch_target').trim();
                // Parse user ID from mention or raw ID
                let targetId = rawInput.replace(/[<@!>]/g, '');
                
                if (!/^\d{17,20}$/.test(targetId)) {
                    // It's not a raw ID / Mention, try to resolve by username/displayName
                    const searchStr = rawInput.toLowerCase();
                    let memberMatch = interaction.guild.members.cache.find(m => 
                        m.user.username.toLowerCase() === searchStr || 
                        m.displayName.toLowerCase() === searchStr
                    );

                    // If not in cache, query Discord API directly (finds offline/uncached users)
                    if (!memberMatch) {
                        try {
                            const searchResults = await interaction.guild.members.fetch({ query: rawInput, limit: 10 });
                            memberMatch = searchResults.find(m => 
                                m.user.username.toLowerCase() === searchStr || 
                                m.displayName.toLowerCase() === searchStr
                            );
                        } catch (e) {
                            console.error("[SNATCH] Member search error:", e);
                        }
                    }

                    if (memberMatch) {
                        targetId = memberMatch.id;
                    } else {
                        // Fallback: Check database for users who might have left or aren't cached
                        // The user schema doesn't seem to store lastknownusername according to projections,
                        // so we just rely on discord cache for now, or error out if not found natively.
                        return interaction.reply({ content: "That's not a valid user ID or I couldn't find anyone by that name! Try again, idiot! (¬_¬)", flags: MessageFlags.Ephemeral });
                    }
                }

                if (targetId === interaction.user.id) {
                    return interaction.reply({ content: "You can't snatch YOURSELF! Are you stupid?! (¬_¬)", flags: MessageFlags.Ephemeral });
                }

                const target = await User.findOne({ userId: targetId });
                if (!target) {
                    return interaction.reply({ content: "That user doesn't exist in my database! (¬_¬)", flags: MessageFlags.Ephemeral });
                }
                if (!target.isSlave) {
                    return interaction.reply({ content: "That person isn't even a slave! Find an actual slave to snatch! (¬_¬)", flags: MessageFlags.Ephemeral });
                }
                if (target.slaveOwner === interaction.user.id) {
                    return interaction.reply({ content: "That's already YOUR slave! What are you doing?! (¬_¬)", flags: MessageFlags.Ephemeral });
                }

                const oldOwnerId = target.slaveOwner;

                // ATOMIC: Deduct Slave Snatcher from inventory before snatching to prevent double-use race conditions
                const snatcherCheck = await User.findOne({ userId: interaction.user.id });
                if (!snatcherCheck || !snatcherCheck.inventory.includes('Slave Snatcher')) {
                    return interaction.reply({ content: "You don't have a Slave Snatcher anymore! (¬_¬)", flags: MessageFlags.Ephemeral });
                }
                
                // Atomically pull one instance of 'Slave Snatcher'
                const itemIndex = snatcherCheck.inventory.indexOf('Slave Snatcher');
                const unsetObj = {};
                unsetObj[`inventory.${itemIndex}`] = 1;

                const snatchUpdate = await User.findOneAndUpdate(
                    { userId: interaction.user.id },
                    { $unset: unsetObj },
                    { new: true }
                );
                
                // Finalize array removal
                await User.updateOne({ userId: interaction.user.id }, { $pull: { inventory: null } });

                if (!snatchUpdate) {
                     return interaction.reply({ content: "Something went wrong taking the item! The snatch failed! (¬_¬)", flags: MessageFlags.Ephemeral });
                }

                // Transfer ownership + reset carrot (matches auction handler pattern)
                await User.updateOne({ userId: targetId }, { $set: {
                    slaveOwner: interaction.user.id,
                    carrotResistUsed: false,
                    resistExpiresAt: 0,
                    ...CARROT_RESET_SET
                } });

                // Transfer loan
                await Loan.updateOne(
                    { borrowerId: targetId, status: { $in: ['ACTIVE', 'DEFAULTED'] } },
                    { $set: { lenderId: interaction.user.id } }
                );

                // Announce in #tsun
                // Update slave's nickname to reflect new owner
                try {
                    const slaveMember = await interaction.guild.members.fetch(targetId).catch(() => null);
                    const newOwnerMember = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
                    if (slaveMember && newOwnerMember && slaveMember.manageable) {
                        const cleanName = slaveMember.displayName.replace(/\s\([^)]*'s Slave\)$/, '');
                        let newOwnerName = newOwnerMember.displayName;
                        if (newOwnerName.length > 15) newOwnerName = newOwnerName.substring(0, 15) + '..';
                        const suffix = ` (${newOwnerName}'s Slave)`;
                        const maxLen = Math.max(1, 32 - suffix.length);
                        const newName = cleanName.substring(0, maxLen) + suffix;
                        await slaveMember.setNickname(newName);
                    }
                } catch (e) {
                    console.error('[SNATCH] Failed to update slave nickname:', e);
                }

                // Announce in #tsun
                const announceChannel = interaction.guild.channels.cache.find(c => c.name === config.CHANNELS.MAIN);
                if (announceChannel) {
                    const embed = new EmbedBuilder()
                        .setColor(0x8B0000)
                        .setTitle('🎣 SLAVE SNATCHED!')
                        .setDescription(
                            `<@${interaction.user.id}> stole <@${targetId}> from <@${oldOwnerId}>!\n` +
                            `Their debt transfers too. The audacity! (¬_¬)`
                        );
                    await announceChannel.send({ embeds: [embed] });
                }

                return interaction.reply({ content: `🎣 You snatched <@${targetId}> from <@${oldOwnerId}>! Their debt is now yours to collect. H-How ruthless... (¬_¬)`, flags: MessageFlags.Ephemeral });
            } catch (e) {
                console.error('[SNATCH] Error:', e);
                if (!interaction.replied && !interaction.deferred) {
                    return interaction.reply({ content: 'Something went wrong with the snatch! >////<', flags: MessageFlags.Ephemeral });
                }
            }
        }

        if (interaction.customId === 'shop_purchase') {
            const item = interaction.values[0];
            if (!item) {
                return interaction.reply({ content: "That shop selection is empty. Stop poking cursed menus, baka! (¬_¬)", flags: MessageFlags.Ephemeral });
            }

            if (item.startsWith('rod_') || item.startsWith('bait_')) {
                // Baits show a modal (can't defer first), rods need deferring
                const isBaitPurchase = item.startsWith('bait_');
                if (!isBaitPurchase) {
                try {
                    if (!interaction.replied && !interaction.deferred) {
                        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                    }
                } catch (e) {
                    if (e?.code !== 10062 && e?.code !== 40060) console.error('[FISHING SHOP] Failed to defer purchase:', e);
                    try {
                        if (!interaction.replied && !interaction.deferred) {
                            await interaction.reply({ content: "I couldn't acknowledge that fishing purchase. Try the shop again, baka! (¬_¬)", flags: MessageFlags.Ephemeral });
                        }
                    } catch (replyError) {
                        if (replyError?.code !== 10062 && replyError?.code !== 40060) console.error('[FISHING SHOP] Failed to send defer fallback:', replyError);
                    }
                    return;
                }
                }
                const replyGear = async (content) => {
                    try {
                        if (interaction.replied || interaction.deferred) return await interaction.editReply({ content });
                        return await interaction.reply({ content, flags: MessageFlags.Ephemeral });
                    } catch (e) {
                        if (e?.code !== 10062 && e?.code !== 40060) console.error('[FISHING SHOP] Failed to reply:', e);
                        try {
                            if (interaction.replied || interaction.deferred) {
                                return await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
                            }
                        } catch (followError) {
                            if (followError?.code !== 10062 && followError?.code !== 40060) console.error('[FISHING SHOP] Failed to send follow-up:', followError);
                        }
                    }
                };
                try {
                    const isRod = item.startsWith('rod_');
                    const gearId = item.replace(/^(rod|bait)_/, '');
                    const purchaseBaitStack = async (currencyField, cost, quantity) => {
                        const balanceFilter = { [currencyField]: { $gte: cost } };
                        const sameBaitUpdate = {
                            $inc: {
                                [currencyField]: -cost,
                                'fishing.gear.baitCount': quantity
                            },
                            $set: { 'fishing.gear.activeBait': gearId }
                        };
                        const switchBaitUpdate = {
                            $inc: { [currencyField]: -cost },
                            $set: {
                                'fishing.gear.activeBait': gearId,
                                'fishing.gear.baitCount': quantity
                            }
                        };

                        let updateRes = await User.findOneAndUpdate(
                            { userId: interaction.user.id, ...balanceFilter, 'fishing.gear.activeBait': gearId },
                            sameBaitUpdate,
                            { new: true }
                        );
                        if (updateRes) return updateRes;

                        updateRes = await User.findOneAndUpdate(
                            { userId: interaction.user.id, ...balanceFilter, 'fishing.gear.activeBait': { $ne: gearId } },
                            switchBaitUpdate,
                            { new: true }
                        );
                        if (updateRes) return updateRes;

                        return User.findOneAndUpdate(
                            { userId: interaction.user.id, ...balanceFilter, 'fishing.gear.activeBait': gearId },
                            sameBaitUpdate,
                            { new: true }
                        );
                    };

                    if (isRod) {
                        const gearInfo = config.FISHING.GEAR.RODS[gearId];
                        if (!gearInfo) return replyGear("What rod is that?! Stop making things up! (¬_¬)");

                        // Flimsy Stick is free and always available — just equip it
                        if (gearId === 'flimsy_stick') {
                            if (user.fishing?.gear?.activeRod === 'flimsy_stick') {
                                return replyGear("You're already using the Flimsy Stick, baka! (¬_¬)");
                            }
                            const oldRod = user.fishing?.gear?.activeRod || 'flimsy_stick';
                            const oldDur = user.fishing?.gear?.rodDurability || 0;
                            const setFields = { 'fishing.gear.activeRod': 'flimsy_stick', 'fishing.gear.rodDurability': 0 };
                            if (oldRod !== 'flimsy_stick') setFields[`fishing.gear.ownedRods.${oldRod}`] = oldDur;
                            await User.updateOne({ userId: interaction.user.id }, { $set: setFields });
                            return replyGear(`🎋 Switched back to the **Flimsy Stick**. Infinite durability, zero dignity. (¬_¬)`);
                        }

                        // Check if already owned — re-fetch fresh to avoid stale Map issues
                        const purchaseCheck = await User.findOne({ userId: interaction.user.id }).select('nuggets fishing.gear').lean();
                        const purchaseOwned = purchaseCheck?.fishing?.gear?.ownedRods || {};
                        if (purchaseOwned[gearId] !== undefined) {
                            return replyGear(`You already own the **${gearInfo.name}**! Use \`!equip\` to switch to it, idiot! (¬_¬)`);
                        }

                        if ((purchaseCheck?.nuggets || 0) < gearInfo.cost) {
                            return replyGear(`🚫 You need **${gearInfo.cost} Nuggets** to buy the ${gearInfo.name}! You only have ${purchaseCheck?.nuggets || 0}, you broke idiot! (¬_¬)`);
                        }

                        // Save old rod durability back, add new rod, equip it
                        const oldRod = purchaseCheck?.fishing?.gear?.activeRod || 'flimsy_stick';
                        const oldDur = purchaseCheck?.fishing?.gear?.rodDurability || 0;
                        const setFields = {
                            'fishing.gear.activeRod': gearId,
                            'fishing.gear.rodDurability': gearInfo.maxDurability,
                            [`fishing.gear.ownedRods.${gearId}`]: gearInfo.maxDurability
                        };
                        if (oldRod !== 'flimsy_stick') setFields[`fishing.gear.ownedRods.${oldRod}`] = oldDur;

                        const updateRes = await User.findOneAndUpdate(
                            { userId: interaction.user.id, nuggets: { $gte: gearInfo.cost }, [`fishing.gear.ownedRods.${gearId}`]: { $exists: false } },
                            {
                                $inc: { nuggets: -gearInfo.cost },
                                $set: setFields
                            },
                            { new: true }
                        );
                        if (!updateRes) {
                            const freshUser = await User.findOne({ userId: interaction.user.id }).select('nuggets fishing.gear.ownedRods').lean();
                            const freshOwned = freshUser?.fishing?.gear?.ownedRods || {};
                            if (freshOwned[gearId] !== undefined) {
                                return replyGear(`You already own the **${gearInfo.name}**! Use \`!equip\` to switch to it! (¬_¬)`);
                            }
                            return replyGear(`🚫 Transaction failed! You don't have enough nuggets, you broke idiot! (¬_¬)`);
                        }

                        return replyGear(`🎣 **Purchased and Equipped:** ${gearInfo.emoji} ${gearInfo.name}! You better actually catch something with this! (¬_¬)`);
                    } else {
                        const baitInfo = config.FISHING.GEAR.BAITS[gearId];
                        if (!baitInfo || gearId === 'none') return replyGear("What bait is that?! Don't waste my time! (¬_¬)");

                        // Show quantity modal instead of auto-buying
                        const isNuggetBait = !!baitInfo.costNuggets;
                        let maxQty;
                        if (isNuggetBait) {
                            maxQty = Math.min(50, user.nuggets || 0);
                        } else {
                            let perUnitCost = baitInfo.costBase + Math.floor((user.coins || 0) * baitInfo.costScaleMult);
                            if (perUnitCost > baitInfo.maxCost) perUnitCost = baitInfo.maxCost;
                            maxQty = perUnitCost > 0 ? Math.min(100, Math.floor((user.coins || 0) / perUnitCost)) : 0;
                        }

                        if (maxQty <= 0) {
                            return replyGear(`🚫 You can't afford any **${baitInfo.name}**! Go earn something first, baka! (¬_¬)`);
                        }

                        const modal = new ModalBuilder()
                            .setCustomId(`bait_buy_modal_${gearId}`)
                            .setTitle(`Buy ${baitInfo.name}`);

                        const input = new TextInputBuilder()
                            .setCustomId('bait_quantity')
                            .setLabel(`Quantity (1-${maxQty})`)
                            .setPlaceholder(`${isNuggetBait ? `1 Nugget each` : `Coins scale with wallet`}. Max: ${maxQty}`)
                            .setStyle(TextInputStyle.Short)
                            .setMinLength(1)
                            .setMaxLength(3)
                            .setRequired(true);

                        modal.addComponents(new ActionRowBuilder().addComponents(input));
                        return interaction.showModal(modal);
                    }
                } catch (e) {
                    console.error('[FISHING SHOP] Purchase failed:', e);
                    return replyGear("S-Something broke while buying that fishing gear. I didn't take your stuff, okay?! Try again in a moment! >///<");
                }
            }

            // Base prices for items
            const basePrices = {
                'frame_random': 2000, 'frame_custom': 5000,
                'item_shield': 40000, 'item_amulet': 1000, 'curse_trash': 40000, 'reset_cd': 15000,
                'role_sugar': config.SHOP_PRICES.SUGAR_ROLE, 'item_slave_remove': 10000, 'item_streak_freeze': 100000,
                'curse_mediocrity': 200000
            };

            const basePrice = basePrices[item] || 50000;
            let cost = basePrice + Math.floor((user.coins || 0) * config.SHOP_PRICES.WEALTH_TAX_RATE);


            // SPECIAL CASE: Streak Freeze
            if (item === 'item_streak_freeze') {
                cost = Math.max(config.SHOP_PRICES["Streak Freeze"].BASE, Math.floor((user.coins || 0) * config.SHOP_PRICES["Streak Freeze"].WALLET_RATE));
            }
            // SPECIAL CASE: Curse of Mediocrity
            if (item === 'curse_mediocrity') {
                cost = Math.max(config.SHOP_PRICES["Curse of Mediocrity"].BASE, Math.floor((user.coins || 0) * config.SHOP_PRICES["Curse of Mediocrity"].WALLET_RATE));
            }

            // Sugar role: free switch check bypasses the coin guard
            const sugarFreeSwitch = item === 'role_sugar' && (() => {
                const dr = interaction.guild?.roles.cache.find(r => r.name.toLowerCase() === config.ROLES.SUGAR_DADDY.toLowerCase());
                const mr = interaction.guild?.roles.cache.find(r => r.name.toLowerCase() === config.ROLES.SUGAR_MOMMY.toLowerCase());
                return (dr && interaction.member.roles.cache.has(dr.id)) || (mr && interaction.member.roles.cache.has(mr.id));
            })();

            if (user.coins < cost && !sugarFreeSwitch) return interaction.reply({ content: `H-Hah? You're too poor! You need ${cost} coins!`, ephemeral: true });
            // For frame_custom, DON'T deduct coins here - the color_modal handler charges the user
            // This prevents double-charging when modal is submitted
            if (item === 'frame_custom') {
                const modal = new ModalBuilder().setCustomId('color_modal').setTitle('Pick Color');
                const input = new TextInputBuilder().setCustomId('hex').setLabel('Hex (e.g. #FF0000)').setStyle(TextInputStyle.Short).setMinLength(6).setMaxLength(7);
                modal.addComponents(new ActionRowBuilder().addComponents(input));
                return interaction.showModal(modal);
            }

            // Deduct coins organically via atomic queries for each item logic block
            if (item === 'frame_random') {
                const hexColor = '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');
                const updateRes = await User.findOneAndUpdate(
                    { userId: interaction.user.id, coins: { $gte: cost } },
                    { $inc: { coins: -cost, systemSpent: cost }, $set: { frameColor: hexColor } },
                    { new: true }
                );
                if (!updateRes) return interaction.reply({ content: `🚫 Transaction failed! You couldn't afford it!`, ephemeral: true });
                return interaction.reply({ content: `🎨 Color set to: **${hexColor}**!`, ephemeral: true });
            }
            else if (item === 'role_sugar') {
                const daddyRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === config.ROLES.SUGAR_DADDY.toLowerCase());
                const mommyRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === config.ROLES.SUGAR_MOMMY.toLowerCase());

                if (!daddyRole || !mommyRole) {
                    return interaction.reply({ content: "⚠️ Sugar roles not found in server! Run role sync or contact the owner. (¬_¬)", ephemeral: true });
                }

                const alreadyOwnsEither = interaction.member.roles.cache.has(daddyRole.id) || interaction.member.roles.cache.has(mommyRole.id);

                // No coin deduction here — coins are deducted in the button handler
                // when the user actually picks a role. This prevents money loss from abandoned pickers.

                // Show picker — public message
                const pickerEmbed = new EmbedBuilder()
                    .setColor(0xFFD700)
                    .setTitle('💎 Choose Your Title')
                    .setDescription(
                        `${alreadyOwnsEither ? '*Free switch — you already own a Sugar role this season.*' : `*${cost.toLocaleString('en-US')} coins will be deducted when you pick.*`}\n\n` +
                        `Pick your role below.\n\n` +
                        `⚠️ **You can only hold ONE Sugar role at a time.** Picking a new one removes the other. This is a one-time purchase per season — switching is always free.`
                    );

                const pickerRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`sugar_daddy_${interaction.user.id}`)
                        .setLabel('💰 Sugar Daddy')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId(`sugar_mommy_${interaction.user.id}`)
                        .setLabel('🌸 Sugar Mommy')
                        .setStyle(ButtonStyle.Success)
                );

                return interaction.reply({ embeds: [pickerEmbed], components: [pickerRow] });
            }
            else if (item === 'item_slave_remove') {
                if (!user.isSlave) return interaction.reply({ content: "You aren't a slave, idiot! Don't waste money!", ephemeral: true });

                const activeDebt = await Loan.findOne({ borrowerId: user.userId, status: { $in: ['ACTIVE', 'DEFAULTED'] } });
                if (activeDebt) return interaction.reply({ content: `🚫 You still owe **${activeDebt.remainingAmount}** coins! Repay your debt with \`!loan repay\` first!`, ephemeral: true });

                const updateRes = await User.findOneAndUpdate(
                    { userId: interaction.user.id, coins: { $gte: cost } },
                    { 
                        $inc: { coins: -cost, systemSpent: cost },
                        $set: {
                            isSlave: false,
                            slaveOwner: null,
                            carrotResistUsed: false,
                            resistExpiresAt: 0,
                            ...CARROT_RESET_SET
                        }
                    },
                    { new: true }
                );
                if (!updateRes) return interaction.reply({ content: `🚫 Transaction failed! You couldn't afford it!`, ephemeral: true });

                try {
                    const member = interaction.member;
                    if (member.manageable) {
                        const oldName = member.displayName;
                        const newName = oldName.replace(/\s\([^)]*'s Slave\)$/, "");
                        if (newName !== oldName) await member.setNickname(newName);
                    }
                } catch (e) { /* Ignore perm errors */ }

                return interaction.reply({ content: `🕊️ **FREEDOM!** You are no longer a slave! Try not to fail again!`, ephemeral: true });
            }
            else if (item === 'reset_cd') {
                if (battleSystem.resetCooldowns) {
                    const updateRes = await User.findOneAndUpdate(
                        { userId: interaction.user.id, coins: { $gte: cost } },
                        { $inc: { coins: -cost, systemSpent: cost } },
                        { new: true }
                    );
                    if (!updateRes) return interaction.reply({ content: `🚫 Transaction failed! You couldn't afford it!`, ephemeral: true });

                    battleSystem.resetCooldowns(interaction.user.id);
                    return interaction.reply({ content: `⏰ Cooldowns reset. Tch... you're welcome.`, ephemeral: true });
                }
                return interaction.reply({ content: "Battle system not linked. Tell the dev to fix their mess.", ephemeral: true });
            }
            else if (item === 'item_streak_freeze') {
                const updateRes = await User.findOneAndUpdate(
                    { userId: interaction.user.id, coins: { $gte: cost } },
                    { $inc: { coins: -cost, systemSpent: cost }, $push: { inventory: 'Streak Freeze' } },
                    { new: true }
                );
                if (!updateRes) return interaction.reply({ content: `🚫 Transaction failed! You couldn't afford it!`, ephemeral: true });
                return interaction.reply({ content: `❄️ Bought **Streak Freeze** for **${cost.toLocaleString('en-US')}** coins. It'll auto-activate if you miss a day. D-Don't thank me! (¬_¬)`, ephemeral: true });
            }
            else if (item === 'curse_mediocrity') {
                const updateRes = await User.findOneAndUpdate(
                    { userId: interaction.user.id, coins: { $gte: cost } },
                    { $inc: { coins: -cost, systemSpent: cost }, $push: { inventory: 'Curse of Mediocrity' } },
                    { new: true }
                );
                if (!updateRes) return interaction.reply({ content: `🚫 Transaction failed! You couldn't afford it!`, ephemeral: true });

                // Anonymous announcement
                const announceChannel = interaction.guild.channels.cache.find(c => c.name === config.CHANNELS.MAIN);
                if (announceChannel) {
                    await announceChannel.send(`😈 Someone just bought a **Curse of Mediocrity**... someone's gacha is about to get very sad. (¬_¬)`);
                }
                return interaction.reply({ content: `😈 Bought **Curse of Mediocrity**. Use it with \`!curse @target\`. They'll never know who did it... (¬_¬)`, ephemeral: true });
            }
            else {
                let name = "";
                if (item.startsWith('title_')) {
                    const TITLE_NAME_OVERRIDES = {
                        'title_Onee-sans_FuckToy': "Onee-San's Fucktoy",
                        'title_IDF_Soldier': "IDF Soldier",
                    };
                    name = TITLE_NAME_OVERRIDES[item] ?? titleCase(item.replace('title_', '').replace(/_/g, ' '));
                }
                else if (item === 'item_shield') name = "Elo Shield";
                else if (item === 'item_amulet') name = "Coin Amulet";
                else if (item === 'curse_trash') name = "Trash Curse";

                // Block duplicate title purchases
                if (item.startsWith('title_') && user.inventory.includes(name)) {
                    return interaction.reply({ content: "You already own that title, idiot! (¬_¬)", flags: MessageFlags.Ephemeral });
                }

                const filter = { userId: interaction.user.id, coins: { $gte: cost } };
                // Race-condition safety: prevent double-add even if two clicks fire concurrently
                if (item.startsWith('title_')) filter.inventory = { $ne: name };

                const updateRes = await User.findOneAndUpdate(
                    filter,
                    { $inc: { coins: -cost, systemSpent: cost }, $push: { inventory: name } },
                    { new: true }
                );
                
                if (!updateRes) return interaction.reply({ content: `🚫 Transaction failed! You couldn't afford it!`, ephemeral: true });
                return interaction.reply({ content: `✅ Bought **${name}**. Don't make me repeat myself.`, ephemeral: true });
            }
        }

        // 4. COLOR MODAL
        if (interaction.customId === 'color_modal') {
            let hex = interaction.fields.getTextInputValue('hex');
            if (!hex.startsWith('#')) hex = '#' + hex;

            if (!/^#([0-9A-F]{3}|[0-9A-F]{6})$/i.test(hex)) {
                return interaction.reply({ content: "🚫 Invalid Hex! Use #FF0000.", ephemeral: true });
            }

            // Calculate cost again
            const cost = 5000 + Math.floor(user.coins * config.SHOP_PRICES.WEALTH_TAX_RATE);

            if (user.coins < cost) return interaction.reply({ content: `🚫 Inflation hits hard! You need **${cost.toLocaleString('en-US')}** coins to change colors!`, ephemeral: true });
            const updateRes = await User.findOneAndUpdate(
                { userId: interaction.user.id, coins: { $gte: cost } },
                { $inc: { coins: -cost, systemSpent: cost }, $set: { frameColor: hex } },
                { new: true }
            );
            if (!updateRes) return interaction.reply({ content: `🚫 Transaction failed! You couldn't afford it!`, ephemeral: true });
            
            return interaction.reply({ content: `✅ Color set to **${hex}**. (-${cost.toLocaleString('en-US')} coins)`, ephemeral: true });
        } // End of handleInteraction 'color_modal' block

        // 4b. BAIT BUY MODAL
        if (interaction.customId.startsWith('bait_buy_modal_')) {
            const baitId = interaction.customId.replace('bait_buy_modal_', '');
            const baitInfo = config.FISHING.GEAR.BAITS[baitId];
            if (!baitInfo || baitId === 'none') {
                return interaction.reply({ content: "That bait doesn't exist! Stop hacking! (\u00ac_\u00ac)", flags: MessageFlags.Ephemeral });
            }

            const rawQty = interaction.fields.getTextInputValue('bait_quantity').trim();
            const quantity = parseInt(rawQty, 10);
            if (isNaN(quantity) || quantity < 1) {
                return interaction.reply({ content: "Enter a valid number, baka! At least 1! (\u00ac_\u00ac)", flags: MessageFlags.Ephemeral });
            }

            try {
                const freshUser = await User.findOne({ userId: interaction.user.id }).lean();
                const isNuggetBait = !!baitInfo.costNuggets;

                if (isNuggetBait) {
                    const totalCost = baitInfo.costNuggets * quantity;
                    const maxQty = Math.min(50, freshUser.nuggets || 0);
                    const clampedQty = Math.min(quantity, maxQty);
                    if (clampedQty <= 0) {
                        return interaction.reply({ content: `\ud83d\udeab You can't afford any **${baitInfo.name}**! Go earn some nuggets! (\u00ac_\u00ac)`, flags: MessageFlags.Ephemeral });
                    }
                    const clampedCost = baitInfo.costNuggets * clampedQty;

                    // Atomic purchase: deduct nuggets, add to ownedBaits
                    const currentBait = freshUser?.fishing?.gear?.activeBait || 'none';
                    const incOps = { nuggets: -clampedCost, [`fishing.gear.ownedBaits.${baitId}`]: clampedQty };
                    if (currentBait === baitId) incOps['fishing.gear.baitCount'] = clampedQty;

                    const result = await User.findOneAndUpdate(
                        { userId: interaction.user.id, nuggets: { $gte: clampedCost } },
                        { $inc: incOps },
                        { new: true }
                    );
                    if (!result) {
                        return interaction.reply({ content: `\ud83d\udeab Transaction failed! Your nuggets vanished! (\u00ac_\u00ac)`, flags: MessageFlags.Ephemeral });
                    }
                    return interaction.reply({ content: `\ud83c\udf1f **Purchased:** ${clampedQty}x ${baitInfo.emoji} ${baitInfo.name} for ${clampedCost} Nuggets! ${currentBait === baitId ? 'Added to equipped bait!' : 'Use \`!equip\` to use them!'} (\u00ac_\u00ac)`, flags: MessageFlags.Ephemeral });

                } else {
                    // Coin bait
                    let perUnitCost = baitInfo.costBase + Math.floor((freshUser.coins || 0) * baitInfo.costScaleMult);
                    if (perUnitCost > baitInfo.maxCost) perUnitCost = baitInfo.maxCost;
                    const maxQty = perUnitCost > 0 ? Math.min(100, Math.floor((freshUser.coins || 0) / perUnitCost)) : 0;
                    const clampedQty = Math.min(quantity, maxQty);
                    if (clampedQty <= 0) {
                        return interaction.reply({ content: `\ud83d\udeab You can't afford any **${baitInfo.name}**! Go earn some coins! (\u00ac_\u00ac)`, flags: MessageFlags.Ephemeral });
                    }
                    const totalCost = perUnitCost * clampedQty;

                    const currentBait = freshUser?.fishing?.gear?.activeBait || 'none';
                    const incOps = { coins: -totalCost, systemSpent: totalCost, [`fishing.gear.ownedBaits.${baitId}`]: clampedQty };
                    if (currentBait === baitId) incOps['fishing.gear.baitCount'] = clampedQty;

                    const result = await User.findOneAndUpdate(
                        { userId: interaction.user.id, coins: { $gte: totalCost } },
                        { $inc: incOps },
                        { new: true }
                    );
                    if (!result) {
                        return interaction.reply({ content: `\ud83d\udeab Transaction failed! Your wallet is empty! (\u00ac_\u00ac)`, flags: MessageFlags.Ephemeral });
                    }
                    return interaction.reply({ content: `\ud83e\udeb1 **Purchased:** ${clampedQty}x ${baitInfo.emoji} ${baitInfo.name} for ${totalCost.toLocaleString('en-US')} Coins! ${currentBait === baitId ? 'Added to equipped bait!' : 'Use \`!equip\` to use them!'} (\u00ac_\u00ac)`, flags: MessageFlags.Ephemeral });
                }
            } catch (e) {
                console.error('[BAIT SHOP] Modal purchase failed:', e);
                return interaction.reply({ content: "S-Something broke while buying bait! I didn't take your stuff! Try again! \u003e///\u003c", flags: MessageFlags.Ephemeral });
            }
        }

        // --- AMULET STACKING HANDLERS ---
        // Helper function to calculate amulet multiplier
        const calculateAmuletMultiplier = (count) => {
            const t = config.AMULET_TIERS;
            if (count <= 0) return 1.0;
            if (count === 1) return t.BASE;

            let mult = t.BASE;
            const tier1 = Math.min(count, 10) - 1;
            if (tier1 > 0) mult += tier1 * t.TIER1_RATE;
            if (count > 10) mult += (Math.min(count, 30) - 10) * t.TIER2_RATE;
            if (count > 30) mult += (Math.min(count, t.MAX_STACK) - 30) * t.TIER3_RATE;

            return mult;
        };

        // Amulet: No Amulet button
        if (interaction.customId === 'amulet_none') {
            const freshUser = await User.findOne({ userId: interaction.user.id });
            const amCount = freshUser.equippedAmuletCount || 0;
            
            if (amCount > 0) {
                const returnedAmulets = Array(amCount).fill("Coin Amulet");
                await User.updateOne(
                    { userId: interaction.user.id },
                    { 
                        $push: { inventory: { $each: returnedAmulets } },
                        $set: { equippedAmuletCount: 0 }
                    }
                );
            }
            user.equippedAmuletCount = 0; // Update local state

            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle("🪙 Amulets Unequipped")
                .setDescription("*\"F-Fine! I unequipped all your amulets... not that I care if you lose!\"* (¬_¬)")
                .setThumbnail(interaction.user.displayAvatarURL());
            return interaction.update({ embeds: [embed], components: [] });
        }

        // Amulet: Custom button - show modal
        if (interaction.customId === 'amulet_custom') {
            const amuletCount = user.inventory.filter(i => i === "Coin Amulet").length;
            const totalAvailable = amuletCount + user.equippedAmuletCount;
            const maxStack = Math.min(totalAvailable, 50);

            const modal = new ModalBuilder()
                .setCustomId('amulet_stack_modal')
                .setTitle('Amulet Stacking');

            const input = new TextInputBuilder()
                .setCustomId('amulet_quantity')
                .setLabel(`Quantity to equip (1-${maxStack})`)
                .setPlaceholder(`You have ${totalAvailable} total. Max: 50`)
                .setStyle(TextInputStyle.Short)
                .setMinLength(1)
                .setMaxLength(2)
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(input));
            return interaction.showModal(modal);
        }

        // Amulet: Modal submit
        if (interaction.customId === 'amulet_stack_modal') {
            const quantity = parseInt(interaction.fields.getTextInputValue('amulet_quantity'));

            if (isNaN(quantity) || quantity < 1) {
                return interaction.reply({ content: "Enter a valid number, you idiot! (¬_¬)", ephemeral: true });
            }

            if (quantity > 50) {
                return interaction.reply({ content: "B-Baka! Max stack is 50! Don't try to cheat the system! >///< ", ephemeral: true });
            }

            const freshUser = await User.findOne({ userId: interaction.user.id });
            const currentEquipped = freshUser.equippedAmuletCount || 0;
            const inventoryAmulets = freshUser.inventory.filter(i => i === "Coin Amulet").length;
            const totalAvailable = currentEquipped + inventoryAmulets;

            if (quantity > totalAvailable) {
                return interaction.reply({ content: `You only have ${totalAvailable} total amulets! Stop lying! (¬_¬)`, ephemeral: true });
            }

            const netChange = currentEquipped - quantity;

            if (netChange > 0) {
                // Returning amulets to inventory (equipping fewer)
                const returnedAmulets = Array(netChange).fill("Coin Amulet");
                await User.updateOne(
                    { userId: interaction.user.id }, 
                    { 
                        $push: { inventory: { $each: returnedAmulets } },
                        $set: { equippedAmuletCount: quantity }
                    }
                );
            } else if (netChange < 0) {
                // Consuming amulets from inventory (equipping more)
                const toConsume = Math.abs(netChange);
                const unsetObj = {};
                let foundConsumed = 0;
                
                for (let i = 0; i < freshUser.inventory.length; i++) {
                    if (freshUser.inventory[i] === "Coin Amulet") {
                        unsetObj[`inventory.${i}`] = 1;
                        foundConsumed++;
                        if (foundConsumed === toConsume) break;
                    }
                }
                
                if (Object.keys(unsetObj).length > 0) {
                    await User.updateOne({ userId: interaction.user.id }, { $unset: unsetObj });
                    await User.updateOne(
                        { userId: interaction.user.id }, 
                        { 
                            $pull: { inventory: null },
                            $set: { equippedAmuletCount: quantity }
                        }
                    );
                } else {
                     await User.updateOne({ userId: interaction.user.id }, { $set: { equippedAmuletCount: quantity } });
                }
            }
            
            user.equippedAmuletCount = quantity; // Update local state
            const multiplier = calculateAmuletMultiplier(quantity);

            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle("🪙 Amulets Stacked!")
                .setDescription(
                    `*\"T-There! Happy now?!\"* >///< \n\n` +
                    `**Equipped:** ${quantity}x Coin Amulet\n` +
                    `**Multiplier:** ${multiplier.toFixed(2)}x\n\n` +
                    `*All amulets consumed on duel WIN!*`
                )
                .setThumbnail(interaction.user.displayAvatarURL());
            return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        // --- SHADY MERCHANT HANDLERS ---
        const SELLABLE_ITEMS = {
            "Coin Amulet": { base: 1000, minMult: 0.5, maxMult: 1.5 },
            "Elo Shield": { base: 5000, minMult: 0.1, maxMult: 2.0 },
            "Trash Curse": { base: 40000, minMult: 0.1, maxMult: 1.5 },
            "Slave Tag Remover": { base: 10000, minMult: 0.1, maxMult: 1.5 },
            "Slave Freedom Ticket": { base: 65000, minMult: 0.77, maxMult: 1.23 }
        };

        const SALE_PHRASES = [
            "F-Fine, take your coins! Don't spend them all at once, idiot!",
            "You call this a deal? Whatever... here.",
            "I-It's not like I WANTED to buy this! I just... needed inventory!",
            "Tch, don't come back expecting the same prices! >///< ",
            "There! Happy now?! Now get out of my sight!"
        ];

        // Merchant Item Selected - Show Confirmation
        if (interaction.customId === 'merchant_item_selector') {
            const itemName = interaction.values[0].replace('merchant_sell_', '');
            const price = user.merchantPrices?.get(itemName) || SELLABLE_ITEMS[itemName]?.base || 0;
            const ownedCount = user.inventory.filter(i => i === itemName).length;
            const dailyRemaining = Math.max(0, 200000 - user.merchantDailySold);

            if (ownedCount === 0) {
                return interaction.reply({ content: "Y-You don't even own that item anymore! Stop wasting my time!", ephemeral: true });
            }

            const maxSellable = Math.min(ownedCount, Math.floor(dailyRemaining / price), 20);

            const embed = new EmbedBuilder()
                .setColor(0x4A0080)
                .setTitle("🏴‍☠️ SELL CONFIRMATION")
                .setDescription(
                    `You're selling: **${itemName}** x1\n` +
                    `You'll receive: **${price.toLocaleString('en-US')} coins**\n\n` +
                    `*"Y-You sure? No refunds!"* >///< \n\n` +
                    `📦 You own: **${ownedCount}** | 💰 Daily remaining: **${dailyRemaining.toLocaleString('en-US')}**`
                )
                .setThumbnail(client.user.displayAvatarURL())
                .setFooter({ text: `Max you can sell: ${maxSellable}` });

            const components = [
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`merchant_confirm_${itemName}_1`)
                        .setLabel('✅ Sell 1')
                        .setStyle(ButtonStyle.Success)
                        .setDisabled(dailyRemaining < price),
                    new ButtonBuilder()
                        .setCustomId(`merchant_cancel`)
                        .setLabel('❌ Cancel')
                        .setStyle(ButtonStyle.Danger),
                    new ButtonBuilder()
                        .setCustomId(`merchant_bulk_${itemName}`)
                        .setLabel(`📦 Bulk Sell (${ownedCount})`)
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(ownedCount < 2 || maxSellable < 2)
                )
            ];

            return interaction.update({ embeds: [embed], components });
        }

        // Merchant Confirm Sale (single or from bulk)
        if (interaction.customId.startsWith('merchant_confirm_')) {
            const parts = interaction.customId.split('_');
            const itemName = parts[2];
            const quantity = parseInt(parts[3]);

            const price = user.merchantPrices?.get(itemName) || SELLABLE_ITEMS[itemName]?.base || 0;
            const ownedCount = user.inventory.filter(i => i === itemName).length;
            const dailyRemaining = Math.max(0, 200000 - user.merchantDailySold);
            const totalValue = price * quantity;

            if (ownedCount < quantity) {
                return interaction.reply({ content: `You only have ${ownedCount}! Stop trying to scam me! (¬_¬)`, ephemeral: true });
            }

            // Cap to daily limit (partial sale)
            const actualValue = Math.min(totalValue, dailyRemaining);
            const actualQuantity = Math.floor(actualValue / price);

            if (actualQuantity === 0) {
                return interaction.reply({ content: "You've hit your daily limit! Come back tomorrow, greedy!", ephemeral: true });
            }

            // Atomically remove items from inventory to prevent data loss
            const freshUser = await User.findOne({ userId: interaction.user.id });
            const unsetObj = {};
            let removedCount = 0;
            
            for (let i = 0; i < freshUser.inventory.length; i++) {
                if (freshUser.inventory[i] === itemName) {
                    unsetObj[`inventory.${i}`] = 1;
                    removedCount++;
                    if (removedCount === actualQuantity) break;
                }
            }

            if (Object.keys(unsetObj).length > 0) {
                await User.updateOne({ userId: interaction.user.id }, { $unset: unsetObj });
            }

            // Pay through distributeIncome (applies Rich Tax, Slave Tax, Loan Repayment)
            const payout = actualQuantity * price;
            
            // Atomically update inventory and daily limit BEFORE processing payment
            await User.updateOne(
                { userId: interaction.user.id },
                { 
                    $pull: { inventory: null },
                    $inc: { merchantDailySold: payout }
                }
            );

            await distributeIncome(interaction.user.id, payout);
            
            // Refresh local user state for the final embed display
            user = await User.findOne({ userId: interaction.user.id }); 

            const phrase = SALE_PHRASES[Math.floor(Math.random() * SALE_PHRASES.length)];

            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle("💰 SALE COMPLETE!")
                .setDescription(
                    `**Sold:** ${itemName} x${actualQuantity}\n` +
                    `**Pre-Tax Payout:** ${payout.toLocaleString('en-US')} coins\n` +
                    `**Your Balance:** ${user.coins.toLocaleString('en-US')} coins\n\n` +
                    `*"${phrase}"*\n\n` +
                    (actualQuantity < quantity ? `⚠️ *Partial sale! Daily limit reached.*` : '')
                )
                .setThumbnail(client.user.displayAvatarURL());

            // Delete the confirmation message and reply with success
            await interaction.message.delete().catch(() => { });
            return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        // Merchant Cancel / Back - Regenerate Merchant View
        if (interaction.customId === 'merchant_cancel' || interaction.customId === 'merchant_back') {
            // Regenerate merchant prices if needed
            const now = Date.now();
            const oneDayMs = 24 * 60 * 60 * 1000;

            if (!user.merchantPrices || user.merchantPrices.size === 0) {
                user.merchantPrices = new Map();
                for (const [name, data] of Object.entries(SELLABLE_ITEMS)) {
                    const mult = data.minMult + Math.random() * (data.maxMult - data.minMult);
                    user.merchantPrices.set(name, Math.floor(data.base * mult));
                }
                user.merchantLastRefresh = now;
                await User.updateOne(
                    { userId: interaction.user.id },
                    { $set: { merchantPrices: user.merchantPrices, merchantLastRefresh: user.merchantLastRefresh } }
                );
            }

            // Check refresh timing
            if (now - user.merchantLastRefresh >= oneDayMs) {
                user.merchantFreeRefreshUsed = false;
                user.merchantDailySold = 0;
            }

            // Calculate items user can sell
            const sellableOwned = [];
            for (const [name, data] of Object.entries(SELLABLE_ITEMS)) {
                const count = user.inventory.filter(i => i === name).length;
                if (count > 0) {
                    sellableOwned.push({
                        name,
                        count,
                        price: user.merchantPrices?.get(name) || data.base
                    });
                }
            }

            const dailyRemaining = Math.max(0, 200000 - user.merchantDailySold);
            const nextFreeRefresh = user.merchantLastRefresh + oneDayMs;
            const refreshCost = user.merchantFreeRefreshUsed ? Math.floor(5000 + (user.coins / 30)) : 0;

            const embed = new EmbedBuilder()
                .setColor(0x4A0080)
                .setTitle("🏴‍☠️ ═══ SHADY MERCHANT ═══ 🏴‍☠️")
                .setDescription(
                    `*\"Back again, eh? Fine, fine...\"* (¬_¬)\n\n` +
                    `💰 **Daily Limit:** ${dailyRemaining.toLocaleString('en-US')} / 200,000 remaining\n` +
                    `🔄 **Free Refresh:** ${user.merchantFreeRefreshUsed ? `<t:${Math.floor(nextFreeRefresh / 1000)}:R>` : '✅ Available!'}\n` +
                    `⏰ **Prices Reset:** <t:${Math.floor(nextFreeRefresh / 1000)}:R>\n\n` +
                    (sellableOwned.length === 0 ? "❌ *You have nothing to sell! Come back with some items!*" : "")
                )
                .setThumbnail(client.user.displayAvatarURL())
                .setFooter({ text: "Prices reset daily. Use Refresh to reroll!" });

            if (sellableOwned.length > 0) {
                const priceList = sellableOwned.map(i =>
                    `• **${i.name}** x${i.count} → 🪙 ${i.price.toLocaleString('en-US')}c each`
                ).join('\n');
                embed.addFields({ name: "📊 Today's Prices", value: priceList, inline: false });
            }

            const components = [];

            if (sellableOwned.length > 0) {
                const options = sellableOwned.map(i => ({
                    label: `${i.name} (${i.price.toLocaleString('en-US')}c)`,
                    description: `You own: ${i.count}`,
                    value: `merchant_sell_${i.name}`,
                    emoji: i.name === 'Coin Amulet' ? '🪙' : (i.name === 'Elo Shield' ? '🛡️' : '📦')
                }));

                const selectRow = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId('merchant_item_selector')
                        .setPlaceholder('📦 Select item to sell...')
                        .addOptions(options.slice(0, 25))
                );
                components.push(selectRow);
            }

            const refreshLabel = user.merchantFreeRefreshUsed
                ? `🔄 Refresh (${refreshCost.toLocaleString('en-US')}c)`
                : '🔄 Free Refresh!';

            const buttonRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('merchant_refresh')
                    .setLabel(refreshLabel)
                    .setStyle(user.merchantFreeRefreshUsed ? ButtonStyle.Secondary : ButtonStyle.Success)
                    .setDisabled(user.merchantFreeRefreshUsed && user.coins < refreshCost),
                new ButtonBuilder()
                    .setCustomId('shop_back_to_categories')
                    .setLabel('← Back to Shop')
                    .setStyle(ButtonStyle.Danger)
            );
            components.push(buttonRow);

            return interaction.update({ embeds: [embed], components });
        }

        // Shop Back to Categories Button
        if (interaction.customId === 'shop_back_to_categories') {
            const shopEmbed = new EmbedBuilder()
                .setColor(0x2B2D31)
                .setTitle("🏪 THE TRASH TASTE MARKET")
                .setDescription(`**Welcome back.**\n\nSelect a category below to browse.\n\n💳 **Balance:** \`${user.coins.toLocaleString('en-US')} Coins\``)
                .setThumbnail(client.user.displayAvatarURL())
                .setFooter({ text: "I'll be here... n-not waiting for YOU specifically! (¬_¬)" });

            const row = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('shop_category_selector')
                    .setPlaceholder('🔻 Select a Category')
                    .addOptions(
                        { label: 'Titles', description: 'Flex your degeneracy.', value: 'cat_titles', emoji: '🏷️' },
                        { label: 'Items & Upgrades', description: 'Frames, Shields, Utility.', value: 'cat_items', emoji: '⚔️' },
                        { label: 'Special Services', description: 'Freedom & High Value items. Sugar role = one per season!', value: 'cat_special', emoji: '🔥' },
                        { label: 'Shady Merchant', description: 'Sell your junk for coins!', value: 'cat_merchant', emoji: '🏴‍☠️' }
                    )
            );
            return interaction.update({ embeds: [shopEmbed], components: [row] });
        }

        // Merchant Bulk Modal Submit (MUST be before merchant_bulk_ check due to prefix overlap!)
        if (interaction.customId.startsWith('merchant_bulk_modal_')) {
            const itemName = interaction.customId.replace('merchant_bulk_modal_', '');
            const quantity = parseInt(interaction.fields.getTextInputValue('quantity'));

            if (isNaN(quantity) || quantity < 1 || quantity > 20) {
                return interaction.reply({ content: "Enter a number between 1-20, you idiot! (¬_¬)", ephemeral: true });
            }

            const price = user.merchantPrices?.get(itemName) || SELLABLE_ITEMS[itemName]?.base || 0;
            const ownedCount = user.inventory.filter(i => i === itemName).length;
            const dailyRemaining = Math.max(0, 200000 - user.merchantDailySold);
            const maxSellable = Math.min(ownedCount, Math.floor(dailyRemaining / price), 20);

            if (quantity > maxSellable) {
                return interaction.reply({ content: `You can only sell up to ${maxSellable}! Don't get greedy! (¬_¬)`, ephemeral: true });
            }

            // Atomically remove items from inventory to prevent data loss
            const freshUser = await User.findOne({ userId: interaction.user.id });
            const unsetObj = {};
            let removedCount = 0;
            
            for (let i = 0; i < freshUser.inventory.length; i++) {
                if (freshUser.inventory[i] === itemName) {
                    unsetObj[`inventory.${i}`] = 1;
                    removedCount++;
                    if (removedCount === quantity) break;
                }
            }

            if (Object.keys(unsetObj).length > 0) {
                await User.updateOne({ userId: interaction.user.id }, { $unset: unsetObj });
            }

            const payout = quantity * price;

            // Atomically update inventory and daily limit BEFORE processing payment
            await User.updateOne(
                { userId: interaction.user.id },
                { 
                    $pull: { inventory: null },
                    $inc: { merchantDailySold: payout }
                }
            );

            await distributeIncome(interaction.user.id, payout);
            user = await User.findOne({ userId: interaction.user.id }); // Refresh

            const phrase = SALE_PHRASES[Math.floor(Math.random() * SALE_PHRASES.length)];

            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle("💰 BULK SALE COMPLETE!")
                .setDescription(
                    `**Sold:** ${itemName} x${quantity}\n` +
                    `**Received:** ${payout.toLocaleString('en-US')} coins\n\n` +
                    `*"${phrase}"*\n\n` +
                    `*Use \`!shop\` → Shady Merchant to sell more!*`
                )
                .setThumbnail(client.user.displayAvatarURL());

            // Try to delete the original confirmation message (if accessible via the interaction message reference)
            if (interaction.message) {
                await interaction.message.delete().catch(() => { });
            }

            return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        // Merchant Bulk Sell Modal (button click - shows the modal)
        if (interaction.customId.startsWith('merchant_bulk_')) {
            const itemName = interaction.customId.replace('merchant_bulk_', '');
            const ownedCount = user.inventory.filter(i => i === itemName).length;
            const price = user.merchantPrices?.get(itemName) || SELLABLE_ITEMS[itemName]?.base || 0;
            const dailyRemaining = Math.max(0, 200000 - user.merchantDailySold);
            const maxSellable = Math.min(ownedCount, Math.floor(dailyRemaining / price), 20);

            const modal = new ModalBuilder()
                .setCustomId(`merchant_bulk_modal_${itemName}`)
                .setTitle(`Bulk Sell ${itemName}`);

            const input = new TextInputBuilder()
                .setCustomId('quantity')
                .setLabel(`Quantity (1-${maxSellable})`)
                .setPlaceholder(`You own ${ownedCount}. Max: ${maxSellable} (daily limit)`)
                .setStyle(TextInputStyle.Short)
                .setMinLength(1)
                .setMaxLength(2)
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(input));

            // Show modal first, then delete the confirmation message
            await interaction.showModal(modal);
            // Delete the "SELL CONFIRMATION" message after showing modal
            await interaction.message.delete().catch(() => { });
            return;
        }

        // Merchant Refresh
        if (interaction.customId === 'merchant_refresh') {
            const now = Date.now();
            const oneDayMs = 24 * 60 * 60 * 1000;
            const refreshCost = user.merchantFreeRefreshUsed ? Math.floor(5000 + (user.coins / 30)) : 0;

            // Check if free refresh is available (24h reset)
            const dailyResetTriggered = (now - user.merchantLastRefresh >= oneDayMs);
            if (dailyResetTriggered) {
                user.merchantFreeRefreshUsed = false;
                user.merchantDailySold = 0;
            }

            if (user.merchantFreeRefreshUsed && user.coins < refreshCost) {
                return interaction.reply({ content: `You need ${refreshCost.toLocaleString('en-US')} coins to refresh! Too poor! (¬_¬)`, ephemeral: true });
            }

            const wasFree = !user.merchantFreeRefreshUsed;
            // Deduct cost if not free
            if (user.merchantFreeRefreshUsed) {
                user.coins -= refreshCost;
            } else {
                user.merchantFreeRefreshUsed = true;
            }

            // Re-roll all prices
            user.merchantPrices = new Map();
            for (const [item, config] of Object.entries(SELLABLE_ITEMS)) {
                const mult = config.minMult + Math.random() * (config.maxMult - config.minMult);
                const price = Math.floor(config.base * mult);
                user.merchantPrices.set(item, price);
            }
            user.merchantLastRefresh = now;
            
            const dailyResetFields = dailyResetTriggered ? { merchantDailySold: 0 } : {};
            await User.updateOne(
                { userId: interaction.user.id },
                { 
                    $set: { 
                        merchantPrices: user.merchantPrices, 
                        merchantLastRefresh: user.merchantLastRefresh, 
                        merchantFreeRefreshUsed: user.merchantFreeRefreshUsed,
                        ...dailyResetFields
                    },
                    $inc: { coins: -refreshCost, systemSpent: refreshCost }
                }
            );

            return interaction.reply({
                content: `🔄 **Prices Refreshed!** ${wasFree ? '*(Free!)*' : `(-${refreshCost.toLocaleString('en-US')}c)`}\n\n*"Prices changed! D-Don't blame me if they're worse now!"*\n\nUse \`!shop\` → Shady Merchant to see new prices!`,
                ephemeral: true
            });
        }
    }, // <--- ⚠️ ADD THIS COMMA!! IMPORTANT!!

    // --- DAILY TAX LOGIC (Added here as a property) ---
    checkAndApplyDailyTax: async (client) => {
        try {
            const now = Date.now();
            const oneDay = 24 * 60 * 60 * 1000;
            let processedGuilds = 0;
            let totalTaxedUsers = 0;

            for (const guild of client.guilds.cache.values()) {
                const stats = await ServerStats.findOne({ guildId: guild.id }).select('lastDailyTax').lean();
                const lastDailyTax = stats ? (stats.lastDailyTax || 0) : 0;
                
                if (now - lastDailyTax < oneDay) continue;
                processedGuilds++;

                const members = await guild.members.fetch().catch(() => null);
                if (!members) continue;

                const guildUserIds = [...members.values()]
                    .filter(member => !member.user.bot)
                    .map(member => member.id);
                if (guildUserIds.length === 0) continue;

                // Find users in this guild with 100k+ coins (eligible for tax)
                const richUsers = await User.find({ userId: { $in: guildUserIds }, coins: { $gte: 100000 } }).sort({ coins: -1 });
                if (richUsers.length === 0) {
                    await ServerStats.updateOne(
                        { guildId: guild.id },
                        { $set: { lastDailyTax: now } },
                        { upsert: true }
                    );
                    continue;
                }

                // Tax them (tiered rates based on wealth)
                let msg = "Tch. Look at you... sitting on mountains of gold while the rest of the server starves. It makes me sick.\n\n" +
                    "**Time for your daily contribution to society!**\n\n";
                let taxedCount = 0;
                let totalTaxCollected = 0;

                for (const u of richUsers) {
                    // EXEMPTIONS:
                    // 1. Slaves (They already pay tax to masters)
                    if (u.isSlave) continue;

                    // 2. Debtors (They need to repay loans)
                    const hasActiveLoan = await Loan.exists({ borrowerId: u.userId, status: 'ACTIVE' });
                    if (hasActiveLoan) continue;

                    let taxRate;
                    if (u.coins >= 1000000) {
                        taxRate = 0.30;
                    } else if (u.coins >= 500000) {
                        taxRate = 0.20;
                    } else {
                        taxRate = 0.10;
                    }

                    const tax = Math.floor(u.coins * taxRate);

                    // ATOMIC UPDATE: Prevent VersionError if user spends/gains coins concurrently
                    await User.updateOne({ _id: u._id }, { $inc: { coins: -tax, systemSpent: tax } });

                    const member = members.get(u.userId);
                    const name = member ? member.displayName : "Unknown";
                    msg += `🔴 **${name}**: -${tax.toLocaleString('en-US')} coins\n`;
                    taxedCount++;
                    totalTaxCollected += tax;
                }
                totalTaxedUsers += taxedCount;

                // ATOMIC UPDATE: add the accumulated tax and set the timestamp in one operation
                const updateOps = { $set: { lastDailyTax: now } };
                if (totalTaxCollected > 0) {
                    updateOps.$inc = { weeklyCoinCount: totalTaxCollected };
                }

                await ServerStats.updateOne(
                    { guildId: guild.id },
                    updateOps,
                    { upsert: true }
                );

                if (taxedCount > 0) {
                    const channel = guild.channels.cache.find(c => [config.CHANNELS.MAIN, config.CHANNELS.ALT].includes(c.name));
                    if (channel) await channel.send(msg);
                }
            }

            if (processedGuilds > 0) {
                console.log(`✅ Daily Tax Executed. Guilds: ${processedGuilds}, Taxed Users: ${totalTaxedUsers}`);
            }

        } catch (e) {
            console.error("Tax Error:", e);
        }
    }

}; // <--- NOW the file ends here

