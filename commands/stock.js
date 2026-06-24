const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const User = require('../models/User');
const Stock = require('../models/Stock');
const Portfolio = require('../models/Portfolio');
const config = require('../config');
const { getDisplayName } = require('../utils/helpers');
const { distributeIncome } = require('../utils/income');
const stockEngine = require('../utils/stockEngine');

const S = config.STOCKS;
const PORTFOLIO_PAGE_SIZE = 10;
const MARKET_PAGE_SIZE = 10;

// --- Helper functions ---

function formatPrice(price) {
    const abs = Math.abs(price);
    const sign = price < 0 ? '-' : '';
    if (abs >= 1000000) return `${sign}${(abs / 1000000).toFixed(1)}M`;
    if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}K`;
    return price.toFixed(2);
}

function formatChange(current, previous) {
    if (!previous || previous === 0) return '+0.00%';
    const pct = ((current - previous) / previous * 100);
    const sign = pct >= 0 ? '+' : '';
    const emoji = pct >= 0 ? '📈' : '📉';
    return `${emoji} ${sign}${pct.toFixed(2)}%`;
}

function miniSparkline(price, previousClose) {
    if (price > previousClose * 1.05) return '▲▲▲';
    if (price > previousClose * 1.01) return '▲▲';
    if (price > previousClose) return '▲';
    if (price < previousClose * 0.95) return '▼▼▼';
    if (price < previousClose * 0.99) return '▼▼';
    if (price < previousClose) return '▼';
    return '━';
}

// --- Pagination helpers ---

function buildPageButtons(prefix, userId, page, totalPages) {
    if (totalPages <= 1) return null;
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${prefix}_${userId}_${page - 1}`)
            .setLabel('Previous')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('⬅️')
            .setDisabled(page === 0),
        new ButtonBuilder()
            .setCustomId(`${prefix}_pageinfo`)
            .setLabel(`Page ${page + 1}/${totalPages}`)
            .setStyle(ButtonStyle.Primary)
            .setDisabled(true),
        new ButtonBuilder()
            .setCustomId(`${prefix}_${userId}_${page + 1}`)
            .setLabel('Next')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('➡️')
            .setDisabled(page >= totalPages - 1)
    );
}

// --- Build portfolio embed (shared by command + pagination) ---

async function buildPortfolioEmbed(userId, displayName, guild, targetPage) {
    const holdings = await Portfolio.find({ ownerId: userId, shares: { $gt: 0 } });

    if (holdings.length === 0) {
        return { empty: true };
    }

    let totalEquity = 0;
    let totalInvested = 0;
    const allLines = [];

    for (const h of holdings) {
        const stock = await Stock.findOne({ userId: h.targetUserId });
        if (!stock) continue;
        const name = await getDisplayName(h.targetUserId, guild);
        const value = h.shares * stock.currentPrice;
        const pnl = value - h.totalInvested;
        const pnlEmoji = pnl >= 0 ? '🟢' : '🔴';
        const arrow = pnl >= 0 ? '▲' : '▼';

        totalEquity += value;
        totalInvested += h.totalInvested;

        const nameStr = name.length > 16 ? name.slice(0, 15) + '…' : name;
        allLines.push(`${pnlEmoji} **${nameStr}** · ${h.shares} shares · \`${formatPrice(stock.currentPrice)}\` ${arrow}`);
    }

    const totalPages = Math.max(1, Math.ceil(allLines.length / PORTFOLIO_PAGE_SIZE));
    const page = Math.max(0, Math.min(targetPage, totalPages - 1));
    const pageLines = allLines.slice(page * PORTFOLIO_PAGE_SIZE, (page + 1) * PORTFOLIO_PAGE_SIZE);

    const totalPnl = totalEquity - totalInvested;
    const totalPnlPct = totalInvested > 0 ? (totalPnl / totalInvested * 100).toFixed(1) : '0.0';

    const embed = new EmbedBuilder()
        .setColor(totalPnl >= 0 ? 0x00D166 : 0xED4245)
        .setTitle(`💼 ${displayName}'s Portfolio`)
        .setDescription(pageLines.join('\n') || 'Empty...')
        .addFields(
            { name: '💰 Total Equity', value: `\`${formatPrice(totalEquity)}\``, inline: true },
            { name: '📊 PnL', value: `\`${totalPnl >= 0 ? '+' : ''}${formatPrice(totalPnl)} (${totalPnlPct}%)\``, inline: true },
        )
        .setFooter({ text: `Page ${page + 1}/${totalPages} • D-Don't blame me if you lose money! >///<` });

    const buttons = buildPageButtons('stockpf', userId, page, totalPages);
    return { embed, buttons, page, totalPages };
}

