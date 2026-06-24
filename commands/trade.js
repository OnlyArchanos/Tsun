const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');
const User = require('../models/User');
const { getDisplayName } = require('../utils/helpers');
const config = require('../config');
const GACHA_TITLES = require('../config/gachaTitles');

// Import from centralized config
const NON_TITLE_ITEMS = config.ITEMS.NON_TITLE;
const STACKABLE_ITEMS = config.ITEMS.STACKABLE;
const FRAME_COLORS = config.ITEMS.FRAME_COLORS;
const SHOP_PRICES = config.SHOP_PRICES;
const GACHA_MIN_PRICES = config.GACHA_MIN_PRICES;

// Active trade sessions: Map<tradeId, TradeSession>
const activeTrades = new Map();
// Timer intervals for periodic refresh: Map<tradeId, intervalId>
const tradeTimers = new Map();
// In-memory setup lock to prevent concurrent trade session creation for same users
const tradeSetupLocks = new Set();

// Trade session class
class TradeSession {
    constructor(initiatorId, targetId, channelId, messageId) {
        this.id = `trade_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        this.initiatorId = initiatorId;
        this.targetId = targetId;
        this.channelId = channelId;
        this.messageId = messageId;
        this.initiatorOffer = [];
        this.targetOffer = [];
        this.initiatorConfirmed = false;
        this.targetConfirmed = false;
        this.status = 'SELECTING'; // SELECTING, CONFIRMING, COUNTDOWN, COMPLETED, CANCELLED
        this.createdAt = Date.now();
        this.expiresAt = Date.now() + config.TRADE.TIMEOUT_MS;
        this.initiatorName = null;
        this.targetName = null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// VALUE ESTIMATOR - Calculate item values for trade balance
// ═══════════════════════════════════════════════════════════════════════════

function getItemRarity(itemName) {
    if (GACHA_TITLES.MYTHIC.includes(itemName)) return 'MYTHIC';
    if (GACHA_TITLES.ULTRA_RARE.includes(itemName)) return 'ULTRA_RARE';
    if (GACHA_TITLES.LEGENDARY.includes(itemName)) return 'LEGENDARY';
    if (GACHA_TITLES.RARE.includes(itemName)) return 'RARE';
    if (GACHA_TITLES.COMMON.includes(itemName)) return 'COMMON';
    if (config.ITEMS.SHOP_TITLES.includes(itemName)) return 'SHOP';
    return null;
}

function getItemValue(itemName) {
    // Check shop items first
    if (SHOP_PRICES[itemName]) {
        return SHOP_PRICES[itemName];
    }

    // Check frames
    if (FRAME_COLORS.includes(itemName)) {
        return SHOP_PRICES.RANDOM_FRAME * 2; // Frames worth ~2x roll price
    }

    // Check gacha titles by rarity
    const rarity = getItemRarity(itemName);
    if (rarity && GACHA_MIN_PRICES[rarity]) {
        return GACHA_MIN_PRICES[rarity];
    }

    // Shop titles
    if (config.ITEMS.SHOP_TITLES.includes(itemName)) {
        return SHOP_PRICES.TITLE_PRICE;
    }

    // Default fallback
    return config.TRADE.DEFAULT_ITEM_VALUE;
}

function calculateOfferValue(items) {
    if (!items || items.length === 0) return 0;
    return items.reduce((total, item) => total + getItemValue(item), 0);
}

function formatValue(value) {
    if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
    if (value >= 1000) return `${(value / 1000).toFixed(0)}K`;
    return value.toString();
}

function getTradeBalanceWarning(initiatorValue, targetValue) {
    if (initiatorValue === 0 || targetValue === 0) return null;

    const ratio = Math.max(initiatorValue, targetValue) / Math.min(initiatorValue, targetValue);

    if (ratio >= config.TRADE.BALANCE_RATIOS.DANGER) {
        return { level: 'DANGER', message: `🚨 **EXTREMELY UNBALANCED!** One side is ${config.TRADE.BALANCE_RATIOS.DANGER}x+ more valuable!` };
    } else if (ratio >= config.TRADE.BALANCE_RATIOS.WARNING) {
        return { level: 'WARNING', message: `⚠️ **UNBALANCED TRADE!** One side is ${config.TRADE.BALANCE_RATIOS.WARNING}x+ more valuable.` };
    } else if (ratio >= config.TRADE.BALANCE_RATIOS.CAUTION) {
        return { level: 'CAUTION', message: '⚡ *Slightly uneven trade - one side is ~2x more valuable.*' };
    }
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function countItems(inventory) {
    const counts = {};
    for (const item of inventory) {
        counts[item] = (counts[item] || 0) + 1;
    }
    return counts;
}

function formatItemsCompact(items) {
    if (!items || items.length === 0) return '*(empty)*';
    const counts = countItems(items);
    const lines = Object.entries(counts)
        .map(([item, count]) => {
            const emoji = getItemEmoji(item);
            const rarity = getItemRarity(item);
            const rarityTag = rarity ? getRarityTag(rarity) : '';
            return count > 1 ? `${emoji} ${item} ×${count} ${rarityTag}` : `${emoji} ${item} ${rarityTag}`;
        });
    return lines.join('\n');
}

function getRarityTag(rarity) {
    const tags = {
        'MYTHIC': '🔴',
        'ULTRA_RARE': '🟣',
        'LEGENDARY': '🟡',
        'RARE': '🔵',
        'COMMON': '⚪',
        'SHOP': '🏪'
    };
    return tags[rarity] || '';
}

function getItemEmoji(item) {
    if (item === 'Coin Amulet') return '🪙';
    if (item === 'Elo Shield') return '🛡️';
    if (item === 'Slave Freedom Ticket') return '🎟️';
    if (item === 'Trash Curse') return '💀';
    if (FRAME_COLORS.includes(item)) return '🎨';
    return '🏷️';
}

function categorizeInventory(inventory, equippedTitle = null) {
    const counts = countItems(inventory);
    const categories = {
        titles: [],
        amulets: [],
        shields: [],
        special: [],
        frames: []
    };

    for (const [item, count] of Object.entries(counts)) {
        if (item === equippedTitle) {
            if (count > 1) {
                categories.titles.push({ name: item, count: count - 1 });
            }
            continue;
        }

        if (item === 'Coin Amulet') {
            categories.amulets.push({ name: item, count });
        } else if (item === 'Elo Shield') {
            categories.shields.push({ name: item, count });
        } else if (FRAME_COLORS.includes(item)) {
            categories.frames.push({ name: item, count });
        } else if (NON_TITLE_ITEMS.includes(item)) {
            categories.special.push({ name: item, count });
        } else {
            categories.titles.push({ name: item, count });
        }
    }

    return categories;
}

// ═══════════════════════════════════════════════════════════════════════════
// EMBED BUILDERS
// ═══════════════════════════════════════════════════════════════════════════

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

    // Calculate values
    const initiatorValue = calculateOfferValue(trade.initiatorOffer);
    const targetValue = calculateOfferValue(trade.targetOffer);
    const balanceWarning = getTradeBalanceWarning(initiatorValue, targetValue);

    let description = '';
    if (trade.status === 'COUNTDOWN') {
        description = '```diff\n+ TRADE EXECUTING...\n```';
    } else if (trade.status === 'COMPLETED') {
        description = '```diff\n+ TRADE COMPLETED!\n```';
    } else if (trade.status === 'CANCELLED') {
        description = '```diff\n- TRADE CANCELLED\n```';
    } else {
        description = `\`\`\`\n⏰ Time Remaining: ${minutes}:${seconds.toString().padStart(2, '0')}\n\`\`\``;
        if (balanceWarning) {
            description += `\n${balanceWarning.message}\n`;
        }
        description += `\n*Both traders must select items and confirm!*`;
    }

