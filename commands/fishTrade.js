const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');
const crypto = require('crypto');
const User = require('../models/User');
const { getDisplayName } = require('../utils/helpers');
const config = require('../config');

// Shared logic from fishing.js
function fishFingerprint(fish) {
    return crypto
        .createHash('sha1')
        .update(`${fish.species || ''}|${fish.weight || 0}|${fish.rarity || ''}|${fish.value || 0}`)
        .digest('hex')
        .slice(0, 12);
}

// Active trade sessions: Map<tradeId, FishTradeSession>
const activeFishTrades = new Map();
// Timer intervals for periodic refresh: Map<tradeId, intervalId>
const fishTradeTimers = new Map();
// Setup lock
const fishTradeSetupLocks = new Set();

class FishTradeSession {
    constructor(initiatorId, targetId, channelId, messageId) {
        this.id = `fishtrade_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        this.initiatorId = initiatorId;
        this.targetId = targetId;
        this.channelId = channelId;
        this.messageId = messageId;
        this.initiatorOffer = []; // Array of fingerprints
        this.targetOffer = []; 
        this.initiatorFishObjs = []; // To cache details
        this.targetFishObjs = [];
        this.initiatorConfirmed = false;
        this.targetConfirmed = false;
        this.status = 'SELECTING'; // SELECTING, CONFIRMING, COUNTDOWN, COMPLETED, CANCELLED
        this.createdAt = Date.now();
        this.expiresAt = Date.now() + 180000; // 3 minutes
        this.initiatorName = null;
        this.targetName = null;
    }
}

// Value estimator
function calculateOfferValue(fishObjs) {
    let val = fishObjs.reduce((sum, f) => sum + (f.value || 0), 0);
    return val;
}

function formatValue(value) {
    if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
    if (value >= 1000) return `${(value / 1000).toFixed(0)}K`;
    return value.toString();
}

function getTradeBalanceWarning(initiatorValue, targetValue) {
    if (initiatorValue === 0 && targetValue === 0) return null;
    if (initiatorValue === 0 || targetValue === 0) return { level: 'CAUTION', message: '⚡ *One-sided trade detected.*' };

    const ratio = Math.max(initiatorValue, targetValue) / Math.min(initiatorValue, targetValue);

    if (ratio >= 5) return { level: 'DANGER', message: '🚨 **EXTREMELY UNBALANCED!** One side is 5x+ more valuable!' };
    if (ratio >= 3) return { level: 'WARNING', message: '⚠️ **UNBALANCED TRADE!** One side is 3x+ more valuable.' };
    if (ratio >= 2) return { level: 'CAUTION', message: '⚡ *Slightly uneven trade - one side is ~2x more valuable.*' };
    return null;
}

function formatItemsCompact(fishObjs) {
    let lines = [];
    if (fishObjs.length > 0) {
        for (const f of fishObjs) {
            const emoji = config.FISHING.EMOJIS[f.rarity] || '🐟';
            lines.push(`${emoji} ${f.species} (${f.weight}kg)`);
        }
    }
    if (lines.length === 0) return '*(empty)*';
    return lines.join('\n');
}

function buildTradeEmbed(trade) {
    const timeLeft = Math.max(0, Math.ceil((trade.expiresAt - Date.now()) / 1000));
    const minutes = Math.floor(timeLeft / 60);
    const seconds = timeLeft % 60;

    const getStatus = (hasItems, confirmed) => {
        if (confirmed) return '✅ LOCKED IN';
        if (hasItems) return '📦 Ready';
        return '⏳ Selecting...';
    };

    const initiatorStatus = getStatus(trade.initiatorOffer.length > 0, trade.initiatorConfirmed);
    const targetStatus = getStatus(trade.targetOffer.length > 0, trade.targetConfirmed);

    const initiatorValue = calculateOfferValue(trade.initiatorFishObjs);
    const targetValue = calculateOfferValue(trade.targetFishObjs);
    const balanceWarning = getTradeBalanceWarning(initiatorValue, targetValue);

    let description = '';
    if (trade.status === 'COUNTDOWN') description = '```diff\n+ TRADE EXECUTING...\n```';
    else if (trade.status === 'COMPLETED') description = '```diff\n+ TRADE COMPLETED!\n```';
    else if (trade.status === 'CANCELLED') description = '```diff\n- TRADE CANCELLED\n```';
    else {
        description = `\`\`\`\n⏰ Time Remaining: ${minutes}:${seconds.toString().padStart(2, '0')}\n\`\`\``;
        if (balanceWarning) description += `\n${balanceWarning.message}\n`;
        description += `\n*Both traders must select items and confirm!*`;
    }

    const initValStr = initiatorValue > 0 ? `💰 ~${formatValue(initiatorValue)}` : '';
    const tgtValStr = targetValue > 0 ? `💰 ~${formatValue(targetValue)}` : '';