// --- Build market embed (shared by command + pagination) ---

async function buildMarketEmbed(guild, targetPage) {
    const allStocks = await Stock.find({}).sort({ currentPrice: -1 });

    if (allStocks.length === 0) {
        return { empty: true };
    }

    // Top stocks with pagination
    const totalPages = Math.max(1, Math.ceil(allStocks.length / MARKET_PAGE_SIZE));
    const page = Math.max(0, Math.min(targetPage, totalPages - 1));
    const pageStocks = allStocks.slice(page * MARKET_PAGE_SIZE, (page + 1) * MARKET_PAGE_SIZE);
    const startRank = page * MARKET_PAGE_SIZE;

    const topLines = [];
    for (let i = 0; i < pageStocks.length; i++) {
        const s = pageStocks[i];
        const name = await getDisplayName(s.userId, guild);
        const changePct = s.previousClose > 0
            ? ((s.currentPrice - s.previousClose) / s.previousClose * 100)
            : 0;
        const changeStr = changePct >= 0 ? `+${changePct.toFixed(1)}%` : `${changePct.toFixed(1)}%`;
        const changeEmoji = changePct >= 0 ? '📈' : '📉';
        const nameStr = name.length > 14 ? name.slice(0, 13) + '…' : name;
        topLines.push(`\`#${startRank + i + 1}\` **${nameStr}** — \`${formatPrice(s.currentPrice)}\` ${changeEmoji} ${changeStr}`);
    }

    // Gainers/Losers (always show top 5 overall, regardless of page)
    const withChange = allStocks
        .filter(s => s.previousClose > 0)
        .map(s => ({ ...s.toObject(), changePct: (s.currentPrice - s.previousClose) / s.previousClose }));
    const gainersSorted = [...withChange].sort((a, b) => b.changePct - a.changePct).slice(0, 5);
    const losersSorted = [...withChange].sort((a, b) => a.changePct - b.changePct).slice(0, 5);

    const gainerLines = [];
    for (const g of gainersSorted) {
        if (g.changePct <= 0) break;
        const name = await getDisplayName(g.userId, guild);
        gainerLines.push(`📈 **${name}** +${(g.changePct * 100).toFixed(1)}%`);
    }

    const loserLines = [];
    for (const l of losersSorted) {
        if (l.changePct >= 0) break;
        const name = await getDisplayName(l.userId, guild);
        loserLines.push(`📉 **${name}** ${(l.changePct * 100).toFixed(1)}%`);
    }

    const fields = [
        { name: '🏆 Stocks', value: topLines.join('\n') || 'None yet', inline: false },
    ];

    // Only show gainers/losers on first page
    if (page === 0) {
        fields.push(
            { name: '📈 Gainers (24h)', value: gainerLines.join('\n') || 'Nobody went up...', inline: true },
            { name: '📉 Losers (24h)', value: loserLines.join('\n') || 'Nobody crashed!', inline: true },
        );
    }

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('📊 TsunStocks Market')
        .setDescription(`*Hmph, here's your precious market data! (¬_¬)*`)
        .addFields(fields)
        .setFooter({ text: `Page ${page + 1}/${totalPages} • ${allStocks.length} listed stocks` });

    const buttons = buildPageButtons('stockmkt', 'all', page, totalPages);
    return { embed, buttons, page, totalPages };
}

// --- Main command handler ---