    // Value display
    const initiatorValueStr = initiatorValue > 0 ? `💰 ~${formatValue(initiatorValue)}` : '';
    const targetValueStr = targetValue > 0 ? `💰 ~${formatValue(targetValue)}` : '';

    const embed = new EmbedBuilder()
        .setColor(trade.status === 'COMPLETED' ? 0x00FF00 : (trade.status === 'CANCELLED' ? 0xFF0000 : (balanceWarning?.level === 'DANGER' ? 0xFF6600 : 0xFF1493)))
        .setTitle('🔄 ═══ TRADE SESSION ═══ 🔄')
        .setDescription(description)
        .addFields(
            {
                name: `╔${'═'.repeat(18)}╗\n║ 👤 ${trade.initiatorName}`,
                value: `║ ${initiatorStatus}\n${initiatorValueStr ? `║ ${initiatorValueStr}\n` : ''}╠${'═'.repeat(18)}╣\n${formatItemsCompact(trade.initiatorOffer)}╚${'═'.repeat(18)}╝`,
                inline: true
            },
            {
                name: '⇄',
                value: '\u200B',
                inline: true
            },
            {
                name: `╔${'═'.repeat(18)}╗\n║ 👤 ${trade.targetName}`,
                value: `║ ${targetStatus}\n${targetValueStr ? `║ ${targetValueStr}\n` : ''}╠${'═'.repeat(18)}╣\n${formatItemsCompact(trade.targetOffer)}╚${'═'.repeat(18)}╝`,
                inline: true
            }
        )
        .setFooter({ text: '🗑️ Clear = Reset your offer • 🔒 Lock In = Confirm trade' });

    return embed;
}

function buildTradeButtons(trade) {
    if (trade.status === 'COUNTDOWN') {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`trade_emergency_${trade.id}`)
                .setLabel('🚨 EMERGENCY CANCEL')
                .setStyle(ButtonStyle.Danger)
        );
    }

    if (trade.status === 'COMPLETED' || trade.status === 'CANCELLED') {
        return null;
    }

    const initiatorLabel = trade.initiatorName.length > 8 ? trade.initiatorName.slice(0, 8) + '…' : trade.initiatorName;
    const targetLabel = trade.targetName.length > 8 ? trade.targetName.slice(0, 8) + '…' : trade.targetName;

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`trade_select_${trade.id}_initiator`)
            .setLabel(`📦 ${initiatorLabel}`)
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`trade_select_${trade.id}_target`)
            .setLabel(`📦 ${targetLabel}`)
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`trade_clear_${trade.id}`)
            .setLabel('🗑️ Clear')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`trade_lock_${trade.id}`)
            .setLabel('🔒 Lock In')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`trade_cancel_${trade.id}`)
            .setLabel('❌')
            .setStyle(ButtonStyle.Danger)
    );

    return row;
}

function buildSelectionEmbed(userName, categories, currentlySelected) {
    const totalItems = Object.values(categories).reduce((sum, cat) => sum + cat.length, 0);

    let itemList = '';

    if (categories.titles.length > 0) {
        itemList += '**🏷️ Titles:**\n';
        itemList += categories.titles.map(i => {
            const rarity = getItemRarity(i.name);
            const tag = rarity ? getRarityTag(rarity) : '';
            const value = formatValue(getItemValue(i.name));
            return `  ${tag} ${i.name}${i.count > 1 ? ` (×${i.count})` : ''} *~${value}*`;
        }).join('\n') + '\n\n';
    }
    if (categories.amulets.length > 0 || categories.shields.length > 0) {
        itemList += '**⚔️ Equipment:**\n';
        [...categories.amulets, ...categories.shields].forEach(i => {
            const value = formatValue(getItemValue(i.name));
            itemList += `  ${getItemEmoji(i.name)} ${i.name}${i.count > 1 ? ` (×${i.count})` : ''} *~${value}*\n`;
        });
        itemList += '\n';
    }
    if (categories.special.length > 0) {
        itemList += '**✨ Special:**\n';
        itemList += categories.special.map(i => {
            const value = formatValue(getItemValue(i.name));
            return `  ${getItemEmoji(i.name)} ${i.name}${i.count > 1 ? ` (×${i.count})` : ''} *~${value}*`;
        }).join('\n') + '\n\n';
    }
    if (categories.frames.length > 0) {
        itemList += '**🎨 Frames:**\n';
        itemList += categories.frames.map(i => `  🎨 ${i.name} Frame *~${formatValue(getItemValue(i.name))}*`).join('\n') + '\n';
    }

    if (!itemList) itemList = '*No tradeable items!*';

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`📦 ${userName}'s Inventory`)
        .setDescription(`**Select items to offer:**\n\n${itemList}`)
        .setFooter({ text: `${totalItems} tradeable item types • Values shown are estimates` });

    if (currentlySelected && currentlySelected.length > 0) {
        const counts = countItems(currentlySelected);
        const selectedText = Object.entries(counts)
            .map(([item, count]) => count > 1 ? `${item} ×${count}` : item)
            .join(', ');
        const totalValue = calculateOfferValue(currentlySelected);
        embed.addFields({
            name: `📋 Currently Selected (Total: ~${formatValue(totalValue)})`,
            value: `\`${selectedText}\``,
            inline: false
        });
    }

    return embed;
}