    return new EmbedBuilder()
        .setColor(trade.status === 'COMPLETED' ? 0x00FF00 : (trade.status === 'CANCELLED' ? 0xFF0000 : (balanceWarning?.level === 'DANGER' ? 0xFF6600 : 0x00A86B)))
        .setTitle('🎣 ═══ FISH TRADE SESSION ═══ 🎣')
        .setDescription(description)
        .addFields(
            {
                name: `╔${'═'.repeat(18)}╗\n║ 👤 ${trade.initiatorName}`,
                value: `║ ${initiatorStatus}\n${initValStr ? `║ ${initValStr}\n` : ''}╠${'═'.repeat(18)}╣\n${formatItemsCompact(trade.initiatorFishObjs)}\n╚${'═'.repeat(18)}╝`,
                inline: true
            },
            { name: '⇄', value: '\u200B', inline: true },
            {
                name: `╔${'═'.repeat(18)}╗\n║ 👤 ${trade.targetName}`,
                value: `║ ${targetStatus}\n${tgtValStr ? `║ ${tgtValStr}\n` : ''}╠${'═'.repeat(18)}╣\n${formatItemsCompact(trade.targetFishObjs)}\n╚${'═'.repeat(18)}╝`,
                inline: true
            }
        )
        .setFooter({ text: '🗑️ Clear = Reset your offer • 🔒 Lock In = Confirm trade' });
}

function buildTradeButtons(trade) {
    if (trade.status === 'COUNTDOWN') {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`fishtrade_emergency_${trade.id}`).setLabel('🚨 EMERGENCY CANCEL').setStyle(ButtonStyle.Danger)
        );
    }
    if (trade.status === 'COMPLETED' || trade.status === 'CANCELLED') return null;

    const initLabel = trade.initiatorName.length > 8 ? trade.initiatorName.slice(0, 8) + '…' : trade.initiatorName;
    const tgtLabel = trade.targetName.length > 8 ? trade.targetName.slice(0, 8) + '…' : trade.targetName;

    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`fishtrade_select_${trade.id}_initiator`).setLabel(`🐟 ${initLabel}`).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`fishtrade_select_${trade.id}_target`).setLabel(`🐟 ${tgtLabel}`).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`fishtrade_clear_${trade.id}`).setLabel('🗑️ Clear').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`fishtrade_lock_${trade.id}`).setLabel('🔒 Lock In').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`fishtrade_cancel_${trade.id}`).setLabel('❌').setStyle(ButtonStyle.Danger)
    );
}

function buildConfirmationEmbed(trade, forUserId) {
    const isInitiator = forUserId === trade.initiatorId;
    const yourObjs = isInitiator ? trade.initiatorFishObjs : trade.targetFishObjs;
    const theirObjs = isInitiator ? trade.targetFishObjs : trade.initiatorFishObjs;
    const theirName = isInitiator ? trade.targetName : trade.initiatorName;

    const yourValue = calculateOfferValue(yourObjs);
    const theirValue = calculateOfferValue(theirObjs);
    const balanceWarning = getTradeBalanceWarning(yourValue, theirValue);

    let description = '**Review carefully before locking in!**';
    if (balanceWarning) description += `\n\n${balanceWarning.message}`;

    return new EmbedBuilder()
        .setColor(balanceWarning?.level === 'DANGER' ? 0xFF0000 : (balanceWarning?.level === 'WARNING' ? 0xFF6600 : 0xFFD700))
        .setTitle('⚠️ CONFIRM YOUR FISH TRADE')
        .setDescription(description)
        .addFields(
            { name: `📤 YOU GIVE (~${formatValue(yourValue)}):`, value: formatItemsCompact(yourObjs), inline: true },
            { name: `📥 YOU GET (~${formatValue(theirValue)}):`, value: formatItemsCompact(theirObjs), inline: true }
        )
        .setFooter({ text: `Trading with ${theirName} • Values are estimated` });
}

function startTradeTimer(trade, client) {
    if (fishTradeTimers.has(trade.id)) clearInterval(fishTradeTimers.get(trade.id));

    const intervalId = setInterval(async () => {
        const currentTrade = activeFishTrades.get(trade.id);
        if (!currentTrade || currentTrade.status !== 'SELECTING') {
            clearInterval(intervalId);
            fishTradeTimers.delete(trade.id);
            return;
        }

        if (Date.now() >= currentTrade.expiresAt) {
            currentTrade.status = 'CANCELLED';
            activeFishTrades.delete(trade.id);
            clearInterval(intervalId);
            fishTradeTimers.delete(trade.id);
            try {
                const channel = await client.channels.fetch(currentTrade.channelId);
                const msg = await channel.messages.fetch(currentTrade.messageId);
                const expiredEmbed = new EmbedBuilder().setColor(0xFF0000).setTitle('⏰ TRADE EXPIRED').setDescription("```diff\n- Trade expired! Too slow!\n```\n*Tch! You wasted everyone's time! (¬_¬)*");
                await msg.edit({ embeds: [expiredEmbed], components: [] });
            } catch (e) { }
            return;
        }

        try {
            const channel = await client.channels.fetch(currentTrade.channelId);
            const msg = await channel.messages.fetch(currentTrade.messageId);
            await msg.edit({ embeds: [buildTradeEmbed(currentTrade)], components: buildTradeButtons(currentTrade) ? [buildTradeButtons(currentTrade)] : [] });
        } catch (e) { }
    }, 10000);

    fishTradeTimers.set(trade.id, intervalId);
}