module.exports = {
    handle: async (message, client) => {
        const args = message.content.split(/\s+/);
        const sub = args[1]?.toLowerCase();

        let user = await User.findOne({ userId: message.author.id });
        if (!user) user = await User.create({ userId: message.author.id });

        // !stock (no subcommand) or !stock help
        if (!sub || sub === 'help') {
            const embed = new EmbedBuilder()
                .setColor(0x00D166)
                .setTitle('📊 TsunStocks — Help')
                .setDescription(`*I-It's not like I wanted to explain this to you or anything! (¬_¬)*`)
                .addFields(
                    { name: '`!stock info @user`', value: 'View a user\'s stock price and stats', inline: false },
                    { name: '`!stock buy @user [amount]`', value: 'Buy shares (5% broker fee)', inline: false },
                    { name: '`!stock sell @user [amount]`', value: 'Sell shares (5% broker fee)', inline: false },
                    { name: '`!stock portfolio`', value: 'View your investment portfolio', inline: false },
                    { name: '`!stock market`', value: 'View market overview — top stocks, gainers, losers', inline: false },
                )
                .setFooter({ text: 'Max 200 shares per person • You can\'t buy your own stock, baka!' });
            return message.reply({ embeds: [embed] });
        }

        // !stock info @user
        if (sub === 'info') {
            const mentioned = message.mentions.users.first();
            if (!mentioned) return message.reply(`Tag someone, idiot! \`!stock info @user\` (¬_¬)`);

            const stock = await stockEngine.getOrCreateStock(mentioned.id);
            const displayName = await getDisplayName(mentioned.id, message.guild);
            const spark = miniSparkline(stock.currentPrice, stock.previousClose);

            const holding = await Portfolio.findOne({ ownerId: message.author.id, targetUserId: mentioned.id });
            const myShares = holding?.shares || 0;

            const changePct = stock.previousClose > 0
                ? ((stock.currentPrice - stock.previousClose) / stock.previousClose * 100)
                : 0;
            const changeSign = changePct >= 0 ? '+' : '';
            const changeEmoji = changePct >= 0 ? '📈' : '📉';

            const desc = [
                `**💰 Price:** \`${formatPrice(stock.currentPrice)}\`  ${changeEmoji} \`${changeSign}${changePct.toFixed(2)}%\``,
                ``,
                `📈 **High:** \`${formatPrice(stock.dailyHigh)}\`  •  📉 **Low:** \`${formatPrice(stock.dailyLow)}\``,
                `🏆 **ATH:** \`${formatPrice(stock.allTimeHigh)}\`  •  📦 **Vol:** \`${stock.volume24h}\``,
                ``,
                `👤 You own: **${myShares}/${S.MAX_SHARES_PER_USER}** shares`,
            ].join('\n');

            const embed = new EmbedBuilder()
                .setColor(stock.currentPrice >= stock.previousClose ? 0x00D166 : 0xED4245)
                .setTitle(`📊 ${displayName}'s Stock ${spark}`)
                .setThumbnail(mentioned.displayAvatarURL({ size: 128 }))
                .setDescription(desc)
                .setFooter({ text: `Broker fee: ${S.BROKER_FEE * 100}% on buy/sell` });
            return message.reply({ embeds: [embed] });
        }

        // !stock buy @user [amount]
        if (sub === 'buy') {
            const mentioned = message.mentions.users.first();
            if (!mentioned) return message.reply(`Tag who you wanna invest in! \`!stock buy @user 10\` (¬_¬)`);

            if (mentioned.bot) {
                return message.reply(`You can't buy stock of a bot, baka! Bots don't have human rights or economic values! (¬_¬)`);
            }

            if (mentioned.id === message.author.id) {
                return message.reply(`You can't buy your own stock, you narcissist! Insider trading is ILLEGAL! (¬_¬)`);
            }

            const amount = parseInt(args[args.length - 1]) || 1;
            if (amount < 1) return message.reply(`Buy at least 1 share, cheapskate! (¬_¬)`);

            // Check share cap
            const existing = await Portfolio.findOne({ ownerId: message.author.id, targetUserId: mentioned.id });
            const currentShares = existing?.shares || 0;
            if (currentShares + amount > S.MAX_SHARES_PER_USER) {
                const canBuy = S.MAX_SHARES_PER_USER - currentShares;
                return message.reply(`You already own ${currentShares} shares! Max is ${S.MAX_SHARES_PER_USER}. You can buy ${canBuy} more, baka! (¬_¬)`);
            }

            const stock = await stockEngine.getOrCreateStock(mentioned.id);
            const totalCost = Math.ceil(amount * stock.currentPrice * (1 + S.BROKER_FEE));
            const displayName = await getDisplayName(mentioned.id, message.guild);

            const embed = new EmbedBuilder()
                .setColor(0x00D166)
                .setTitle(`📈 Buy ${amount} share${amount > 1 ? 's' : ''} of ${displayName}?`)
                .setThumbnail(mentioned.displayAvatarURL({ size: 128 }))
                .setDescription([
                    `**Price/Share:** \`${formatPrice(stock.currentPrice)}\``,
                    `**Broker Fee:** \`${(S.BROKER_FEE * 100)}%\``,
                    `**Total Cost:** \`${totalCost.toLocaleString('en-US')}c\``,
                ].join('\n'))
                .setFooter({ text: `Your balance: ${user.coins.toLocaleString('en-US')}c` });

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`stock_buyConfirm_${mentioned.id}_${amount}_${message.author.id}`)
                    .setLabel('Confirm Buy')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('📈'),
                new ButtonBuilder()
                    .setCustomId(`stock_buyCancel_${message.author.id}`)
                    .setLabel('Cancel')
                    .setStyle(ButtonStyle.Secondary),
            );

            return message.reply({ embeds: [embed], components: [row] });
        }

        // !stock sell @user [amount]
        if (sub === 'sell') {
            const mentioned = message.mentions.users.first();
            if (!mentioned) return message.reply(`Tag whose stock you're dumping! \`!stock sell @user 10\` (¬_¬)`);

            const amount = parseInt(args[args.length - 1]) || 1;
            if (amount < 1) return message.reply(`Sell at least 1 share! (¬_¬)`);

            const holding = await Portfolio.findOne({ ownerId: message.author.id, targetUserId: mentioned.id });
            if (!holding || holding.shares < amount) {
                const owned = holding?.shares || 0;
                return message.reply(`You only own ${owned} shares of them! Can't sell what you don't have, baka! (¬_¬)`);
            }

            const stock = await stockEngine.getOrCreateStock(mentioned.id);
            const totalReturn = Math.floor(amount * stock.currentPrice * (1 - S.BROKER_FEE));
            const displayName = await getDisplayName(mentioned.id, message.guild);

            const embed = new EmbedBuilder()
                .setColor(0xED4245)
                .setTitle(`📉 Sell ${amount} share${amount > 1 ? 's' : ''} of ${displayName}?`)
                .setThumbnail(mentioned.displayAvatarURL({ size: 128 }))
                .setDescription([
                    `**Price/Share:** \`${formatPrice(stock.currentPrice)}\``,
                    `**Broker Fee:** \`${(S.BROKER_FEE * 100)}%\``,
                    `**You Receive:** \`${totalReturn.toLocaleString('en-US')}c\``,
                ].join('\n'));

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`stock_sellConfirm_${mentioned.id}_${amount}_${message.author.id}`)
                    .setLabel('Confirm Sell')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('📉'),
                new ButtonBuilder()
                    .setCustomId(`stock_sellCancel_${message.author.id}`)
                    .setLabel('Cancel')
                    .setStyle(ButtonStyle.Secondary),
            );

            return message.reply({ embeds: [embed], components: [row] });
        }

        // !stock portfolio
        if (sub === 'portfolio' || sub === 'pf') {
            const result = await buildPortfolioEmbed(message.author.id, message.author.displayName, message.guild, 0);

            if (result.empty) {
                return message.reply(`Your portfolio is empty! Go invest in someone, you coward! >//< \`!stock buy @user\``);
            }

            const components = result.buttons ? [result.buttons] : [];
            return message.reply({ embeds: [result.embed], components });
        }

        // !stock market
        if (sub === 'market' || sub === 'top') {
            const result = await buildMarketEmbed(message.guild, 0);

            if (result.empty) {
                return message.reply(`The market is empty! Nobody has any stock yet... go chat more! (¬_¬)`);
            }

            const components = result.buttons ? [result.buttons] : [];
            return message.reply({ embeds: [result.embed], components });
        }

        // Unknown subcommand
        return message.reply(`Unknown subcommand! Try \`!stock help\`, baka! (¬_¬)`);
    },

    handleInteraction: async (interaction, client) => {
        if (!interaction.isButton()) return;
        const id = interaction.customId;
        if (!id.startsWith('stock_') && !id.startsWith('stockpf_') && !id.startsWith('stockmkt_')) return;

        // --- Portfolio Pagination ---
        if (id.startsWith('stockpf_') && !id.endsWith('_pageinfo')) {
            await interaction.deferUpdate().catch(() => {});
            const parts = id.split('_'); // stockpf_{userId}_{page}
            const userId = parts[1];
            const targetPage = parseInt(parts[2]) || 0;

            const displayName = await getDisplayName(userId, interaction.guild);
            const result = await buildPortfolioEmbed(userId, displayName, interaction.guild, targetPage);

            if (result.empty) {
                return interaction.editReply({ content: 'Portfolio is empty now... (¬_¬)', embeds: [], components: [] });
            }

            const components = result.buttons ? [result.buttons] : [];
            return interaction.editReply({ embeds: [result.embed], components });
        }

        // --- Market Pagination ---
        if (id.startsWith('stockmkt_') && !id.endsWith('_pageinfo')) {
            await interaction.deferUpdate().catch(() => {});
            const parts = id.split('_'); // stockmkt_{_}_{page}
            const targetPage = parseInt(parts[2]) || 0;

            const result = await buildMarketEmbed(interaction.guild, targetPage);

            if (result.empty) {
                return interaction.editReply({ content: 'Market is empty... (¬_¬)', embeds: [], components: [] });
            }

            const components = result.buttons ? [result.buttons] : [];
            return interaction.editReply({ embeds: [result.embed], components });
        }

        // --- Buy Confirm ---
        if (id.startsWith('stock_buyConfirm_')) {
            const parts = id.split('_'); // stock_buyConfirm_{targetId}_{amount}_{requesterId}
            const targetId = parts[2];
            const amount = parseInt(parts[3]);
            const requesterId = parts[4];

            if (interaction.user.id !== requesterId) {
                return interaction.reply({ content: `This isn't your trade, baka! (¬_¬)`, flags: MessageFlags.Ephemeral });
            }

            // Re-fetch current price (it may have changed since the embed was shown)
            const stock = await stockEngine.getOrCreateStock(targetId);
            const totalCost = Math.ceil(amount * stock.currentPrice * (1 + S.BROKER_FEE));

            // Atomic share cap check + update: only increment if resulting shares <= MAX
            const portfolioUpdate = await Portfolio.findOneAndUpdate(
                {
                    ownerId: requesterId,
                    targetUserId: targetId,
                    $expr: { $lte: [{ $add: [{ $ifNull: ['$shares', 0] }, amount] }, S.MAX_SHARES_PER_USER] }
                },
                { $inc: { shares: amount, totalInvested: totalCost } },
                { new: true }
            );

            // If no doc matched the $expr, try upsert for new portfolio entries
            let capExceeded = false;
            if (!portfolioUpdate) {
                // Check if it's a new portfolio (no doc exists yet)
                const existing = await Portfolio.findOne({ ownerId: requesterId, targetUserId: targetId });
                if (!existing && amount <= S.MAX_SHARES_PER_USER) {
                    // New portfolio entry — safe to create
                    await Portfolio.create({ ownerId: requesterId, targetUserId: targetId, shares: amount, totalInvested: totalCost });
                } else {
                    capExceeded = true;
                }
            }

            if (capExceeded) {
                const existing = await Portfolio.findOne({ ownerId: requesterId, targetUserId: targetId });
                const currentShares = existing?.shares || 0;
                return interaction.update({ content: `Share cap exceeded! You already own ${currentShares}/${S.MAX_SHARES_PER_USER}. (¬_¬)`, embeds: [], components: [] });
            }

            // Atomic deduction — fail if not enough coins
            const buyer = await User.findOneAndUpdate(
                { userId: requesterId, coins: { $gte: totalCost } },
                { $inc: { coins: -totalCost, systemSpent: totalCost } },
                { new: true }
            );
            if (!buyer) {
                // Rollback the portfolio update
                const rolledBack = await Portfolio.findOneAndUpdate(
                    { ownerId: requesterId, targetUserId: targetId },
                    { $inc: { shares: -amount, totalInvested: -totalCost } },
                    { new: true }
                );
                if (rolledBack && rolledBack.shares <= 0) {
                    await Portfolio.deleteOne({ _id: rolledBack._id });
                }
                return interaction.update({ content: `You're too broke! Need \`${totalCost.toLocaleString('en-US')}c\` but you don't have enough! Pathetic. (¬_¬)`, embeds: [], components: [] });
            }

            // Update stock: increment shares outstanding and volume
            await Stock.findOneAndUpdate(
                { userId: targetId },
                { $inc: { sharesOutstanding: amount, volume24h: amount } }
            );

            // Apply buy pressure (+1% per transaction)
            await stockEngine.applyBuyPressure(targetId);

            const displayName = await getDisplayName(targetId, interaction.guild);
            return interaction.update({
                content: `✅ Bought **${amount}** share${amount > 1 ? 's' : ''} of **${displayName}** for \`${totalCost.toLocaleString('en-US')}c\`! D-Don't thank me for processing it! (¬_¬)`,
                embeds: [],
                components: [],
            });
        }

        // --- Sell Confirm ---
        if (id.startsWith('stock_sellConfirm_')) {
            const parts = id.split('_'); // stock_sellConfirm_{targetId}_{amount}_{requesterId}
            const targetId = parts[2];
            const amount = parseInt(parts[3]);
            const requesterId = parts[4];

            if (interaction.user.id !== requesterId) {
                return interaction.reply({ content: `This isn't your trade, baka! (¬_¬)`, flags: MessageFlags.Ephemeral });
            }

            // Atomic: deduct shares only if they have enough
            const holding = await Portfolio.findOneAndUpdate(
                { ownerId: requesterId, targetUserId: targetId, shares: { $gte: amount } },
                { $inc: { shares: -amount } },
                { new: true }
            );
            if (!holding) {
                return interaction.update({ content: `You don't have enough shares to sell! (¬_¬)`, embeds: [], components: [] });
            }

            // Reduce totalInvested proportionally (so avg price stays accurate for remaining shares)
            if (holding.shares > 0) {
                const sharesBeforeSell = holding.shares + amount;
                const investmentToRemove = Math.floor(holding.totalInvested * (amount / sharesBeforeSell));
                await Portfolio.findOneAndUpdate(
                    { ownerId: requesterId, targetUserId: targetId },
                    { $inc: { totalInvested: -investmentToRemove } }
                );
            } else {
                // Sold all shares, clean up
                await Portfolio.deleteOne({ ownerId: requesterId, targetUserId: targetId });
            }

            // Re-fetch price for payout calculation
            const stock = await stockEngine.getOrCreateStock(targetId);
            const totalReturn = Math.floor(amount * stock.currentPrice * (1 - S.BROKER_FEE));

            // Pay seller via distributeIncome — skip multipliers to prevent infinite money loops
            const log = await distributeIncome(requesterId, totalReturn, { skipMultipliers: true });

            // Update stock: decrement shares outstanding, increment volume
            await Stock.findOneAndUpdate(
                { userId: targetId },
                { $inc: { sharesOutstanding: -amount, volume24h: amount } }
            );

            // Apply sell pressure (-1% per transaction)
            await stockEngine.applySellPressure(targetId);

            const displayName = await getDisplayName(targetId, interaction.guild);
            return interaction.update({
                content: `✅ Sold **${amount}** share${amount > 1 ? 's' : ''} of **${displayName}** for \`${totalReturn.toLocaleString('en-US')}c\`! ${log}\nI-I just processed it, don't read into it! >///<`,
                embeds: [],
                components: [],
            });
        }

        // --- Cancel ---
        if (id.startsWith('stock_buyCancel_') || id.startsWith('stock_sellCancel_')) {
            const requesterId = id.split('_').pop();
            if (interaction.user.id !== requesterId) {
                return interaction.reply({ content: `Not your button! (¬_¬)`, flags: MessageFlags.Ephemeral });
            }
            return interaction.update({ content: `Trade cancelled. Smart move... maybe. (¬_¬)`, embeds: [], components: [] });
        }
    }
};