function buildConfirmationEmbed(trade, forUserId) {
    const isInitiator = forUserId === trade.initiatorId;
    const yourOffer = isInitiator ? trade.initiatorOffer : trade.targetOffer;
    const theirOffer = isInitiator ? trade.targetOffer : trade.initiatorOffer;
    const theirName = isInitiator ? trade.targetName : trade.initiatorName;

    const yourValue = calculateOfferValue(yourOffer);
    const theirValue = calculateOfferValue(theirOffer);
    const balanceWarning = getTradeBalanceWarning(yourValue, theirValue);

    const formatForConfirm = (items) => {
        if (!items || items.length === 0) return '*Nothing*';
        const counts = countItems(items);
        return Object.entries(counts)
            .map(([item, count]) => {
                const rarity = getItemRarity(item);
                const tag = rarity ? getRarityTag(rarity) : '';
                return count > 1 ? `${tag} ${item} ×${count}` : `${tag} ${item}`;
            })
            .join('\n');
    };

    let description = '**Review carefully before locking in!**';
    if (balanceWarning) {
        description += `\n\n${balanceWarning.message}`;
    }

    const embed = new EmbedBuilder()
        .setColor(balanceWarning?.level === 'DANGER' ? 0xFF0000 : (balanceWarning?.level === 'WARNING' ? 0xFF6600 : 0xFFD700))
        .setTitle('⚠️ CONFIRM YOUR TRADE')
        .setDescription(description)
        .addFields(
            {
                name: `📤 YOU GIVE (~${formatValue(yourValue)}):`,
                value: formatForConfirm(yourOffer),
                inline: true
            },
            {
                name: `📥 YOU GET (~${formatValue(theirValue)}):`,
                value: formatForConfirm(theirOffer),
                inline: true
            }
        )
        .setFooter({ text: `Trading with ${theirName} • Values are estimates based on shop/market prices` });

    return embed;
}

// ═══════════════════════════════════════════════════════════════════════════
// TIMER & UPDATE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function startTradeTimer(trade, client) {
    if (tradeTimers.has(trade.id)) {
        clearInterval(tradeTimers.get(trade.id));
    }

    const intervalId = setInterval(async () => {
        const currentTrade = activeTrades.get(trade.id);

        if (!currentTrade || currentTrade.status !== 'SELECTING') {
            clearInterval(intervalId);
            tradeTimers.delete(trade.id);
            return;
        }

        if (Date.now() >= currentTrade.expiresAt) {
            currentTrade.status = 'CANCELLED';
            activeTrades.delete(trade.id);
            clearInterval(intervalId);
            tradeTimers.delete(trade.id);

            try {
                const channel = await client.channels.fetch(currentTrade.channelId);
                const msg = await channel.messages.fetch(currentTrade.messageId);
                const expiredEmbed = new EmbedBuilder()
                    .setColor(0xFF0000)
                    .setTitle('⏰ TRADE EXPIRED')
                    .setDescription("```diff\n- Trade expired! Too slow!\n```\n*Tch! You wasted everyone's time! (¬_¬)*");
                await msg.edit({ embeds: [expiredEmbed], components: [] });
            } catch (e) { console.error("Failed to update expired trade:", e); }
            return;
        }

        try {
            const channel = await client.channels.fetch(currentTrade.channelId);
            const msg = await channel.messages.fetch(currentTrade.messageId);
            const embed = buildTradeEmbed(currentTrade);
            const row = buildTradeButtons(currentTrade);
            await msg.edit({ embeds: [embed], components: row ? [row] : [] });
        } catch (e) { }
    }, 10000);

    tradeTimers.set(trade.id, intervalId);
}

function stopTradeTimer(tradeId) {
    if (tradeTimers.has(tradeId)) {
        clearInterval(tradeTimers.get(tradeId));
        tradeTimers.delete(tradeId);
    }
}

async function updateTradeMessage(trade, client) {
    try {
        const channel = await client.channels.fetch(trade.channelId);
        const msg = await channel.messages.fetch(trade.messageId);
        const embed = buildTradeEmbed(trade);
        const row = buildTradeButtons(trade);
        await msg.edit({ embeds: [embed], components: row ? [row] : [] });
    } catch (e) {
        console.error("Failed to update trade message:", e);
    }
}