function stopTradeTimer(tradeId) {
    if (fishTradeTimers.has(tradeId)) {
        clearInterval(fishTradeTimers.get(tradeId));
        fishTradeTimers.delete(tradeId);
    }
}

async function updateTradeMessage(trade, client) {
    try {
        const channel = await client.channels.fetch(trade.channelId);
        const msg = await channel.messages.fetch(trade.messageId);
        await msg.edit({ embeds: [buildTradeEmbed(trade)], components: buildTradeButtons(trade) ? [buildTradeButtons(trade)] : [] });
    } catch (e) { }
}

async function notifyOtherTrader(trade, actorId, action, client) {
    try {
        const channel = await client.channels.fetch(trade.channelId);
        const otherUserId = actorId === trade.initiatorId ? trade.targetId : trade.initiatorId;
        const actorName = actorId === trade.initiatorId ? trade.initiatorName : trade.targetName;
        const notification = await channel.send({ content: `<@${otherUserId}> 📢 **${actorName}** ${action}! Check the trade panel above.` });
        setTimeout(() => { notification.delete().catch(() => {}); }, 5000);
    } catch (e) {}
}

module.exports = {
    handle: async (context, client, initiatorUser) => {
        try {
            const isInteraction = !!context.customId;
            const message = isInteraction ? context.message : context;
            const authorId = isInteraction ? context.user.id : context.author.id;
            
            let target;
            if (!isInteraction) {
                target = message.mentions.users.first();
            }

            const replyMsg = async (opts) => {
                if (isInteraction) {
                    opts.content = opts.content ? `<@${authorId}> ${opts.content}` : `<@${authorId}>`;
                    return await context.channel.send(opts);
                } else return await message.reply(opts);
            };

            if (!target) return replyMsg({ content: "B-Baka! Tag someone to trade with! `!fish trade @user` (or `!fih`) (¬_¬)" });
            if (target.id === authorId) return replyMsg({ content: "You can't trade with yourself, you lonely idiot! >///< " });
            if (target.bot) return replyMsg({ content: "I-I don't trade with bots! They have no taste! (¬_¬)" });

            const lockIds = [authorId, target.id];
            if (lockIds.some((id) => fishTradeSetupLocks.has(id))) return replyMsg({ content: "A trade setup is already in progress for one of you. Wait a second. (¬_¬)" });
            lockIds.forEach((id) => fishTradeSetupLocks.add(id));

            try {
                let targetUser = await User.findOne({ userId: target.id });
                if (!targetUser) targetUser = await User.create({ userId: target.id });

                if (initiatorUser.botBanExpiry && initiatorUser.botBanExpiry > Date.now()) return replyMsg({ content: "You're banned from the bot, criminal! No trading for you! 😤" });
                if (targetUser.botBanExpiry && targetUser.botBanExpiry > Date.now()) return replyMsg({ content: "They're banned from the bot! Find someone else to scam! (¬_¬)" });
                if (initiatorUser.isSlave) return replyMsg({ content: "S-Slaves can't initiate trades! Know your place! >///< " });

                for (const [id, trade] of activeFishTrades) {
                    if (trade.initiatorId === authorId || trade.targetId === authorId) return replyMsg({ content: "You're already in a trade session! Finish or cancel that one first! (¬_¬)" });
                    if (trade.initiatorId === target.id || trade.targetId === target.id) return replyMsg({ content: "They're already in a trade session! Wait your turn! (¬_¬)" });
                }

                const initiatorName = await getDisplayName(authorId, message.guild);
                const targetName = await getDisplayName(target.id, message.guild);

                const tempTrade = new FishTradeSession(authorId, target.id, message.channel.id, null);
                tempTrade.initiatorName = initiatorName;
                tempTrade.targetName = targetName;

                const tradeMsg = await replyMsg({
                    content: `<@${target.id}>, **${initiatorName}** wants to trade fish with you!\n\n*Click your name button to select your locked fishes!*`,
                    embeds: [buildTradeEmbed(tempTrade)],
                    components: [buildTradeButtons(tempTrade)]
                });

                tempTrade.messageId = tradeMsg.id;
                activeFishTrades.set(tempTrade.id, tempTrade);
                startTradeTimer(tempTrade, client);
            } finally {
                lockIds.forEach((id) => fishTradeSetupLocks.delete(id));
            }
        } catch (error) {
            console.error('Fish Trade Handle Error:', error);
            const isInteraction = !!context.customId;
            const authorId = isInteraction ? context.user.id : context.author.id;
            const content = `<@${authorId}> S-Something broke while trying to trade! >///<`;
            if (isInteraction) {
                await context.channel.send({ content }).catch(() => {});
            } else {
                await context.reply({ content }).catch(() => {});
            }
        }
    },

    handleInteraction: async (interaction, client) => {
        try {
            const customId = interaction.customId;
            if (!customId?.startsWith('fishtrade_')) return;

        // ═══════════════════════════════════════════════════════════════
        // SELECT BUTTON (SHOW DROPDOWN / NUGGET BUTTON)
        // ═══════════════════════════════════════════════════════════════
        if (customId.startsWith('fishtrade_select_') && !customId.includes('_items_') && !customId.includes('_nuggets_') && !customId.includes('_qty_')) {
            const parts = customId.split('_');
            const role = parts[parts.length - 1]; // initiator or target
            const tradeId = parts.slice(2, -1).join('_');
            const trade = activeFishTrades.get(tradeId);

            if (!trade || trade.status !== 'SELECTING') return interaction.reply({ content: "This trade is no longer active!", ephemeral: true });
            
            const allowedUserId = role === 'initiator' ? trade.initiatorId : trade.targetId;
            if (interaction.user.id !== allowedUserId) return interaction.reply({ content: "❌ **That's not your button, idiot!**\n\nClick the one with YOUR name! Stop touching things that don't belong to you! >///<", ephemeral: true });

            const user = await User.findOne({ userId: interaction.user.id }).lean();
            const lockedFishes = (user.fishing?.inventory || []).filter(f => f.locked === true);
            if (lockedFishes.length === 0) {
                return interaction.reply({ content: "You have no locked fishes to trade! Pin and lock your fishes in `!fish bag` (or `!fih bag`) first! >///< ", ephemeral: true });
            }

            const currentOffer = role === 'initiator' ? trade.initiatorOffer : trade.targetOffer;

            const allOptions = [];
            const counts = {};
            for (const f of lockedFishes) {
                const fp = fishFingerprint(f);
                counts[fp] = (counts[fp] || 0) + 1;
                const uniqueFp = `${fp}_${counts[fp]}`;
                const emoji = config.FISHING.EMOJIS[f.rarity] || '🐟';
                allOptions.push({
                    label: `${f.species} (${f.weight}kg) - 💰${f.value}`,
                    value: uniqueFp,
                    emoji: emoji,
                    description: `Rarity: ${f.rarity}`
                });
            }

            const selectionRows = [];

            if (allOptions.length > 0) {
                // Take first 25 options
                const displayOptions = allOptions.slice(0, 25);
                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId(`fishtrade_items_${trade.id}`)
                    .setPlaceholder(allOptions.length > 25 ? `Select up to 25 fish (Showing 25/${allOptions.length})...` : 'Select fish to offer...')
                    .setMinValues(1)
                    .setMaxValues(displayOptions.length)
                    .addOptions(displayOptions);

                // Set default selections
                for (const option of displayOptions) {
                    if (currentOffer.includes(option.value)) option.default = true;
                }

                selectionRows.push(new ActionRowBuilder().addComponents(selectMenu));
            }

            return interaction.reply({
                content: `**Select your locked fishes to offer:**\n*(Only the first 25 locked fishes are shown. Don't take too long! (¬_¬))*`,
                components: selectionRows,
                ephemeral: true
            });
        }

        // ═══════════════════════════════════════════════════════════════
        // FISH SELECTION
        // ═══════════════════════════════════════════════════════════════
        if (customId.startsWith('fishtrade_items_')) {
            const tradeId = customId.replace('fishtrade_items_', '');
            const trade = activeFishTrades.get(tradeId);

            if (!trade || trade.status !== 'SELECTING') return interaction.reply({ content: "This trade session is no longer active!", ephemeral: true });
            
            const userId = interaction.user.id;
            if (userId !== trade.initiatorId && userId !== trade.targetId) return interaction.reply({ content: "This isn't your trade! Mind your own business! (¬_¬)", ephemeral: true });

            const selectedFps = interaction.values;
            const user = await User.findOne({ userId }).lean();
            const lockedFishes = (user.fishing?.inventory || []).filter(f => f.locked === true);

            // Verify they still have these and cache them
            const validFishes = [];
            const validFps = [];
            const counts = {};
            for (const f of lockedFishes) {
                const fp = fishFingerprint(f);
                counts[fp] = (counts[fp] || 0) + 1;
                const uniqueFp = `${fp}_${counts[fp]}`;
                if (selectedFps.includes(uniqueFp)) {
                    validFishes.push(f);
                    validFps.push(uniqueFp);
                }
            }

            if (userId === trade.initiatorId) {
                trade.initiatorOffer = validFps;
                trade.initiatorFishObjs = validFishes;
                trade.initiatorConfirmed = false;
            } else {
                trade.targetOffer = validFps;
                trade.targetFishObjs = validFishes;
                trade.targetConfirmed = false;
            }

            await updateTradeMessage(trade, client);
            await notifyOtherTrader(trade, userId, 'updated their offer', client);

            return interaction.update({
                content: `✅ **Fishes updated!**\n\n*Check the main trade panel. Click 🔒 Lock In when ready!*`,
                components: []
            });
        }


        // ═══════════════════════════════════════════════════════════════
        // CLEAR BUTTON
        // ═══════════════════════════════════════════════════════════════
        if (customId.startsWith('fishtrade_clear_')) {
            const tradeId = customId.replace('fishtrade_clear_', '');
            const trade = activeFishTrades.get(tradeId);

            if (!trade || trade.status !== 'SELECTING') return interaction.reply({ content: "This trade is no longer active!", ephemeral: true });
            
            const userId = interaction.user.id;
            if (userId !== trade.initiatorId && userId !== trade.targetId) return interaction.reply({ content: "This isn't your trade!", ephemeral: true });

            if (userId === trade.initiatorId) {
                trade.initiatorOffer = [];
                trade.initiatorFishObjs = [];
                trade.initiatorConfirmed = false;
            } else {
                trade.targetOffer = [];
                trade.targetFishObjs = [];
                trade.targetConfirmed = false;
            }

            await interaction.reply({ content: "🗑️ **Your offer has been cleared!** Make up your mind already! (¬_¬)", ephemeral: true });
            await updateTradeMessage(trade, client);
            await notifyOtherTrader(trade, userId, 'cleared their offer', client);
        }

        // ═══════════════════════════════════════════════════════════════
        // LOCK IN BUTTON
        // ═══════════════════════════════════════════════════════════════
        if (customId.startsWith('fishtrade_lock_')) {
            const tradeId = customId.replace('fishtrade_lock_', '');
            const trade = activeFishTrades.get(tradeId);

            if (!trade || trade.status !== 'SELECTING') return interaction.reply({ content: "This trade is no longer active!", ephemeral: true });
            
            const userId = interaction.user.id;
            if (userId !== trade.initiatorId && userId !== trade.targetId) return interaction.reply({ content: "This isn't your trade!", ephemeral: true });

            const isInitiator = userId === trade.initiatorId;
            if (isInitiator && trade.initiatorConfirmed) return interaction.reply({ content: "You're already locked in, baka! (¬_¬)", ephemeral: true });
            if (!isInitiator && trade.targetConfirmed) return interaction.reply({ content: "You're already locked in, baka! (¬_¬)", ephemeral: true });

            const confirmEmbed = buildConfirmationEmbed(trade, userId);
            const confirmRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`fishtrade_confirm_${trade.id}`).setLabel('✅ CONFIRM AND LOCK').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`fishtrade_back_${trade.id}`).setLabel('↩️ Go Back').setStyle(ButtonStyle.Secondary)
            );

            await interaction.reply({ embeds: [confirmEmbed], components: [confirmRow], ephemeral: true });
        }

        // ═══════════════════════════════════════════════════════════════
        // GO BACK BUTTON
        // ═══════════════════════════════════════════════════════════════
        if (customId.startsWith('fishtrade_back_')) {
            return interaction.update({ content: "*Trade confirmation cancelled. You can modify your selection or try again.*", embeds: [], components: [] });
        }

        // ═══════════════════════════════════════════════════════════════
        // CONFIRM BUTTON
        // ═══════════════════════════════════════════════════════════════
        if (customId.startsWith('fishtrade_confirm_')) {
            const tradeId = customId.replace('fishtrade_confirm_', '');
            const trade = activeFishTrades.get(tradeId);

            if (!trade || trade.status !== 'SELECTING') return interaction.reply({ content: "This trade is no longer active!", ephemeral: true });
            
            const userId = interaction.user.id;
            if (userId !== trade.initiatorId && userId !== trade.targetId) return interaction.reply({ content: "This isn't your trade!", ephemeral: true });

            if (userId === trade.initiatorId) trade.initiatorConfirmed = true;
            else trade.targetConfirmed = true;

            await interaction.update({ content: "✅ **You've locked in your trade!**\n\n*Waiting for the other slowpoke to confirm... (¬_¬)*", embeds: [], components: [] });
            await updateTradeMessage(trade, client);
            await notifyOtherTrader(trade, userId, 'has LOCKED IN', client);

            if (trade.initiatorConfirmed && trade.targetConfirmed) {
                if (trade.status !== 'SELECTING') return;
                
                trade.status = 'COUNTDOWN';
                stopTradeTimer(trade.id);

                const cancelRow = buildTradeButtons(trade);

                for (let i = 5; i >= 1; i--) {
                    const currentTrade = activeFishTrades.get(tradeId);
                    if (!currentTrade || currentTrade.status === 'CANCELLED') return;

                    try {
                        const channel = await client.channels.fetch(trade.channelId);
                        const msg = await channel.messages.fetch(trade.messageId);

                        const countdownEmbed = new EmbedBuilder()
                            .setColor(0xFFD700)
                            .setTitle('⏳ FINALIZING FISH TRADE...')
                            .setDescription(`\`\`\`diff\n+ Executing in ${i}...\n\`\`\`\n**⚠️ Click EMERGENCY CANCEL to abort!**`)
                            .addFields(
                                { name: `📤 ${trade.initiatorName} gives:`, value: formatItemsCompact(trade.initiatorFishObjs), inline: true },
                                { name: '⇄', value: '\u200B', inline: true },
                                { name: `📤 ${trade.targetName} gives:`, value: formatItemsCompact(trade.targetFishObjs), inline: true }
                            );

                        await msg.edit({ embeds: [countdownEmbed], components: cancelRow ? [cancelRow] : [] });
                    } catch (e) { }

                    await new Promise(r => setTimeout(r, 1000));
                }

                const currentTrade = activeFishTrades.get(tradeId);
                if (!currentTrade || currentTrade.status === 'CANCELLED') return;

                const initiator = await User.findOne({ userId: trade.initiatorId }).lean();
                const target = await User.findOne({ userId: trade.targetId }).lean();

                // Validate initiator items
                let initFailed = false;
                const initLocked = (initiator.fishing?.inventory || []).filter(f => f.locked === true);
                const initCounts = {};
                for (const val of trade.initiatorOffer) {
                    const fp = val.split('_')[0];
                    initCounts[fp] = (initCounts[fp] || 0) + 1;
                }
                for (const [fp, count] of Object.entries(initCounts)) {
                    if (initLocked.filter(f => fishFingerprint(f) === fp).length < count) initFailed = true;
                }

                // Validate target items
                let tgtFailed = false;
                const tgtLocked = (target.fishing?.inventory || []).filter(f => f.locked === true);
                const tgtCounts = {};
                for (const val of trade.targetOffer) {
                    const fp = val.split('_')[0];
                    tgtCounts[fp] = (tgtCounts[fp] || 0) + 1;
                }
                for (const [fp, count] of Object.entries(tgtCounts)) {
                    if (tgtLocked.filter(f => fishFingerprint(f) === fp).length < count) tgtFailed = true;
                }

                if (initFailed || tgtFailed) {
                    trade.status = 'CANCELLED';
                    activeFishTrades.delete(tradeId);
                    const failEmbed = new EmbedBuilder()
                        .setColor(0xFF0000)
                        .setTitle('❌ TRADE FAILED')
                        .setDescription(`\`\`\`diff\n- Someone no longer has the items!\n\`\`\`\n*S-Scammer! (¬_¬)*`);

                    try {
                        const channel = await client.channels.fetch(trade.channelId);
                        const msg = await channel.messages.fetch(trade.messageId);
                        await msg.edit({ embeds: [failEmbed], components: [] });
                    } catch(e) {}
                    return;
                }

                // Execute!
                const successfullyRemovedFromInitiator = [];
                const successfullyRemovedFromTarget = [];
                let transactionFailed = false;

                // Remove from initiator
                if (trade.initiatorOffer.length > 0) {
                    const tempUser = await User.findOne({ userId: trade.initiatorId }).lean();
                    const currentInv = [...(tempUser.fishing?.inventory || [])];
                    const unsetObj = {};
                    const matchConditions = { userId: trade.initiatorId };
                    const pendingRemoval = [];
                    
                    for (const val of trade.initiatorOffer) {
                        const fp = val.split('_')[0];
                        const idx = currentInv.findIndex(f => f && fishFingerprint(f) === fp && f.locked === true);
                        if (idx !== -1) {
                            unsetObj[`fishing.inventory.${idx}`] = 1;
                            const matchedFish = currentInv[idx];
                            Object.assign(matchConditions, {
                                [`fishing.inventory.${idx}.species`]: matchedFish.species,
                                [`fishing.inventory.${idx}.weight`]: matchedFish.weight,
                                [`fishing.inventory.${idx}.rarity`]: matchedFish.rarity,
                                [`fishing.inventory.${idx}.value`]: matchedFish.value
                            });
                            pendingRemoval.push(matchedFish);
                            currentInv[idx] = null;
                        } else {
                            transactionFailed = true;
                            break;
                        }
                    }

                    if (!transactionFailed) {
                        const updateRes = await User.updateOne(matchConditions, { $unset: unsetObj });
                        if (updateRes.modifiedCount > 0) {
                            successfullyRemovedFromInitiator.push(...pendingRemoval);
                            await User.updateOne({ userId: trade.initiatorId }, { $pull: { 'fishing.inventory': null } });
                        } else transactionFailed = true;
                    }
                }

                // Rollback if fail
                if (transactionFailed) {
                    if (successfullyRemovedFromInitiator.length > 0) {
                        await User.findOneAndUpdate({ userId: trade.initiatorId }, { $push: { 'fishing.inventory': { $each: successfullyRemovedFromInitiator } } });
                    }
                    trade.status = 'CANCELLED';
                    activeFishTrades.delete(tradeId);
                    
                    const failEmbed = new EmbedBuilder()
                        .setColor(0xFF0000)
                        .setTitle('❌ TRADE FAILED')
                        .setDescription(`\`\`\`diff\n- Transaction Fault! ${trade.initiatorName}'s inventory shifted during execution!\n\`\`\`\n*A-Are you trying to exploit me?! (¬_¬)*`);

                    try {
                        const channel = await client.channels.fetch(trade.channelId);
                        const msg = await channel.messages.fetch(trade.messageId);
                        await msg.edit({ embeds: [failEmbed], components: [] });
                    } catch(e) {}
                    return;
                }

                // Remove from target
                if (trade.targetOffer.length > 0) {
                    const tempUser = await User.findOne({ userId: trade.targetId }).lean();
                    const currentInv = [...(tempUser.fishing?.inventory || [])];
                    const unsetObj = {};
                    const matchConditions = { userId: trade.targetId };
                    const pendingRemoval = [];
                    
                    for (const val of trade.targetOffer) {
                        const fp = val.split('_')[0];
                        const idx = currentInv.findIndex(f => f && fishFingerprint(f) === fp && f.locked === true);
                        if (idx !== -1) {
                            unsetObj[`fishing.inventory.${idx}`] = 1;
                            const matchedFish = currentInv[idx];
                            Object.assign(matchConditions, {
                                [`fishing.inventory.${idx}.species`]: matchedFish.species,
                                [`fishing.inventory.${idx}.weight`]: matchedFish.weight,
                                [`fishing.inventory.${idx}.rarity`]: matchedFish.rarity,
                                [`fishing.inventory.${idx}.value`]: matchedFish.value
                            });
                            pendingRemoval.push(matchedFish);
                            currentInv[idx] = null;
                        } else {
                            transactionFailed = true;
                            break;
                        }
                    }

                    if (!transactionFailed) {
                        const updateRes = await User.updateOne(matchConditions, { $unset: unsetObj });
                        if (updateRes.modifiedCount > 0) {
                            successfullyRemovedFromTarget.push(...pendingRemoval);
                            await User.updateOne({ userId: trade.targetId }, { $pull: { 'fishing.inventory': null } });
                        } else transactionFailed = true;
                    }
                }

                // Rollback both if target fails
                if (transactionFailed) {
                    if (successfullyRemovedFromInitiator.length > 0) {
                        await User.findOneAndUpdate({ userId: trade.initiatorId }, { $push: { 'fishing.inventory': { $each: successfullyRemovedFromInitiator } } });
                    }
                    if (successfullyRemovedFromTarget.length > 0) {
                        await User.findOneAndUpdate({ userId: trade.targetId }, { $push: { 'fishing.inventory': { $each: successfullyRemovedFromTarget } } });
                    }
                    trade.status = 'CANCELLED';
                    activeFishTrades.delete(tradeId);
                    
                    const failEmbed = new EmbedBuilder()
                        .setColor(0xFF0000)
                        .setTitle('❌ TRADE FAILED')
                        .setDescription(`\`\`\`diff\n- Transaction Fault! ${trade.targetName}'s inventory shifted during execution!\n\`\`\`\n*A-Are you trying to exploit me?! (¬_¬)*`);

                    try {
                        const channel = await client.channels.fetch(trade.channelId);
                        const msg = await channel.messages.fetch(trade.messageId);
                        await msg.edit({ embeds: [failEmbed], components: [] });
                    } catch(e) {}
                    return;
                }

                // SUCCESS! 
                // Unlock and remove from pinned arrays if present
                const unlockAndUnpin = (arr) => arr.map(f => {
                    f.locked = false;
                    return f;
                });

                const finalInitObjs = unlockAndUnpin(successfullyRemovedFromTarget);
                const finalTgtObjs = unlockAndUnpin(successfullyRemovedFromInitiator);

                // Transfer fishes
                if (finalInitObjs.length > 0) {
                    await User.findOneAndUpdate({ userId: trade.initiatorId }, { $push: { 'fishing.inventory': { $each: finalInitObjs } } });
                }
                if (finalTgtObjs.length > 0) {
                    await User.findOneAndUpdate({ userId: trade.targetId }, { $push: { 'fishing.inventory': { $each: finalTgtObjs } } });
                }

                // Unpin logic: The sender's pinned list might contain fingerprints we just transferred away.
                // Pull from initiator's pinned array using the fingerprints of what they gave away.
                if (trade.initiatorOffer.length > 0) {
                    const rawFps = trade.initiatorOffer.map(val => val.split('_')[0]);
                    await User.updateOne({ userId: trade.initiatorId }, { $pull: { 'fishing.pinned': { $in: rawFps } } });
                }
                if (trade.targetOffer.length > 0) {
                    const rawFps = trade.targetOffer.map(val => val.split('_')[0]);
                    await User.updateOne({ userId: trade.targetId }, { $pull: { 'fishing.pinned': { $in: rawFps } } });
                }



                trade.status = 'COMPLETED';
                activeFishTrades.delete(tradeId);

                const initiatorValue = calculateOfferValue(trade.initiatorFishObjs);
                const targetValue = calculateOfferValue(trade.targetFishObjs);

                const successEmbed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setTitle('✅ TRADE COMPLETED!')
                    .setDescription('```diff\n+ Fish have been exchanged!\n```')
                    .addFields(
                        { name: `📥 ${trade.initiatorName} received (~${formatValue(targetValue)}):`, value: formatItemsCompact(trade.targetFishObjs), inline: true },
                        { name: '⇄', value: '\u200B', inline: true },
                        { name: `📥 ${trade.targetName} received (~${formatValue(initiatorValue)}):`, value: formatItemsCompact(trade.initiatorFishObjs), inline: true }
                    )
                    .setFooter({ text: "H-Hmph! Take care of them! >///< " });

                try {
                    const channel = await client.channels.fetch(trade.channelId);
                    const msg = await channel.messages.fetch(trade.messageId);
                    await msg.edit({ embeds: [successEmbed], components: [] });
                } catch(e) {}
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // CANCEL BUTTON
        // ═══════════════════════════════════════════════════════════════
        if (customId.startsWith('fishtrade_cancel_') && !customId.includes('emergency')) {
            const tradeId = customId.replace('fishtrade_cancel_', '');
            const trade = activeFishTrades.get(tradeId);

            if (!trade) return interaction.reply({ content: "Trade not found!", ephemeral: true });
            const userId = interaction.user.id;
            if (userId !== trade.initiatorId && userId !== trade.targetId) return interaction.reply({ content: "This isn't your trade to cancel! (¬_¬)", ephemeral: true });

            trade.status = 'CANCELLED';
            activeFishTrades.delete(tradeId);
            stopTradeTimer(tradeId);

            const cancellerName = userId === trade.initiatorId ? trade.initiatorName : trade.targetName;
            const cancelEmbed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('❌ TRADE CANCELLED')
                .setDescription(`\`\`\`diff\n- ${cancellerName} cancelled the trade.\n\`\`\`\n*Tch! Coward! (¬_¬)*`);

            await interaction.update({ embeds: [cancelEmbed], components: [] });
        }

        // ═══════════════════════════════════════════════════════════════
        // EMERGENCY CANCEL
        // ═══════════════════════════════════════════════════════════════
        if (customId.startsWith('fishtrade_emergency_')) {
            const tradeId = customId.replace('fishtrade_emergency_', '');
            const trade = activeFishTrades.get(tradeId);

            if (!trade) return interaction.reply({ content: "Trade not found!", ephemeral: true });
            const userId = interaction.user.id;
            if (userId !== trade.initiatorId && userId !== trade.targetId) return interaction.reply({ content: "This isn't your trade! (¬_¬)", ephemeral: true });

            trade.status = 'CANCELLED';
            activeFishTrades.delete(tradeId);
            stopTradeTimer(tradeId);

            const cancellerName = userId === trade.initiatorId ? trade.initiatorName : trade.targetName;
            const cancelEmbed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('🚨 EMERGENCY CANCEL')
                .setDescription(`\`\`\`diff\n- ${cancellerName} hit the emergency brake!\n\`\`\`\n*S-Smart move... I guess! >///< *`);

            await interaction.update({ embeds: [cancelEmbed], components: [] });
        }
        } catch (error) {
            console.error('Fish Trade Interaction Error:', error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: "S-Something went wrong with the fish trade! (¬_¬)", ephemeral: true }).catch(() => {});
            }
        }
    }
};