// Send notification to the other trader
async function notifyOtherTrader(trade, actorId, action, client) {
    try {
        const channel = await client.channels.fetch(trade.channelId);
        const otherUserId = actorId === trade.initiatorId ? trade.targetId : trade.initiatorId;
        const actorName = actorId === trade.initiatorId ? trade.initiatorName : trade.targetName;

        const notification = await channel.send({
            content: `<@${otherUserId}> 📢 **${actorName}** ${action}! Check the trade panel above.`
        });

        // Auto-delete notification after 5 seconds
        setTimeout(() => {
            notification.delete().catch(() => { });
        }, 5000);
    } catch (e) {
        console.error("Failed to send trade notification:", e);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
    handle: async (message, client) => {
        const cmd = message.content.toLowerCase().split(' ')[0];
        if (cmd !== '!trade') return;

        const target = message.mentions.users.first();
        if (!target) {
            return message.reply("B-Baka! Tag someone to trade with! `!trade @user` (¬_¬)");
        }

        if (target.id === message.author.id) {
            return message.reply("You can't trade with yourself, you lonely idiot! >///< ");
        }

        if (target.bot) {
            return message.reply("I-I don't trade with bots! They have no taste! (¬_¬)");
        }

        const lockIds = [message.author.id, target.id];
        if (lockIds.some((id) => tradeSetupLocks.has(id))) {
            return message.reply("A trade setup is already in progress for one of you. Wait a second and try again. (¬_¬)");
        }
        lockIds.forEach((id) => tradeSetupLocks.add(id));

        try {
            let initiator = await User.findOne({ userId: message.author.id });
            let targetUser = await User.findOne({ userId: target.id });

            if (!initiator) initiator = await User.create({ userId: message.author.id });
            if (!targetUser) targetUser = await User.create({ userId: target.id });

            if (initiator.botBanExpiry && initiator.botBanExpiry > Date.now()) {
                return message.reply("You're banned from the bot, criminal! No trading for you! 😤");
            }

            if (targetUser.botBanExpiry && targetUser.botBanExpiry > Date.now()) {
                return message.reply("They're banned from the bot! Find someone else to scam! (¬_¬)");
            }

            if (initiator.isSlave) {
                return message.reply("S-Slaves can't initiate trades! Know your place! >///< ");
            }

            for (const [id, trade] of activeTrades) {
                if (trade.initiatorId === message.author.id || trade.targetId === message.author.id) {
                    return message.reply("You're already in a trade session! Finish or cancel that one first! (¬_¬)");
                }
                if (trade.initiatorId === target.id || trade.targetId === target.id) {
                    return message.reply("They're already in a trade session! Wait your turn! (¬_¬)");
                }
            }

            const initiatorName = await getDisplayName(message.author.id, message.guild);
            const targetName = await getDisplayName(target.id, message.guild);

            const tempTrade = new TradeSession(message.author.id, target.id, message.channel.id, null);
            tempTrade.initiatorName = initiatorName;
            tempTrade.targetName = targetName;

            const embed = buildTradeEmbed(tempTrade);
            const row = buildTradeButtons(tempTrade);

            const tradeMsg = await message.reply({
                content: `<@${target.id}>, **${initiatorName}** wants to trade with you!\n\n*Click your name button to select items. Values shown are estimates!*`,
                embeds: [embed],
                components: [row]
            });

            tempTrade.messageId = tradeMsg.id;
            activeTrades.set(tempTrade.id, tempTrade);

            startTradeTimer(tempTrade, client);

            setTimeout(async () => {
                const trade = activeTrades.get(tempTrade.id);
                if (trade && trade.status === 'SELECTING') {
                    trade.status = 'CANCELLED';
                    activeTrades.delete(tempTrade.id);
                    stopTradeTimer(tempTrade.id);

                    try {
                        const channel = await client.channels.fetch(trade.channelId);
                        const msg = await channel.messages.fetch(trade.messageId);
                        const expiredEmbed = new EmbedBuilder()
                            .setColor(0xFF0000)
                            .setTitle('⏰ TRADE EXPIRED')
                            .setDescription("```diff\n- Trade expired! Too slow!\n```");
                        await msg.edit({ embeds: [expiredEmbed], components: [] });
                    } catch (e) { }
                }
            }, config.TRADE.TIMEOUT_MS);
        } finally {
            lockIds.forEach((id) => tradeSetupLocks.delete(id));
        }
    },

    handleInteraction: async (interaction, client) => {
        const customId = interaction.customId;
        // Only handle trade-related interactions
        if (!customId?.startsWith('trade_')) return;

        // ═══════════════════════════════════════════════════════════════
        // ITEM SELECTION FROM DROPDOWN
        // ═══════════════════════════════════════════════════════════════
        if (customId.startsWith('trade_items_')) {
            const parts = customId.split('_');
            const tradeId = parts.slice(2).join('_');
            const trade = activeTrades.get(tradeId);

            if (!trade || trade.status !== 'SELECTING') {
                return interaction.reply({ content: "This trade session is no longer active!", ephemeral: true });
            }

            const userId = interaction.user.id;

            if (userId !== trade.initiatorId && userId !== trade.targetId) {
                return interaction.reply({ content: "This isn't your trade! Mind your own business! (¬_¬)", ephemeral: true });
            }

            const selectedItems = interaction.values;

            const stackableSelected = selectedItems.filter(item => {
                const [itemName] = item.split('::');
                return STACKABLE_ITEMS.includes(itemName);
            });

            if (stackableSelected.length > 0) {
                const [itemName, maxCount] = stackableSelected[0].split('::');

                const modal = new ModalBuilder()
                    .setCustomId(`trade_qty_${tradeId}_${itemName}`)
                    .setTitle(`Quantity for ${itemName}`);

                const qtyInput = new TextInputBuilder()
                    .setCustomId('quantity')
                    .setLabel(`How many? (You have ${maxCount})`)
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder('1')
                    .setRequired(true)
                    .setMinLength(1)
                    .setMaxLength(3);

                modal.addComponents(new ActionRowBuilder().addComponents(qtyInput));

                if (!trade.pendingSelection) trade.pendingSelection = {};
                trade.pendingSelection[userId] = { items: selectedItems, tradeId: trade.id };

                return interaction.showModal(modal);
            }

            const items = selectedItems.map(item => item.split('::')[0]);

            if (userId === trade.initiatorId) {
                trade.initiatorOffer = items;
                trade.initiatorConfirmed = false;
            } else {
                trade.targetOffer = items;
                trade.targetConfirmed = false;
            }

            await updateTradeMessage(trade, client);

            // NOTIFY OTHER TRADER
            await notifyOtherTrader(trade, userId, 'updated their offer', client);

            const counts = countItems(items);
            const selectedText = Object.entries(counts)
                .map(([item, count]) => count > 1 ? `${item} ×${count}` : item)
                .join(', ');
            const totalValue = calculateOfferValue(items);

            await interaction.update({
                content: `✅ **Items added to trade!**\n\n**Your offer:** ${selectedText}\n**Estimated value:** ~${formatValue(totalValue)}\n\n*Check the main trade panel above. Click 🔒 Lock In when ready!*`,
                embeds: [],
                components: []
            });
        }

        // ═══════════════════════════════════════════════════════════════
        // QUANTITY MODAL SUBMISSION
        // ═══════════════════════════════════════════════════════════════
        if (customId.startsWith('trade_qty_')) {
            const parts = customId.split('_');
            // Extract tradeId (trade_timestamp_random) and itemName
            // Format: trade_qty_trade_timestamp_random_ItemName
            const itemName = parts[parts.length - 1];
            const tradeIdParts = parts.slice(2, -1);
            const tradeId = tradeIdParts.join('_');

            let trade = activeTrades.get(tradeId);

            // Fallback: search by checking pendingSelection
            if (!trade) {
                for (const [id, t] of activeTrades) {
                    if (t.pendingSelection && Object.values(t.pendingSelection).some(p => p.tradeId === id)) {
                        trade = t;
                        break;
                    }
                }
            }

            if (!trade) {
                return interaction.reply({ content: "Trade no longer exists!", ephemeral: true });
            }

            const userId = interaction.user.id;

            if (userId !== trade.initiatorId && userId !== trade.targetId) {
                return interaction.reply({ content: "This isn't your trade!", ephemeral: true });
            }

            const quantity = parseInt(interaction.fields.getTextInputValue('quantity')) || 1;

            const user = await User.findOne({ userId });
            const itemCount = user.inventory.filter(i => i === itemName).length;

            if (quantity > itemCount || quantity < 1) {
                return interaction.reply({ content: `Invalid quantity! You only have ${itemCount}! (¬_¬)`, ephemeral: true });
            }

            const pending = trade.pendingSelection?.[userId];
            const pendingItems = pending?.items || pending || [];
            const items = [];

            for (const item of pendingItems) {
                const [name] = item.split('::');
                if (name === itemName) {
                    for (let i = 0; i < quantity; i++) {
                        items.push(name);
                    }
                } else if (!STACKABLE_ITEMS.includes(name)) {
                    items.push(name);
                }
            }

            if (userId === trade.initiatorId) {
                trade.initiatorOffer = items;
                trade.initiatorConfirmed = false;
            } else {
                trade.targetOffer = items;
                trade.targetConfirmed = false;
            }

            delete trade.pendingSelection?.[userId];

            await updateTradeMessage(trade, client);

            // NOTIFY OTHER TRADER
            await notifyOtherTrader(trade, userId, 'updated their offer', client);

            const counts = countItems(items);
            const selectedText = Object.entries(counts)
                .map(([item, count]) => count > 1 ? `${item} ×${count}` : item)
                .join(', ');
            const totalValue = calculateOfferValue(items);

            await interaction.reply({
                content: `✅ **Items added to trade!**\n\n**Your offer:** ${selectedText}\n**Estimated value:** ~${formatValue(totalValue)}\n\n*Check the main trade panel. Click 🔒 Lock In when ready!*`,
                ephemeral: true
            });
        }

        // ═══════════════════════════════════════════════════════════════
        // SELECT BUTTON
        // ═══════════════════════════════════════════════════════════════
        if (customId.startsWith('trade_select_') && !customId.includes('_qty_') && !customId.includes('_items_') && !customId.includes('_page_')) {
            const parts = customId.split('_');
            const role = parts[parts.length - 1];
            const tradeId = parts.slice(2, -1).join('_');
            const trade = activeTrades.get(tradeId);

            if (!trade || trade.status !== 'SELECTING') {
                return interaction.reply({ content: "This trade is no longer active!", ephemeral: true });
            }

            const allowedUserId = role === 'initiator' ? trade.initiatorId : trade.targetId;

            if (interaction.user.id !== allowedUserId) {
                return interaction.reply({
                    content: "❌ **That's not your button!**\n\nClick the button with YOUR name to select items from YOUR inventory!",
                    ephemeral: true
                });
            }

            const user = await User.findOne({ userId: interaction.user.id });
            if (!user || user.inventory.length === 0) {
                return interaction.reply({ content: "Your inventory is empty! Nothing to trade! >///< ", ephemeral: true });
            }

            const categories = categorizeInventory(user.inventory, user.equippedTitle);
            const currentOffer = role === 'initiator' ? trade.initiatorOffer : trade.targetOffer;

            const userName = role === 'initiator' ? trade.initiatorName : trade.targetName;

            // Build ALL options first (no 25 limit)
            const allOptions = [];

            for (const item of categories.titles) {
                const rarity = getItemRarity(item.name);
                allOptions.push({
                    label: item.count > 1 ? `${item.name} (×${item.count})` : item.name,
                    value: `${item.name}::${item.count}`,
                    emoji: getRarityTag(rarity) || '🏷️',
                    description: `~${formatValue(getItemValue(item.name))} each`
                });
            }

            for (const item of categories.amulets) {
                allOptions.push({
                    label: item.count > 1 ? `${item.name} (×${item.count})` : item.name,
                    value: `${item.name}::${item.count}`,
                    emoji: '🪙',
                    description: `~${formatValue(getItemValue(item.name))} each • Stackable`
                });
            }

            for (const item of categories.shields) {
                allOptions.push({
                    label: item.count > 1 ? `${item.name} (×${item.count})` : item.name,
                    value: `${item.name}::${item.count}`,
                    emoji: '🛡️',
                    description: `~${formatValue(getItemValue(item.name))} each • Stackable`
                });
            }

            for (const item of categories.special) {
                allOptions.push({
                    label: item.count > 1 ? `${item.name} (×${item.count})` : item.name,
                    value: `${item.name}::${item.count}`,
                    emoji: '✨',
                    description: `~${formatValue(getItemValue(item.name))} each`
                });
            }

            for (const item of categories.frames) {
                allOptions.push({
                    label: `${item.name} Frame`,
                    value: `${item.name}::${item.count}`,
                    emoji: '🎨',
                    description: `~${formatValue(getItemValue(item.name))}`
                });
            }

            if (allOptions.length === 0) {
                return interaction.reply({ content: "You have no tradeable items! (Equipped titles can't be traded) >///< ", ephemeral: true });
            }

            // Pagination
            const page = 0;
            const pageSize = 25;
            const totalPages = Math.ceil(allOptions.length / pageSize);
            const pageOptions = allOptions.slice(page * pageSize, (page + 1) * pageSize);

            const selectionEmbed = buildSelectionEmbed(userName, categories, currentOffer);
            if (totalPages > 1) {
                selectionEmbed.setFooter({ text: `Page ${page + 1}/${totalPages} • ${allOptions.length} tradeable items • Values are estimates` });
            }

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`trade_items_${trade.id}`)
                .setPlaceholder('🎁 Choose items to offer...')
                .setMinValues(1)
                .setMaxValues(Math.min(pageOptions.length, 10))
                .addOptions(pageOptions);

            const components = [new ActionRowBuilder().addComponents(selectMenu)];

            // Add navigation buttons if multiple pages
            if (totalPages > 1) {
                const buttonRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`trade_select_page_${tradeId}_${role}_${page - 1}`)
                        .setLabel('Previous')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('⬅️')
                        .setDisabled(page === 0),
                    new ButtonBuilder()
                        .setCustomId(`trade_select_page_info`)
                        .setLabel(`Page ${page + 1}/${totalPages}`)
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(true),
                    new ButtonBuilder()
                        .setCustomId(`trade_select_page_${tradeId}_${role}_${page + 1}`)
                        .setLabel('Next')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('➡️')
                        .setDisabled(page >= totalPages - 1)
                );
                components.push(buttonRow);
            }

            await interaction.reply({
                embeds: [selectionEmbed],
                components,
                ephemeral: true
            });
            
            // Clean up components before Discord's 15-minute token expiry
            setTimeout(() => {
                interaction.editReply({ components: [] }).catch(() => {});
            }, 14 * 60 * 1000);
        }

        // ═══════════════════════════════════════════════════════════════
        // TRADE ITEM SELECTION PAGE NAVIGATION
        // ═══════════════════════════════════════════════════════════════
        if (customId.startsWith('trade_select_page_') && !customId.includes('info')) {
            const parts = customId.split('_');
            // Format: trade_select_page_{tradeId parts}_role_pageNum
            const targetPage = parseInt(parts[parts.length - 1]);
            const role = parts[parts.length - 2];
            const tradeId = parts.slice(3, -2).join('_');
            const trade = activeTrades.get(tradeId);

            if (!trade || trade.status !== 'SELECTING') {
                return interaction.reply({ content: "This trade is no longer active!", ephemeral: true });
            }

            const allowedUserId = role === 'initiator' ? trade.initiatorId : trade.targetId;
            if (interaction.user.id !== allowedUserId) {
                return interaction.reply({ content: "H-Hey! This isn't your selection menu! (¬_¬)", ephemeral: true });
            }

            const user = await User.findOne({ userId: interaction.user.id });
            if (!user) return interaction.reply({ content: "Error loading your data!", ephemeral: true });

            const categories = categorizeInventory(user.inventory, user.equippedTitle);
            const currentOffer = role === 'initiator' ? trade.initiatorOffer : trade.targetOffer;
            const userName = role === 'initiator' ? trade.initiatorName : trade.targetName;

            // Build ALL options
            const allOptions = [];

            for (const item of categories.titles) {
                const rarity = getItemRarity(item.name);
                allOptions.push({
                    label: item.count > 1 ? `${item.name} (×${item.count})` : item.name,
                    value: `${item.name}::${item.count}`,
                    emoji: getRarityTag(rarity) || '🏷️',
                    description: `~${formatValue(getItemValue(item.name))} each`
                });
            }

            for (const item of categories.amulets) {
                allOptions.push({
                    label: item.count > 1 ? `${item.name} (×${item.count})` : item.name,
                    value: `${item.name}::${item.count}`,
                    emoji: '🪙',
                    description: `~${formatValue(getItemValue(item.name))} each • Stackable`
                });
            }

            for (const item of categories.shields) {
                allOptions.push({
                    label: item.count > 1 ? `${item.name} (×${item.count})` : item.name,
                    value: `${item.name}::${item.count}`,
                    emoji: '🛡️',
                    description: `~${formatValue(getItemValue(item.name))} each • Stackable`
                });
            }

            for (const item of categories.special) {
                allOptions.push({
                    label: item.count > 1 ? `${item.name} (×${item.count})` : item.name,
                    value: `${item.name}::${item.count}`,
                    emoji: '✨',
                    description: `~${formatValue(getItemValue(item.name))} each`
                });
            }

            for (const item of categories.frames) {
                allOptions.push({
                    label: `${item.name} Frame`,
                    value: `${item.name}::${item.count}`,
                    emoji: '🎨',
                    description: `~${formatValue(getItemValue(item.name))}`
                });
            }

            const pageSize = 25;
            const totalPages = Math.ceil(allOptions.length / pageSize);
            const page = Math.max(0, Math.min(targetPage, totalPages - 1));
            const pageOptions = allOptions.slice(page * pageSize, (page + 1) * pageSize);

            const selectionEmbed = buildSelectionEmbed(userName, categories, currentOffer);
            selectionEmbed.setFooter({ text: `Page ${page + 1}/${totalPages} • ${allOptions.length} tradeable items • D-Don't take forever! (¬_¬)` });

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`trade_items_${trade.id}`)
                .setPlaceholder('🎁 Choose items to offer...')
                .setMinValues(1)
                .setMaxValues(Math.min(pageOptions.length, 10))
                .addOptions(pageOptions);

            const components = [new ActionRowBuilder().addComponents(selectMenu)];

            if (totalPages > 1) {
                const buttonRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`trade_select_page_${tradeId}_${role}_${page - 1}`)
                        .setLabel('Previous')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('⬅️')
                        .setDisabled(page === 0),
                    new ButtonBuilder()
                        .setCustomId(`trade_select_page_info`)
                        .setLabel(`Page ${page + 1}/${totalPages}`)
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(true),
                    new ButtonBuilder()
                        .setCustomId(`trade_select_page_${tradeId}_${role}_${page + 1}`)
                        .setLabel('Next')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('➡️')
                        .setDisabled(page >= totalPages - 1)
                );
                components.push(buttonRow);
            }

            await interaction.update({
                embeds: [selectionEmbed],
                components
            });
        }

        // ═══════════════════════════════════════════════════════════════
        // CLEAR SELECTION BUTTON
        // ═══════════════════════════════════════════════════════════════
        if (customId.startsWith('trade_clear_')) {
            const tradeId = customId.replace('trade_clear_', '');
            const trade = activeTrades.get(tradeId);

            if (!trade || trade.status !== 'SELECTING') {
                return interaction.reply({ content: "This trade is no longer active!", ephemeral: true });
            }

            const userId = interaction.user.id;

            if (userId !== trade.initiatorId && userId !== trade.targetId) {
                return interaction.reply({ content: "This isn't your trade! (¬_¬)", ephemeral: true });
            }

            // Clear this user's offer
            if (userId === trade.initiatorId) {
                trade.initiatorOffer = [];
                trade.initiatorConfirmed = false;
            } else {
                trade.targetOffer = [];
                trade.targetConfirmed = false;
            }

            await updateTradeMessage(trade, client);

            // NOTIFY OTHER TRADER
            await notifyOtherTrader(trade, userId, 'cleared their offer', client);

            await interaction.reply({
                content: "🗑️ **Your offer has been cleared!**\n\n*Click your SELECT button to choose new items.*",
                ephemeral: true
            });
        }

        // ═══════════════════════════════════════════════════════════════
        // LOCK IN BUTTON
        // ═══════════════════════════════════════════════════════════════
        if (customId.startsWith('trade_lock_')) {
            const tradeId = customId.replace('trade_lock_', '');
            const trade = activeTrades.get(tradeId);

            if (!trade || trade.status !== 'SELECTING') {
                return interaction.reply({ content: "This trade is no longer active!", ephemeral: true });
            }

            const userId = interaction.user.id;

            if (userId !== trade.initiatorId && userId !== trade.targetId) {
                return interaction.reply({ content: "This isn't your trade! (¬_¬)", ephemeral: true });
            }

            if (trade.initiatorOffer.length === 0) {
                if (userId === trade.initiatorId) {
                    return interaction.reply({ content: "❌ You haven't selected any items!\n\nClick your SELECT button first.", ephemeral: true });
                } else {
                    return interaction.reply({ content: `❌ **${trade.initiatorName}** hasn't selected items yet!\n\nNo free gifts allowed!`, ephemeral: true });
                }
            }

            if (trade.targetOffer.length === 0) {
                if (userId === trade.targetId) {
                    return interaction.reply({ content: "❌ You haven't selected any items!\n\nClick your SELECT button first.", ephemeral: true });
                } else {
                    return interaction.reply({ content: `❌ **${trade.targetName}** hasn't selected items yet!\n\nNo free gifts allowed!`, ephemeral: true });
                }
            }

            const confirmEmbed = buildConfirmationEmbed(trade, userId);
            const confirmRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`trade_confirm_${trade.id}`)
                    .setLabel('✅ CONFIRM TRADE')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`trade_back_${trade.id}`)
                    .setLabel('↩️ Go Back')
                    .setStyle(ButtonStyle.Secondary)
            );

            await interaction.reply({
                embeds: [confirmEmbed],
                components: [confirmRow],
                ephemeral: true
            });

            // Clean up components before Discord's 15-minute token expiry
            setTimeout(() => {
                interaction.editReply({ components: [] }).catch(() => {});
            }, 14 * 60 * 1000);
        }

        // ═══════════════════════════════════════════════════════════════
        // CONFIRM BUTTON
        // ═══════════════════════════════════════════════════════════════
        if (customId.startsWith('trade_confirm_')) {
            const tradeId = customId.replace('trade_confirm_', '');
            const trade = activeTrades.get(tradeId);

            if (!trade || trade.status !== 'SELECTING') {
                return interaction.reply({ content: "This trade is no longer active!", ephemeral: true });
            }

            const userId = interaction.user.id;

            if (userId !== trade.initiatorId && userId !== trade.targetId) {
                return interaction.reply({ content: "This isn't your trade!", ephemeral: true });
            }

            if (userId === trade.initiatorId) {
                trade.initiatorConfirmed = true;
            } else {
                trade.targetConfirmed = true;
            }

            await interaction.update({
                content: "✅ **You've locked in your trade!**\n\n*Waiting for the other trader to confirm...*",
                embeds: [],
                components: []
            });

            await updateTradeMessage(trade, client);

            // NOTIFY OTHER TRADER
            await notifyOtherTrader(trade, userId, 'has LOCKED IN', client);

            if (trade.initiatorConfirmed && trade.targetConfirmed) {
                if (trade.status !== 'SELECTING') {
                    return;
                }
                trade.status = 'COUNTDOWN';
                stopTradeTimer(trade.id);

                const cancelRow = buildTradeButtons(trade);

                for (let i = 5; i >= 1; i--) {
                    const currentTrade = activeTrades.get(tradeId);
                    if (!currentTrade || currentTrade.status === 'CANCELLED') {
                        return;
                    }

                    try {
                        const channel = await client.channels.fetch(trade.channelId);
                        const msg = await channel.messages.fetch(trade.messageId);

                        const countdownEmbed = new EmbedBuilder()
                            .setColor(0xFFD700)
                            .setTitle('⏳ FINALIZING TRADE...')
                            .setDescription(`\`\`\`diff\n+ Executing in ${i}...\n\`\`\`\n**⚠️ Click EMERGENCY CANCEL to abort!**`)
                            .addFields(
                                { name: `📤 ${trade.initiatorName} gives:`, value: formatItemsCompact(trade.initiatorOffer), inline: true },
                                { name: '⇄', value: '\u200B', inline: true },
                                { name: `📤 ${trade.targetName} gives:`, value: formatItemsCompact(trade.targetOffer), inline: true }
                            );

                        await msg.edit({ embeds: [countdownEmbed], components: cancelRow ? [cancelRow] : [] });
                    } catch (e) { }

                    await new Promise(r => setTimeout(r, 1000));
                }

                const currentTrade = activeTrades.get(tradeId);
                if (!currentTrade || currentTrade.status === 'CANCELLED') {
                    return;
                }

                const initiator = await User.findOne({ userId: trade.initiatorId });
                const target = await User.findOne({ userId: trade.targetId });

                const initiatorCounts = countItems(trade.initiatorOffer);
                const initiatorInvCounts = countItems(initiator.inventory);
                for (const [item, count] of Object.entries(initiatorCounts)) {
                    if ((initiatorInvCounts[item] || 0) < count) {
                        trade.status = 'CANCELLED';
                        activeTrades.delete(tradeId);

                        const failEmbed = new EmbedBuilder()
                            .setColor(0xFF0000)
                            .setTitle('❌ TRADE FAILED')
                            .setDescription(`\`\`\`diff\n- ${trade.initiatorName} no longer has the items!\n\`\`\`\n*S-Scammer! (¬_¬)*`);

                        const channel = await client.channels.fetch(trade.channelId);
                        const msg = await channel.messages.fetch(trade.messageId);
                        await msg.edit({ embeds: [failEmbed], components: [] });
                        return;
                    }
                }

                const targetCounts = countItems(trade.targetOffer);
                const targetInvCounts = countItems(target.inventory);
                for (const [item, count] of Object.entries(targetCounts)) {
                    if ((targetInvCounts[item] || 0) < count) {
                        trade.status = 'CANCELLED';
                        activeTrades.delete(tradeId);

                        const failEmbed = new EmbedBuilder()
                            .setColor(0xFF0000)
                            .setTitle('❌ TRADE FAILED')
                            .setDescription(`\`\`\`diff\n- ${trade.targetName} no longer has the items!\n\`\`\`\n*S-Scammer! (¬_¬)*`);

                        const channel = await client.channels.fetch(trade.channelId);
                        const msg = await channel.messages.fetch(trade.messageId);
                        await msg.edit({ embeds: [failEmbed], components: [] });
                        return;
                    }
                }

                // Atomic item transfers: remove offered items one-by-one safely
                // Using $unset on a specific index prevents $pull from removing ALL occurrences
                const successfullyRemovedFromInitiator = [];
                const successfullyRemovedFromTarget = [];
                let transactionFailed = false;

                // Process initiator's offer - Atomic Bulk Removal
                if (trade.initiatorOffer.length > 0) {
                    const tempUser = await User.findOne({ userId: trade.initiatorId }).lean();
                    const currentInv = [...tempUser.inventory];
                    const unsetObj = {};
                    const matchConditions = { userId: trade.initiatorId };
                    const pendingRemoval = [];
                    
                    for (const item of trade.initiatorOffer) {
                        const idx = currentInv.indexOf(item);
                        if (idx !== -1) {
                            unsetObj[`inventory.${idx}`] = 1;
                            matchConditions[`inventory.${idx}`] = item;
                            pendingRemoval.push(item);
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
                            await User.updateOne({ userId: trade.initiatorId }, { $pull: { inventory: null } });
                        } else {
                            transactionFailed = true;
                        }
                    }
                }

                // If initiator failed, rollback and abort before touching target
                if (transactionFailed) {
                    if (successfullyRemovedFromInitiator.length > 0) {
                        await User.findOneAndUpdate(
                            { userId: trade.initiatorId },
                            { $push: { inventory: { $each: successfullyRemovedFromInitiator } } }
                        );
                    }
                    
                    trade.status = 'CANCELLED';
                    activeTrades.delete(tradeId);

                    const failEmbed = new EmbedBuilder()
                        .setColor(0xFF0000)
                        .setTitle('❌ TRADE FAILED')
                        .setDescription(`\`\`\`diff\n- Transaction Fault! ${trade.initiatorName}'s inventory shifted during execution!\n\`\`\`\n*A-Are you trying to exploit me?! (¬_¬)*`);

                    const channel = await client.channels.fetch(trade.channelId);
                    const msg = await channel.messages.fetch(trade.messageId);
                    await msg.edit({ embeds: [failEmbed], components: [] });
                    return;
                }

                // Process target's offer - Atomic Bulk Removal
                if (trade.targetOffer.length > 0) {
                    const tempUser = await User.findOne({ userId: trade.targetId }).lean();
                    const currentInv = [...tempUser.inventory];
                    const unsetObj = {};
                    const matchConditions = { userId: trade.targetId };
                    const pendingRemoval = [];
                    
                    for (const item of trade.targetOffer) {
                        const idx = currentInv.indexOf(item);
                        if (idx !== -1) {
                            unsetObj[`inventory.${idx}`] = 1;
                            matchConditions[`inventory.${idx}`] = item;
                            pendingRemoval.push(item);
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
                            await User.updateOne({ userId: trade.targetId }, { $pull: { inventory: null } });
                        } else {
                            transactionFailed = true;
                        }
                    }
                }

                // If target failed, rollback BOTH
                if (transactionFailed) {
                    if (successfullyRemovedFromInitiator.length > 0) {
                        await User.findOneAndUpdate(
                            { userId: trade.initiatorId },
                            { $push: { inventory: { $each: successfullyRemovedFromInitiator } } }
                        );
                    }
                    if (successfullyRemovedFromTarget.length > 0) {
                        await User.findOneAndUpdate(
                            { userId: trade.targetId },
                            { $push: { inventory: { $each: successfullyRemovedFromTarget } } }
                        );
                    }
                    
                    trade.status = 'CANCELLED';
                    activeTrades.delete(tradeId);

                    const failEmbed = new EmbedBuilder()
                        .setColor(0xFF0000)
                        .setTitle('❌ TRADE FAILED')
                        .setDescription(`\`\`\`diff\n- Transaction Fault! ${trade.targetName}'s inventory shifted during execution!\n\`\`\`\n*A-Are you trying to exploit me?! (¬_¬)*`);

                    const channel = await client.channels.fetch(trade.channelId);
                    const msg = await channel.messages.fetch(trade.messageId);
                    await msg.edit({ embeds: [failEmbed], components: [] });
                    return;
                }

                // Transaction SUCCESS! Disburse items to the opposite players!
                if (successfullyRemovedFromTarget.length > 0) {
                    await User.findOneAndUpdate(
                        { userId: trade.initiatorId },
                        { $push: { inventory: { $each: successfullyRemovedFromTarget } } }
                    );
                }
                
                if (successfullyRemovedFromInitiator.length > 0) {
                    await User.findOneAndUpdate(
                        { userId: trade.targetId },
                        { $push: { inventory: { $each: successfullyRemovedFromInitiator } } }
                    );
                }

                trade.status = 'COMPLETED';
                activeTrades.delete(tradeId);

                const initiatorValue = calculateOfferValue(trade.initiatorOffer);
                const targetValue = calculateOfferValue(trade.targetOffer);

                const successEmbed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setTitle('✅ TRADE COMPLETED!')
                    .setDescription('```diff\n+ Items have been exchanged!\n```')
                    .addFields(
                        { name: `📥 ${trade.initiatorName} received (~${formatValue(targetValue)}):`, value: formatItemsCompact(trade.targetOffer), inline: true },
                        { name: '⇄', value: '\u200B', inline: true },
                        { name: `📥 ${trade.targetName} received (~${formatValue(initiatorValue)}):`, value: formatItemsCompact(trade.initiatorOffer), inline: true }
                    )
                    .setFooter({ text: "H-Hmph! Don't come crying if you regret it! >///< " });

                const channel = await client.channels.fetch(trade.channelId);
                const msg = await channel.messages.fetch(trade.messageId);
                await msg.edit({ embeds: [successEmbed], components: [] });
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // GO BACK BUTTON
        // ═══════════════════════════════════════════════════════════════
        if (customId.startsWith('trade_back_')) {
            await interaction.update({
                content: "*Trade confirmation cancelled. You can modify your selection or try again.*",
                embeds: [],
                components: []
            });
        }

        // ═══════════════════════════════════════════════════════════════
        // CANCEL BUTTON
        // ═══════════════════════════════════════════════════════════════
        if (customId.startsWith('trade_cancel_') && !customId.includes('emergency')) {
            const tradeId = customId.replace('trade_cancel_', '');
            const trade = activeTrades.get(tradeId);

            if (!trade) {
                return interaction.reply({ content: "Trade not found!", ephemeral: true });
            }

            const userId = interaction.user.id;

            if (userId !== trade.initiatorId && userId !== trade.targetId) {
                return interaction.reply({ content: "This isn't your trade to cancel! (¬_¬)", ephemeral: true });
            }

            trade.status = 'CANCELLED';
            activeTrades.delete(tradeId);
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
        if (customId.startsWith('trade_emergency_')) {
            const tradeId = customId.replace('trade_emergency_', '');
            const trade = activeTrades.get(tradeId);

            if (!trade) {
                return interaction.reply({ content: "Trade not found!", ephemeral: true });
            }

            const userId = interaction.user.id;

            if (userId !== trade.initiatorId && userId !== trade.targetId) {
                return interaction.reply({ content: "This isn't your trade! (¬_¬)", ephemeral: true });
            }

            trade.status = 'CANCELLED';
            activeTrades.delete(tradeId);
            stopTradeTimer(tradeId);

            const cancellerName = userId === trade.initiatorId ? trade.initiatorName : trade.targetName;
            const cancelEmbed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('🚨 EMERGENCY CANCEL')
                .setDescription(`\`\`\`diff\n- ${cancellerName} hit the emergency brake!\n\`\`\`\n*S-Smart move... I guess! >///< *`);

            await interaction.update({ embeds: [cancelEmbed], components: [] });
        }
    }
};
