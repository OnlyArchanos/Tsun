const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const User = require('../models/User');
require('dotenv').config();
const ServerStats = require('../models/ServerStats');
const Loan = require('../models/Loan');
const { distributeIncome } = require('../utils/income');
const config = require('../config');
const MarketListing = require('../models/MarketListing');
const Auction = require('../models/Auction');
const GACHA_TITLES = require('../config/gachaTitles');
const { DROP_TABLES, COIN_RANGES, getTimeUntilRotation } = require('../utils/gacha');
const roleSync = require('../utils/roleSync');
const Relationship = require('../models/Relationship');
const { getDisplayName } = require('../utils/helpers');
const { reapplyAllRelationshipSuffixes } = require('./social');

// Cache for daily stats reset day to run it exactly once per day
let lastStatsResetDay = null;

// ==================== !INFO PAGE BUILDERS ====================
const PAGE_NAMES = ['📊 Overview', '🎒 Loadout', '💝 Relationships', '🏆 Records'];
const PAGE_EMOJIS = ['📊', '🎒', '💝', '🏆'];

const RARITY_EMOJI = { COMMON: '⚪', RARE: '🔵', LEGENDARY: '🟡', ULTRA_RARE: '🟣', MYTHIC: '🔴' };

function buildInfoButtons(viewerId, targetId, currentPage) {
    const row = new ActionRowBuilder();
    for (let i = 0; i < 4; i++) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`info_${viewerId}_${targetId}_${i}`)
                .setLabel(PAGE_NAMES[i])
                .setStyle(i === currentPage ? ButtonStyle.Primary : ButtonStyle.Secondary)
                .setDisabled(i === currentPage)
        );
    }
    return row;
}

function formatTimeRemaining(expiryMs) {
    const remaining = expiryMs - Date.now();
    if (remaining <= 0) return null;
    const h = Math.floor(remaining / 3600000);
    const m = Math.ceil((remaining % 3600000) / 60000);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ==================== FISHING HELP BUILDERS ====================
function buildFishingDropTable() {
    const std = config.FISHING.STANDARD_DROP;
    const chr = config.FISHING.CHARTER_DROP;
    const rarities = ['JUNK', 'COMMON', 'RARE', 'UR', 'LEGENDARY', 'MYTHIC'];
    const labels = { JUNK: 'Junk', COMMON: 'Common', RARE: 'Rare', UR: 'UR', LEGENDARY: 'Legend', MYTHIC: 'Mythic' };

    const stdTotal = Object.values(std).reduce((s, e) => s + (e.chance || 0), 0);
    const chrTotal = Object.values(chr).reduce((s, e) => s + (e.chance || 0), 0);

    const fmt = (val) => val === 0 ? '  \u2014  ' : (`${val}%`).padStart(5);

    let table = '```\nRarity   \u2502 Normal \u2502 Charter\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n';
    for (const r of rarities) {
        const sRaw = std[r]?.chance || 0;
        const cRaw = chr[r]?.chance || 0;
        const sP = stdTotal > 0 ? Math.round((sRaw / stdTotal) * 100) : 0;
        const cP = chrTotal > 0 ? Math.round((cRaw / chrTotal) * 100) : 0;
        table += `${labels[r].padEnd(9)}\u2502 ${fmt(sP)}  \u2502 ${fmt(cP)}\n`;
    }
    return table + '```';
}

function buildOverviewEmbed(user, displayName, member, loan, isSelf) {
    const prestigeNames = ['None', ...config.ROLES.PRESTIGE];
    const prestigeLevel = user.prestige || 0;
    const prestigeName = prestigeNames[prestigeLevel] || `Level ${prestigeLevel}`;
    const elo = user.elo || config.ECONOMY.DEFAULT_ELO;
    const wins = user.wins || 0;
    const losses = user.losses || 0;
    const streak = user.currentDuelStreak || 0;
    const bounty = user.bounty || 0;

    const embed = new EmbedBuilder()
        .setColor(0xFF1493)
        .setTitle(`📊 ${displayName} — Overview`)
        .setThumbnail(member?.user?.displayAvatarURL() || null);

    // Public fields
    let publicText = `🏅 **Prestige:** ${prestigeName} (Lv. ${prestigeLevel})\n`;
    publicText += `⚔️ **ELO:** ${elo.toLocaleString('en-US')} | W: ${wins} / L: ${losses}`;
    if (streak > 0) publicText += ` | 🔥 ${streak} streak`;
    publicText += '\n';
    publicText += bounty > 0
        ? `🎯 **Bounty:** ${bounty.toLocaleString('en-US')} coins on their head`
        : '🎯 **Bounty:** None';

    embed.addFields({ name: '🌐 Public', value: publicText });

    if (isSelf) {
        // Wallet cap calculation (matches income.js)
        const baseCap = config.ECONOMY.BASE_WALLET_CAP;
        const extraPerLevel = config.ECONOMY.WALLET_CAP_PER_LEVEL;
        const forgeBonusCap = (user.upgrades?.walletTier || 0) * config.ECONOMY.FORGE_WALLET_CAP_PER_TIER;
        const walletCap = baseCap + (prestigeLevel * extraPerLevel) + forgeBonusCap;
        const coins = user.coins || 0;
        const fillPct = walletCap > 0 ? Math.round((coins / walletCap) * 100) : 0;

        // Vault cap
        const vaultBase = config.VAULT.BASE_CAPACITY;
        const vaultPrestige = prestigeLevel * config.VAULT.PRESTIGE_CAPACITY_MULTIPLIER;
        let vaultCap = vaultBase + vaultPrestige;
        if (user.titanVaultUsed) vaultCap *= 2;
        const vaultCoins = user.vaultCoins || 0;

        // Effective prestige bonus with decay
        const multipliers = config.ECONOMY.PRESTIGE_MULTIPLIERS;
        const mult = multipliers[prestigeLevel] || 0;
        const walletFill = walletCap > 0 ? Math.min(1, coins / walletCap) : 0;
        const decayFactor = Math.max(0, Math.min(1, 1 - ((walletFill - config.ECONOMY.PRESTIGE_DECAY_START) / config.ECONOMY.PRESTIGE_DECAY_RANGE)));
        const fullBonusPct = Math.round(mult * 100);
        const effectivePct = Math.round(mult * decayFactor * 100);

        let privateText = `💰 **Wallet:** ${coins.toLocaleString('en-US')} / ${walletCap.toLocaleString('en-US')} — ${fillPct}% full\n`;
        privateText += `💎 **Nuggets:** ${(user.nuggets || 0).toLocaleString('en-US')}\n`;
        privateText += `🏦 **Vault:** ${vaultCoins.toLocaleString('en-US')} / ${vaultCap.toLocaleString('en-US')}\n`;

        if (fullBonusPct > 0) {
            if (decayFactor < 1) {
                privateText += `🌟 **Prestige Bonus:** +${fullBonusPct}% — currently ${effectivePct}% due to wallet ${fillPct}% full\n`;
            } else {
                privateText += `🌟 **Prestige Bonus:** +${fullBonusPct}% (full strength)\n`;
            }
        }

        // Slave status
        if (user.isSlave && user.slaveOwner) {
            privateText += `⛓️ **Status:** Slave of <@${user.slaveOwner}>`;
        } else {
            privateText += '✅ **Status:** Free';
        }

        // Active debt
        if (loan) {
            privateText += `\n💸 **Debt:** ${loan.remainingAmount.toLocaleString('en-US')} remaining (${loan.status})`;
        }

        embed.addFields({ name: '🔒 Private', value: privateText });
    } else {
        embed.addFields({ name: '🔒 Private', value: '*Hidden. Creep. (¬_¬)*' });
    }

    return embed;
}

function buildLoadoutEmbed(user, displayName, isSelf) {
    const embed = new EmbedBuilder()
        .setColor(0xFFD700)
        .setTitle(`🎒 ${displayName} — Loadout`);

    // Equipped title
    const title = user.equippedTitle;
    let titleStr;
    if (title) {
        // Determine rarity
        let rarity = 'COMMON';
        for (const [r, titles] of Object.entries(GACHA_TITLES)) {
            if (titles.includes(title)) { rarity = r; break; }
        }
        titleStr = `${RARITY_EMOJI[rarity] || '⚪'} **${title}** (${rarity})`;
    } else {
        titleStr = 'No title. A blank slate. How fitting.';
    }

    const frame = user.frameColor || 'Default';
    const shield = user.equippedShield ? '✅ Active' : '❌ None';
    const coinAmulets = user.equippedAmuletCount || 0;
    const coinAmuletMult = coinAmulets > 0 ? `${coinAmulets} (${coinAmulets}× duel reward)` : 'None';
    const goldenAmulets = user.goldenAmuletCount || 0;
    const walletTier = user.upgrades?.walletTier || 0;
    const vaultTier = user.upgrades?.vaultTier || 0;
    const titanVault = user.titanVaultUsed ? '✅' : '❌';

    let publicText = `🏷️ **Title:** ${titleStr}\n`;
    publicText += `🎨 **Frame:** ${frame}\n`;
    publicText += `🛡️ **Elo Shield:** ${shield}\n`;
    publicText += `🪙 **Coin Amulets:** ${coinAmuletMult}\n`;
    publicText += `🥇 **Golden Amulets:** ${goldenAmulets}/3\n`;
    publicText += `⬆️ **Wallet Tier:** ${walletTier}/5 | **Vault Tier:** ${vaultTier}/5\n`;
    publicText += `🏛️ **Titan Vault:** ${titanVault}`;

    embed.addFields({ name: '🌐 Equipment', value: publicText });

    const pinnedFishes = user.fishing?.pinned || [];
    if (pinnedFishes.length > 0) {
        embed.addFields({ name: '📌 Pinned Fishes', value: pinnedFishes.map(p => `• ${p}`).join('\n') });
    }

    if (isSelf) {
        const effects = [];

        const bountyShield = formatTimeRemaining(user.bountyShieldExpiry || 0);
        if (bountyShield) effects.push(`🛡️ **Bounty Shield:** ${bountyShield} remaining`);

        const trashCurse = formatTimeRemaining(user.trashTasteExpiry || 0);
        if (trashCurse) effects.push(`🗑️ **Trash Curse:** ${trashCurse} remaining`);

        const mediocrity = formatTimeRemaining(user.mediocrityExpiry || 0);
        if (mediocrity) effects.push(`😐 **Mediocrity Curse:** ${mediocrity} remaining`);

        if (user.isekaiDiscountActive) effects.push('🎫 **Isekai Discount:** Ready');
        if (user.doubleDipActive) effects.push('✌️ **Double Dip:** Ready');

        const effectsText = effects.length > 0
            ? effects.join('\n')
            : '*Nothing active. Boring. (¬_¬)*';

        embed.addFields({ name: '🔒 Active Effects', value: effectsText });
    } else {
        embed.addFields({ name: '🔒 Active Effects', value: '*Hidden. Mind your own business. (¬_¬)*' });
    }

    return embed;
}

async function buildRelationshipsEmbed(user, displayName, relationships, guild) {
    const embed = new EmbedBuilder()
        .setColor(0xFF69B4)
        .setTitle(`💝 ${displayName} — Relationships`);

    const userId = user.userId;

    if (relationships.length === 0) {
        embed.setDescription('No relationships. How unsurprising. (¬_¬)');
        return embed;
    }

    // Group by status
    const married = relationships.filter(r => r.status === 'married');
    const dating = relationships.filter(r => r.status === 'dating');
    const enemies = relationships.filter(r => r.status === 'enemies');
    const notable = relationships.filter(r => r.status === 'none' && (r.shipScore || 0) >= 70)
        .sort((a, b) => (b.shipScore || 0) - (a.shipScore || 0))
        .slice(0, 5);

    // Resolve partner names in bulk
    const partnerIds = new Set();
    for (const rel of relationships) {
        const partnerId = rel.user1Id === userId ? rel.user2Id : rel.user1Id;
        partnerIds.add(partnerId);
    }
    const nameMap = new Map();
    await Promise.all(
        [...partnerIds].map(async (pid) => {
            const name = await getDisplayName(pid, guild);
            nameMap.set(pid, name);
        })
    );

    const getPartner = (rel) => {
        const pid = rel.user1Id === userId ? rel.user2Id : rel.user1Id;
        return { id: pid, name: nameMap.get(pid) || `User#${pid.slice(-4)}` };
    };

    const timeSince = (ts) => {
        if (!ts) return '???';
        const diff = Date.now() - ts;
        const days = Math.floor(diff / 86400000);
        if (days > 0) return `${days}d`;
        const hours = Math.floor(diff / 3600000);
        return `${hours}h`;
    };

    // Married
    if (married.length > 0) {
        const rel = married[0];
        const partner = getPartner(rel);
        const score = rel.shipScore ?? '??';
        const ship = rel.shipName || '???';
        const time = timeSince(rel.confirmedAt);
        const bw = rel.battleWins || 0;
        const bl = rel.battleLosses || 0;
        embed.addFields({
            name: '💍 Married',
            value: `**${partner.name}** — 💕 ${ship} (${score}%)\n⏳ Together: ${time} | ⚔️ Ship Battles: ${bw}W / ${bl}L\n*Somehow managed to trick someone into marrying them.*`
        });
    }

    // Dating
    if (dating.length > 0) {
        const rel = dating[0];
        const partner = getPartner(rel);
        const score = rel.shipScore ?? '??';
        const ship = rel.shipName || '???';
        const time = timeSince(rel.confirmedAt);
        embed.addFields({
            name: '💕 Dating',
            value: `**${partner.name}** — 💕 ${ship} (${score}%)\n⏳ Together: ${time}\n*Don't get too comfortable. (¬_¬)*`
        });
    }

    // Enemies
    if (enemies.length > 0) {
        const enemyLines = enemies.slice(0, 5).map(rel => {
            const partner = getPartner(rel);
            const score = rel.shipScore ?? '??';
            const ship = rel.shipName || '???';
            return `⚔️ **${partner.name}** — ${ship} (${score}%)`;
        });
        embed.addFields({ name: '😤 Rivals', value: enemyLines.join('\n') });
    } else {
        embed.addFields({ name: '😤 Rivals', value: 'No enemies. Either very peaceful or very forgettable. (¬_¬)' });
    }

    // Notable ships (status none, score >= 70)
    if (notable.length > 0) {
        const notableLines = notable.map(rel => {
            const partner = getPartner(rel);
            const score = rel.shipScore ?? '??';
            const ship = rel.shipName || '???';
            return `💘 **${partner.name}** — ${ship} (${score}%)`;
        });
        embed.addFields({ name: '✨ Notable Ships', value: notableLines.join('\n') });
    }

    // Recent history — last 5 events across all relationships
    const allHistory = [];
    for (const rel of relationships) {
        const partner = getPartner(rel);
        for (const ev of (rel.history || [])) {
            allHistory.push({ ...ev, partnerName: partner.name });
        }
    }
    allHistory.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const recent = allHistory.slice(0, 5);
    if (recent.length > 0) {
        const historyLines = recent.map(ev => {
            const time = timeSince(ev.timestamp);
            const note = ev.note ? ` — ${ev.note}` : '';
            return `\`${time} ago\` ${ev.event || '???'} w/ **${ev.partnerName}**${note}`;
        });
        embed.addFields({ name: '📜 Recent History', value: historyLines.join('\n') });
    }

    return embed;
}

function buildRecordsEmbed(user, displayName) {
    const embed = new EmbedBuilder()
        .setColor(0x00CED1)
        .setTitle(`🏆 ${displayName} — Records`);

    // Daily
    const currentStreak = user.dailyStreak || 0;
    const bestStreak = user.longestDailyStreak || 0;

    // Games
    const guessStreak = user.guessWinStreak || 0;
    const hlBest = user.highScore || 0;
    const opCurrent = user.opGuessStreak || 0;
    const opBest = user.opHighestStreak || 0;
    const edCurrent = user.edGuessStreak || 0;
    const edBest = user.edHighestStreak || 0;

    // Gacha
    const bestDrop = user.bestGachaDrop;
    const bestDropStr = bestDrop ? `${RARITY_EMOJI[bestDrop] || '⚪'} ${bestDrop}` : 'None yet. Skill issue? (¬_¬)';
    const pity = user.gachaPity || {};
    const bronzePity = pity.bronze || 0;
    const silverPity = pity.silver || 0;
    const goldPity = pity.gold || 0;
    const goldMythicPity = pity.goldMythic || 0;

    // Chat
    const todayMsgs = user.stats?.daily?.messages || 0;
    const allTimeMsgs = user.stats?.allTime?.messages || 0;

    // Fishing
    const fishCaught = user.fishing?.stats?.totalCaught || 0;
    const heaviest = user.fishing?.stats?.heaviestFish || 0;
    const mythics = user.fishing?.stats?.mythicsCaught || 0;

    embed.addFields(
        {
            name: '📅 Daily Streak',
            value: `Current: **${currentStreak}** | Best: **${bestStreak}**`,
            inline: true
        },
        {
            name: '🎮 Guess Game',
            value: `Streak: **${guessStreak}**`,
            inline: true
        },
        {
            name: '📈 Higher/Lower',
            value: `Best: **${hlBest}**`,
            inline: true
        },
        {
            name: '🎵 OP Guess',
            value: `Current: **${opCurrent}** | Best: **${opBest}**`,
            inline: true
        },
        {
            name: '🎶 ED Guess',
            value: `Current: **${edCurrent}** | Best: **${edBest}**`,
            inline: true
        },
        {
            name: '🎰 Best Gacha Drop',
            value: bestDropStr,
            inline: true
        },
        {
            name: '🎰 Gacha Pity',
            value: `Bronze: **${bronzePity}**/10 | Silver: **${silverPity}**/10 | Gold: **${goldPity}**/10\n🔥 Gold Mythic: **${goldMythicPity}**/50`
        },
        {
            name: '💬 Chat Stats',
            value: `Today: **${todayMsgs.toLocaleString('en-US')}** msgs | All-time: **${allTimeMsgs.toLocaleString('en-US')}** msgs`
        },
        {
            name: '🎣 Fishing Records',
            value: `Total Caught: **${fishCaught.toLocaleString('en-US')}** | Heaviest: **${heaviest.toLocaleString('en-US')}** lbs | Mythics: **${mythics.toLocaleString('en-US')}**`
        }
    );

    return embed;
}

async function buildInfoEmbed(viewerId, targetId, page, guild) {
    const isSelf = viewerId === targetId;

    // Concurrent data fetching
    const fetchPromises = [
        User.findOne({ userId: targetId }).lean(),
        guild.members.fetch(targetId).catch(() => null)
    ];

    // Relationships (for page 2 or always pre-fetch for speed)
    if (page === 2) {
        fetchPromises.push(
            Relationship.find({
                $or: [{ user1Id: targetId }, { user2Id: targetId }],
                status: { $ne: 'none' }
            }).lean()
        );
    }

    // Loan — only for self on overview page
    if (page === 0 && isSelf) {
        fetchPromises.push(
            Loan.findOne({
                borrowerId: targetId,
                status: { $in: ['ACTIVE', 'DEFAULTED'] }
            }).sort({ dueDate: 1 }).lean()
        );
    }

    const results = await Promise.all(fetchPromises);
    const user = results[0] || { userId: targetId };
    const member = results[1];
    const displayName = member?.displayName || `User#${targetId.slice(-4)}`;

    let embed;
    switch (page) {
        case 0: {
            const loan = isSelf ? (results[2] || null) : null;
            embed = buildOverviewEmbed(user, displayName, member, loan, isSelf);
            break;
        }
        case 1:
            embed = buildLoadoutEmbed(user, displayName, isSelf);
            break;
        case 2: {
            const relationships = results[2] || [];
            // Also fetch 'none' status with high ship scores for notable ships
            const notableShips = await Relationship.find({
                $or: [{ user1Id: targetId }, { user2Id: targetId }],
                status: 'none',
                shipScore: { $gte: 70 }
            }).sort({ shipScore: -1 }).limit(5).lean();
            embed = await buildRelationshipsEmbed(user, displayName, [...relationships, ...notableShips], guild);
            break;
        }
        case 3:
            embed = buildRecordsEmbed(user, displayName);
            break;
        default:
            embed = buildOverviewEmbed(user, displayName, member, null, isSelf);
    }

    // Footer
    if (!isSelf) {
        embed.setFooter({ text: `Viewing ${displayName}'s profile. Creep. (¬_¬)` });
    } else {
        embed.setFooter({ text: 'D-Don\'t stare at your own stats all day, idiot! (¬_¬)' });
    }

    const row = buildInfoButtons(viewerId, targetId, page);
    return { embed, row };
}

module.exports = {
    // --- MAIN COMMAND HANDLER ---
    handle: async (message, client) => {
        const cmd = message.content.toLowerCase().split(' ')[0];
        const args = message.content.split(' ');


// --- !RESTOREDAILYSTREAK (OWNER ONLY) ---
        if (cmd === '!restoredailystreak') {
            if (message.author.id !== config.OWNER_ID) {
                return message.reply("H-Hah? Only the owner can use this command! Know your place! >///<");
            }
            
            const target = message.mentions.users.first();
            const dayNum = parseInt(args[2]);
            
            if (!target || isNaN(dayNum) || dayNum < 0) {
                return message.reply("Usage: `!restoredailystreak @user [day number]` (¬_¬)");
            }
            
            await User.updateOne(
                { userId: target.id },
                {
                    $set: {
                        dailyStreak: dayNum,
                        longestDailyStreak: dayNum,
                        lastDailyClaim: Date.now()
                    }
                },
                { upsert: true }
            );
            
            return message.reply(`✅ Restored daily streak to **${dayNum}** for ${target.username}! I-It's not like I'm playing favorites or anything! >///<`);
        }

// --- !RESETSERVER (OWNER ONLY) ---
        if (cmd === '!resetserver') {
            if (message.author.id !== config.OWNER_ID) {
                return message.reply("H-Hah? Who do you think you are?! Only the Owner can nuke the server! (¬_¬)");
            }

            const sub = args[1]?.toLowerCase();

            // ==================== PREVIEW ====================
            if (sub === 'preview') {
                const loadMsg = await message.reply('🔍 **Calculating...** Hold on, baka. (¬_¬)');
                try {
                    const stats = await ServerStats.findOne({ guildId: message.guild.id }).lean();
                    const currentSeason = stats?.seasonNumber ?? 1;

                    const [
                        totalUsers, loanCount, auctionCount, listingCount,
                        slaveCount, botBanCount,
                        topEloUser, topGachaUser, topStreakUser, topChatterUser, topSlaveAgg
                    ] = await Promise.all([
                        User.countDocuments({}),
                        Loan.countDocuments({ status: { $in: ['ACTIVE', 'DEFAULTED'] } }),
                        Auction.countDocuments({ active: true }),
                        MarketListing.countDocuments({ expiresAt: { $gt: new Date() } }),
                        User.countDocuments({ isSlave: true }),
                        User.countDocuments({ botBanExpiry: { $gt: Date.now() } }),
                        User.findOne({ elo: { $gt: 0 } }).sort({ elo: -1 }).lean(),
                        User.findOne({ gachaBoxesOpened: { $gt: 0 } }).sort({ gachaBoxesOpened: -1 }).lean(),
                        User.findOne({ currentDuelStreak: { $gt: 0 } }).sort({ currentDuelStreak: -1 }).lean(),
                        User.findOne({ 'stats.allTime.messages': { $gt: 0 } }).sort({ 'stats.allTime.messages': -1 }).lean(),
                        User.aggregate([
                            { $match: { slaveOwner: { $ne: null }, isSlave: true } },
                            { $group: { _id: '$slaveOwner', count: { $sum: 1 } } },
                            { $sort: { count: -1 } },
                            { $limit: 1 }
                        ])
                    ]);

                    const resolveName = async (userId) => {
                        if (!userId) return null;
                        try { return (await message.guild.members.fetch(userId)).displayName; }
                        catch { return `<@${userId}>`; }
                    };

                    const formatTied = async (field, value, suffix = '') => {
                        if (!value || value === 0) return null;
                        const tied = await User.find({ [field]: value }).select('userId').lean();
                        const names = await Promise.all(tied.map(u => resolveName(u.userId)));
                        const shown = names.slice(0, 5).join(', ');
                        const extra = names.length > 5 ? ` +${names.length - 5} more` : '';
                        return `**${shown}${extra}** — ${value.toLocaleString('en-US')}${suffix}`;
                    };

                    const hofLines = [];
                    if (topEloUser?.elo > 0) {
                        const line = await formatTied('elo', topEloUser.elo, ' ELO');
                        if (line) hofLines.push(`⚔️ **Highest ELO:** ${line}`);
                    }
                    if (topGachaUser?.gachaBoxesOpened > 0) {
                        const line = await formatTied('gachaBoxesOpened', topGachaUser.gachaBoxesOpened, ' boxes');
                        if (line) hofLines.push(`🎰 **Most Gacha Boxes:** ${line}`);
                    }
                    if (topStreakUser?.currentDuelStreak > 0) {
                        const line = await formatTied('currentDuelStreak', topStreakUser.currentDuelStreak, ' streak');
                        if (line) hofLines.push(`🔥 **Longest Duel Streak:** ${line}`);
                    }
                    if (topChatterUser?.stats?.allTime?.messages > 0) {
                        const line = await formatTied('stats.allTime.messages', topChatterUser.stats.allTime.messages, ' msgs');
                        if (line) hofLines.push(`💬 **Top Chatter (All-Time):** ${line}`);
                    }
                    if (topSlaveAgg.length > 0 && topSlaveAgg[0].count > 0) {
                        const maxCount = topSlaveAgg[0].count;
                        const allTopOwners = await User.aggregate([
                            { $match: { slaveOwner: { $ne: null }, isSlave: true } },
                            { $group: { _id: '$slaveOwner', count: { $sum: 1 } } },
                            { $match: { count: maxCount } }
                        ]);
                        const ownerNames = await Promise.all(allTopOwners.map(o => resolveName(o._id)));
                        const shown = ownerNames.slice(0, 5).join(', ');
                        const extra = ownerNames.length > 5 ? ` +${ownerNames.length - 5} more` : '';
                        hofLines.push(`⛓️ **Most Slaves Owned:** **${shown}${extra}** — ${maxCount} slaves`);
                    }

                    const embed = new EmbedBuilder()
                        .setColor(0xFF6600)
                        .setTitle(`🔮 Reset Preview — Season ${currentSeason} → Season ${currentSeason + 1}`)
                        .setDescription(
                            `*Here's what WILL happen if you run \`!resetserver confirm\`. Read it carefully, baka.* (¬_¬)\n\n` +
                            `**👥 Users to reset:** ${totalUsers.toLocaleString('en-US')}\n` +
                            `**💸 Active loans to delete:** ${loanCount.toLocaleString('en-US')}\n` +
                            `**🔨 Active auctions to cancel:** ${auctionCount.toLocaleString('en-US')}\n` +
                            `**🏪 Market listings to expire:** ${listingCount.toLocaleString('en-US')}\n` +
                            `**⛓️ Slaves to free:** ${slaveCount.toLocaleString('en-US')}\n` +
                            `**🚫 Bot-bans to clear:** ${botBanCount.toLocaleString('en-US')}\n\n` +
                            (hofLines.length > 0 ? `**🏆 End-of-Season Hall of Fame:**\n${hofLines.join('\n')}\n\n` : '') +
                            `⚠️ **Coins, inventory, prestige items, vault, forge upgrades, fishing gear/inventory/biomes** will all be wiped.\n` +
                            `✅ **ELO, duel stats, alltime chat stats, gridUrl, nuggets, mythic/junk catch counts** will be preserved.\n\n` +
                            `*Type \`!resetserver confirm\` to proceed. There is no undo.*`
                        );

                    return loadMsg.edit({ content: null, embeds: [embed] });
                } catch (e) {
                    console.error('RESET PREVIEW ERROR:', e);
                    return loadMsg.edit({ content: '❌ Preview failed! Check console. >////<', embeds: [] });
                }
            }

            // ==================== CONFIRM ====================
            if (sub !== 'confirm') {
                return message.reply(
                    "⚠️ **WARNING:** This will WIPE EVERYTHING and start a new season.\n\n" +
                    "Run `!resetserver preview` first to see exactly what will happen.\n" +
                    "Then type `!resetserver confirm` if you are absolutely sure, you maniac!"
                );
            }

            const startTime = Date.now();
            const progress = await message.reply('⏳ **Season Reset Initiated...**\n`Step 1/6` — Capturing Hall of Fame...');
            const edit = (text) => progress.edit({ content: text, embeds: [] }).catch(() => {});

            try {
                // ── STEP 1: Capture Hall of Fame ──────────────────────────────────────
                const stats = await ServerStats.findOne({ guildId: message.guild.id }).lean();
                const currentSeason = stats?.seasonNumber ?? 1;

                const resolveName = async (userId) => {
                    if (!userId) return null;
                    try { return (await message.guild.members.fetch(userId)).displayName; }
                    catch { return `<@${userId}>`; }
                };

                const formatTied = async (field, value, suffix = '') => {
                    if (!value || value === 0) return null;
                    const tied = await User.find({ [field]: value }).select('userId').lean();
                    const names = await Promise.all(tied.map(u => resolveName(u.userId)));
                    const shown = names.slice(0, 5).join(', ');
                    const extra = names.length > 5 ? ` +${names.length - 5} more` : '';
                    return `**${shown}${extra}** — ${value.toLocaleString('en-US')}${suffix}`;
                };

                let hofLines = [];
                try {
                    const [topEloUser, topGachaUser, topStreakUser, topChatterUser, topSlaveAgg] = await Promise.all([
                        User.findOne({ elo: { $gt: 0 } }).sort({ elo: -1 }).lean(),
                        User.findOne({ gachaBoxesOpened: { $gt: 0 } }).sort({ gachaBoxesOpened: -1 }).lean(),
                        User.findOne({ currentDuelStreak: { $gt: 0 } }).sort({ currentDuelStreak: -1 }).lean(),
                        User.findOne({ 'stats.allTime.messages': { $gt: 0 } }).sort({ 'stats.allTime.messages': -1 }).lean(),
                        User.aggregate([
                            { $match: { slaveOwner: { $ne: null }, isSlave: true } },
                            { $group: { _id: '$slaveOwner', count: { $sum: 1 } } },
                            { $sort: { count: -1 } },
                            { $limit: 1 }
                        ])
                    ]);
                    if (topEloUser?.elo > 0) {
                        const line = await formatTied('elo', topEloUser.elo, ' ELO');
                        if (line) hofLines.push(`⚔️ **Highest ELO:** ${line}`);
                    }
                    if (topGachaUser?.gachaBoxesOpened > 0) {
                        const line = await formatTied('gachaBoxesOpened', topGachaUser.gachaBoxesOpened, ' boxes');
                        if (line) hofLines.push(`🎰 **Most Gacha Boxes:** ${line}`);
                    }
                    if (topStreakUser?.currentDuelStreak > 0) {
                        const line = await formatTied('currentDuelStreak', topStreakUser.currentDuelStreak, ' streak');
                        if (line) hofLines.push(`🔥 **Longest Duel Streak:** ${line}`);
                    }
                    if (topChatterUser?.stats?.allTime?.messages > 0) {
                        const line = await formatTied('stats.allTime.messages', topChatterUser.stats.allTime.messages, ' msgs');
                        if (line) hofLines.push(`💬 **Top Chatter (All-Time):** ${line}`);
                    }
                    if (topSlaveAgg.length > 0 && topSlaveAgg[0].count > 0) {
                        const maxCount = topSlaveAgg[0].count;
                        const allTopOwners = await User.aggregate([
                            { $match: { slaveOwner: { $ne: null }, isSlave: true } },
                            { $group: { _id: '$slaveOwner', count: { $sum: 1 } } },
                            { $match: { count: maxCount } }
                        ]);
                        const ownerNames = await Promise.all(allTopOwners.map(o => resolveName(o._id)));
                        const shown = ownerNames.slice(0, 5).join(', ');
                        const extra = ownerNames.length > 5 ? ` +${ownerNames.length - 5} more` : '';
                        hofLines.push(`⛓️ **Most Slaves Owned:** **${shown}${extra}** — ${maxCount} slaves`);
                    }

                    // --- OVERLORD CALCULATION ---
                    const topOverlord = await User.aggregate([
                        { $match: { $or: [{ systemEarned: { $gt: 0 } }, { systemSpent: { $gt: 0 } }] } },
                        { $project: { userId: 1, score: { $floor: { $pow: [ { $add: [{ $ifNull: ["$systemEarned", 0] }, { $ifNull: ["$systemSpent", 0] }] }, 1/3 ] } } } },
                        { $sort: { score: -1 } },
                        { $limit: 1 }
                    ]);

                    if (topOverlord.length > 0 && topOverlord[0].score > 0) {
                        const winnerId = topOverlord[0].userId;
                        const score = topOverlord[0].score;
                        const winnerName = await resolveName(winnerId);
                        hofLines.push(`👑 **Season Overlord:** **${winnerName}** — ${score.toLocaleString('en-US')} OP`);

                        try {
                            const roleName = `Season ${currentSeason} Overlord`;
                            let overlordRole = message.guild.roles.cache.find(r => r.name === roleName);
                            if (!overlordRole) {
                                overlordRole = await message.guild.roles.create({
                                    name: roleName,
                                    color: '#010101',
                                    hoist: false,
                                    reason: `Season ${currentSeason} Reset — Overlord Title`
                                });
                            }
                            const winnerMember = await message.guild.members.fetch(winnerId).catch(() => null);
                            if (winnerMember) {
                                await winnerMember.roles.add(overlordRole);
                            }
                        } catch (roleErr) {
                            console.error("Failed to grant Overlord role:", roleErr);
                        }
                    }

                } catch (hofErr) {
                    console.warn('RESET: HoF capture failed (non-fatal):', hofErr.message);
                    hofLines = [];
                }

                // ── STEP 2: Delete collections ────────────────────────────────────────
                await edit('⏳ **Season Reset In Progress...**\n`Step 2/6` — Deleting loans, auctions, and listings...');

                let loanDel = 0, auctionDel = 0, listingDel = 0;
                try {
                    const [lr, ar, mr] = await Promise.all([
                        Loan.deleteMany({}),
                        Auction.deleteMany({}),
                        MarketListing.deleteMany({})
                    ]);
                    loanDel = lr.deletedCount;
                    auctionDel = ar.deletedCount;
                    listingDel = mr.deletedCount;
                } catch (e) {
                    console.error('RESET STEP 2 FAILED:', e);
                    return edit(`❌ **ABORTED at Step 2.** Collection delete failed — no user data was changed.\nError: ${e.message}`);
                }

                // ── STEP 3: ServerStats reset ─────────────────────────────────────────
                await edit('⏳ **Season Reset In Progress...**\n`Step 3/6` — Resetting server stats...');

                await ServerStats.updateOne(
                    { guildId: message.guild.id },
                    {
                        $set: {
                            weeklyCoinCount: 0,
                            weeklyClaimers: [],
                            lastDailyTax: 0,
                            weeklyGoal: config.ECONOMY.WEEKLY_GOAL ?? 10000000,
                            weeklyRewardAmount: config.ECONOMY.WEEKLY_REWARD_COINS ?? 2000,
                            lastWeeklyReset: Date.now(),
                            goalAnnouncedThisWeek: false
                        },
                        $inc: { seasonNumber: 1 }
                    },
                    { upsert: true }
                );

                // ── STEP 4: Reset all user documents ─────────────────────────────────
                await edit('⏳ **Season Reset In Progress...**\n`Step 4/6` — Resetting user documents...');

                const allUsers = await User.find({}).lean();
                let userUpdateCount = 0;

                if (allUsers.length > 0) {
                    const bulkOps = allUsers.map(u => ({
                        updateOne: {
                            filter: { _id: u._id },
                            update: {
                                $set: {
                                    coins: config.ECONOMY.SEASON_START_COINS,
                                    nuggets: 0,
                                    nuggetDuelMilestone: 0,
                                    bounty: 0,
                                    activeBounties: [],
                                    inventory: [],
                                    lastHourly: 0,
                                    isSlave: false,
                                    slaveOwner: null,
                                    slaveIncomeGenerated: 0,
                                    masterIncomeFromSlaves: 0,
                                    'activeCarrot.amount': 0,
                                    'activeCarrot.bonusPerHr': 0,
                                    'activeCarrot.expiresAt': 0,
                                    'activeCarrot.ownerId': null,
                                    carrotResistUsed: false,
                                    resistExpiresAt: 0,
                                    totalCarrotsSpent: 0,
                                    equippedTitle: null,
                                    frameColor: null,
                                    equippedShield: false,
                                    equippedAmuletCount: 0,
                                    strippedRoles: [],
                                    forcedNickname: null,
                                    trashTasteExpiry: 0,
                                    bountyShieldExpiry: 0,
                                    botBanExpiry: 0,
                                    mediocrityExpiry: 0,
                                    isekaiDiscountActive: false,
                                    doubleDipActive: false,
                                    gachaBoxesOpened: 0,
                                    gachaTotalSpent: 0,
                                    bestGachaDrop: null,
                                    gachaPityCounter: 0,
                                    'gachaPity.bronze': 0,
                                    'gachaPity.silver': 0,
                                    'gachaPity.gold': 0,
                                    // NOTE: gachaPity.goldMythic intentionally NOT reset — mythic pity survives seasons
                                    merchantPrices: new Map(),
                                    merchantLastRefresh: 0,
                                    merchantDailySold: 0,
                                    merchantFreeRefreshUsed: false,
                                    vaultCoins: 0,
                                    vaultDailyWithdrawn: 0,
                                    lastVaultInterest: 0,
                                    lastActiveTime: 0,
                                    guessWinStreak: 0,
                                    guessTimeoutExpiry: 0,
                                    'upgrades.walletTier': 0,
                                    'upgrades.vaultTier': 0,
                                    goldenAmuletCount: 0,
                                    titanVaultUsed: false,
                                    lastRatTargets: [],
                                    'stats.weekly.messages': 0,
                                    prestige: 0,
                                    systemEarned: 0,
                                    systemSpent: 0,
                                    // --- FISHING RESET ---
                                    'fishing.inventory': [],
                                    'fishing.gear.activeRod': 'flimsy_stick',
                                    'fishing.gear.rodDurability': 0,
                                    'fishing.gear.activeBait': 'none',
                                    'fishing.gear.baitCount': 0,
                                    'fishing.gear.ownedRods': {},
                                    'fishing.biome': 'shallow_pond',
                                    'fishing.collection': [],
                                    'fishing.pinned': [],
                                    'fishing.dailyBounty.targetBiome': null,
                                    'fishing.dailyBounty.targetRarity': null,
                                    'fishing.dailyBounty.amountNeeded': 0,
                                    'fishing.dailyBounty.amountCaught': 0,
                                    'fishing.dailyBounty.rewardTier': null,
                                    'fishing.dailyBounty.expiresAt': 0,
                                    'fishing.cooldown': 0,
                                    'fishing.charterCooldown': 0,
                                    'fishing.stats.totalCaught': 0,
                                    'fishing.stats.heaviestFish': 0
                                    // NOTE: fishing.stats.mythicsCaught and junkCaught intentionally NOT reset — lifetime stats
                                }
                            }
                        }
                    }));

                    try {
                        await User.bulkWrite(bulkOps);
                        userUpdateCount = allUsers.length;
                    } catch (e) {
                        console.error('RESET STEP 4 bulkWrite FAILED:', e);
                        await edit(`⚠️ **Step 4 partial failure.** bulkWrite errored: ${e.message}\nContinuing with remaining steps...`);
                        await new Promise(r => setTimeout(r, 2000));
                    }
                }

                // ── STEP 5: Discord roles + nicknames ─────────────────────────────────
                await edit('⏳ **Season Reset In Progress...**\n`Step 5/6` — Processing Discord roles and nicknames...');

                const allGachaTitles = [
                    ...GACHA_TITLES.COMMON, ...GACHA_TITLES.RARE,
                    ...GACHA_TITLES.LEGENDARY, ...GACHA_TITLES.ULTRA_RARE, ...GACHA_TITLES.MYTHIC
                ];
                const roleNamesToRemove = [
                    ...config.ROLES.PRESTIGE,
                    ...allGachaTitles,
                    config.ROLES.SUGAR_DADDY, config.ROLES.SUGAR_MOMMY, config.ROLES.GAMBLING
                ];

                const guild = message.guild;
                let members;
                try {
                    members = await guild.members.fetch();
                } catch (e) {
                    console.error('RESET STEP 5: member fetch failed', e);
                    members = guild.members.cache;
                }

                // O(1) lookup for forced nickname check
                const userMap = new Map(allUsers.map(u => [u.userId, u]));
                let roleSuccesses = 0, roleFailures = 0, nickSuccesses = 0, nickFailures = 0;

                for (const [, member] of members) {
                    if (member.user.bot) continue;

                    // Role stripping
                    try {
                        const rolesToStrip = member.roles.cache.filter(r =>
                            roleNamesToRemove.some(n => n.toLowerCase() === r.name.toLowerCase())
                        );
                        if (rolesToStrip.size > 0) {
                            let roleFailed = false;
                            await member.roles.remove(rolesToStrip).catch(e => {
                                roleFailed = true;
                                roleFailures++;
                                console.warn(`RESET: role strip failed for ${member.user.tag}: ${e.message}`);
                            });
                            if (!roleFailed) roleSuccesses++;
                        }
                    } catch (e) {
                        roleFailures++;
                    }

                    // Slave suffix cleanup
                    try {
                        if (member.nickname && member.nickname.includes("'s Slave)")) {
                            const cleaned = member.nickname.replace(/\s\([^)]*'s Slave\)$/, '');
                            if (cleaned !== member.nickname && member.manageable) {
                                let nickFailed = false;
                                await member.setNickname(cleaned).catch(e => {
                                    nickFailed = true;
                                    nickFailures++;
                                    console.warn(`RESET: nickname clear failed for ${member.user.tag}: ${e.message}`);
                                });
                                if (!nickFailed) nickSuccesses++;
                            }
                        }
                    } catch (e) {
                        nickFailures++;
                    }

                    // Forced nickname clearing
                    try {
                        const uData = userMap.get(member.id);
                        if (uData?.forcedNickname && member.manageable) {
                            let nickFailed = false;
                            await member.setNickname(null).catch(e => {
                                nickFailed = true;
                                nickFailures++;
                            });
                            if (!nickFailed) nickSuccesses++;
                        }
                    } catch (e) {
                        nickFailures++;
                    }
                }

                // ── STEP 6: Post Hall of Fame to #general ──────────────────────────────
                await edit('⏳ **Season Reset In Progress...**\n`Step 6/6` — Posting season summary...');

                const generalChannel = guild.channels.cache.find(c => c.name === config.CHANNELS.GENERAL);
                if (generalChannel && hofLines.length > 0) {
                    try {
                        const hofEmbed = new EmbedBuilder()
                            .setColor(0xFFD700)
                            .setTitle(`🏆 Season ${currentSeason} — Hall of Fame`)
                            .setDescription(
                                `*The season has ended. These degenerates distinguished themselves:*\n\n` +
                                hofLines.join('\n') +
                                `\n\n*Season ${currentSeason + 1} begins now. Try harder this time. (¬_¬)*`
                            );
                        await generalChannel.send({ embeds: [hofEmbed] });
                    } catch (e) {
                        console.warn('RESET: HoF post failed:', e.message);
                    }
                }

                // ── FINAL: completion summary ──────────────────────────────────────────
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                const warnings = [];
                if (roleFailures > 0) warnings.push(`⚠️ ${roleFailures} role operation(s) failed`);
                if (nickFailures > 0) warnings.push(`⚠️ ${nickFailures} nickname operation(s) failed`);

                await edit(
                    `✅ **Season ${currentSeason} → Season ${currentSeason + 1} Reset Complete!** (${elapsed}s)\n\n` +
                    `💾 **${userUpdateCount}** users reset\n` +
                    `💸 **${loanDel}** loans deleted\n` +
                    `🔨 **${auctionDel}** auctions cancelled\n` +
                    `🏪 **${listingDel}** market listings cleared\n` +
                    `🎨 **${roleSuccesses}** role cleanups\n` +
                    `📛 **${nickSuccesses}** nicknames cleared\n` +
                    (warnings.length > 0 ? `\n${warnings.join('\n')}` : '\n✅ No errors.') +
                    `\n\n*Everyone starts fresh. Don't waste it, bakas. >////<*`
                );

            } catch (e) {
                console.error('RESET CONFIRM FATAL ERROR:', e);
                await edit(`❌ **Fatal error during reset.**\nError: ${e.message}\nCheck console for details.`);
            }

            return;
        }

        // --- !GOAL (Check Weekly Progress + Owner can set target/reward) ---
        if (cmd === '!goal') {
            const args = message.content.split(' ');
            const sub = args[1]?.toLowerCase();

            try {
                const stats = await ServerStats.findOne({ guildId: message.guild.id }) ||
                    await ServerStats.create({ guildId: message.guild.id });

                // --- SET TARGET (Owner Only) ---
                if (sub === 'target') {
                    if (message.author.id !== config.OWNER_ID) return message.reply("H-Hah? Only the Owner can set the target! Know your place! (¬_¬)");

                    const amount = parseInt(args[2]?.replace(/,/g, '')); // Allow commas in numbers
                    if (isNaN(amount) || amount < config.ECONOMY.MIN_WEEKLY_GOAL) return message.reply(`Set a valid target! Minimum ${config.ECONOMY.MIN_WEEKLY_GOAL.toLocaleString('en-US')} coins. Usage: \`!goal target 10000000\``);

                    stats.weeklyGoal = amount;
                    await stats.save();

                    return message.reply(`✅ **Weekly Goal Target set to:** \`${amount.toLocaleString('en-US')} Coins\``);
                }

                // --- SET REWARD (Owner Only) ---
                if (sub === 'reward') {
                    if (message.author.id !== config.OWNER_ID) return message.reply("H-Hah? Only the Owner can set the reward! Know your place! (¬_¬)");

                    const rewardAmount = parseInt(args[2]?.replace(/,/g, '')); // Allow commas in numbers
                    if (isNaN(rewardAmount) || rewardAmount < config.ECONOMY.MIN_WEEKLY_REWARD) return message.reply(`Set a valid reward amount! Minimum ${config.ECONOMY.MIN_WEEKLY_REWARD.toLocaleString('en-US')} coins. Usage: \`!goal reward 10000\``);

                    stats.weeklyRewardAmount = rewardAmount;
                    await stats.save();

                    return message.reply(`✅ **Weekly Goal Reward set to:** \`${rewardAmount.toLocaleString('en-US')} Coins\``);
                }

                // --- VIEW GOAL (Anyone can use) ---
                const progress = stats.weeklyCoinCount || 0;
                const goal = stats.weeklyGoal || 10000000; // Default: 10M
                const percentage = Math.min(100, Math.floor((progress / goal) * 100));

                const barLength = 20;
                const filledLength = Math.floor((percentage / 100) * barLength);
                const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);

                const embed = new EmbedBuilder()
                    .setColor(percentage >= 100 ? 0x00FF00 : 0xFF6600)
                    .setTitle("🎯 Weekly Server Goal")
                    .setDescription(
                        `📅 **Week Ends:** <t:${Math.floor(((stats.lastWeeklyReset || Date.now()) + 604800000) / 1000)}:R>\n\n` +
                        `💰 **Progress:** ${progress.toLocaleString('en-US')} / ${goal.toLocaleString('en-US')} Coins\n\n` +
                        `[${bar}] **${percentage}%**\n\n` +
                        (percentage >= 100
                            ? `✅ **GOAL MET!** Use \`!claimweekly\` to get your reward!`
                            : `⏳ Keep earning to unlock \`!claimweekly\`!`)
                    )
                    .addFields(
                        { name: '🎁 Reward', value: '`2,000 Coins + 1 Nugget`', inline: false }
                    )
                    .setFooter({ text: "Every coin earned by the server counts toward this goal!" });

                // Goal-met announcement (one-time per week, fire-and-forget)
                if (percentage >= 100 && !stats.goalAnnouncedThisWeek) {
                    stats.goalAnnouncedThisWeek = true;
                    await stats.save();
                    const generalChannel = message.guild.channels.cache.find(c => c.name === config.CHANNELS.GENERAL);
                    if (generalChannel) {
                        const goalEmbed = new EmbedBuilder()
                            .setColor(0x00FF00)
                            .setTitle('🎯 SERVER GOAL REACHED!')
                            .setDescription(`Type \`!claimweekly\` to collect your **${(config.ECONOMY.WEEKLY_REWARD_COINS || 2000).toLocaleString('en-US')} coin** reward! (¬_¬)`);
                        generalChannel.send({ embeds: [goalEmbed] }).catch(() => {});
                    }
                }

                return message.reply({ embeds: [embed] });
            } catch (e) {
                console.error("Goal Error:", e);
                return message.reply("Failed to fetch goal data! T-This isn't my fault! >///< ");
            }
        }

        // --- !CLAIMWEEKLY (Reward for Meeting Goal) ---
        if (cmd === '!claimweekly') {
            try {
                const stats = await ServerStats.findOne({ guildId: message.guild.id }) ||
                    await ServerStats.create({ guildId: message.guild.id });

                const progress = stats.weeklyCoinCount || 0;
                const goal = stats.weeklyGoal || 10000000;

                // 1. CHECK IF GOAL IS MET
                if (progress < goal) {
                    return message.reply(`🚫 **NOT YET!**\n\nThe server has only earned **${progress.toLocaleString('en-US')} / ${goal.toLocaleString('en-US')}** coins this week!\n\nKeep grinding, losers! (¬_¬)`);
                }

                // 2. CHECK IF USER ALREADY CLAIMED
                if (stats.weeklyClaimers.includes(message.author.id)) {
                    return message.reply("You already claimed your weekly reward, you greedy bastard! One per person! >///<");
                }

                // 3. ATOMIC CLAIM MARK (prevents double-claim races)
                const claimWrite = await ServerStats.updateOne(
                    {
                        _id: stats._id,
                        weeklyClaimers: { $ne: message.author.id },
                        weeklyCoinCount: { $gte: goal }
                    },
                    { $addToSet: { weeklyClaimers: message.author.id } }
                );

                if (claimWrite.modifiedCount === 0) {
                    const latest = await ServerStats.findOne({ _id: stats._id }).lean();
                    const latestProgress = latest?.weeklyCoinCount || 0;
                    const latestGoal = latest?.weeklyGoal || goal;
                    if (latestProgress < latestGoal) {
                        return message.reply(`🚫 **NOT YET!**\n\nThe server has only earned **${latestProgress.toLocaleString('en-US')} / ${latestGoal.toLocaleString('en-US')}** coins this week!\n\nKeep grinding, losers! (¬_¬)`);
                    }
                    return message.reply("You already claimed your weekly reward, you greedy bastard! One per person! >///<");
                }

                // 4. GIVE REWARD — dynamically scale from config
                const reward = config.ECONOMY.WEEKLY_REWARD_COINS || 2000;
                const baseNuggets = config.ECONOMY.WEEKLY_REWARD_NUGGETS || 1;
                const log = await distributeIncome(message.author.id, reward);

                // Stretch goal check (2× the target)
                let stretchBonus = '';
                let nuggetReward = baseNuggets;
                if (progress >= goal * 2) {
                    nuggetReward = baseNuggets * 2;
                    stretchBonus = `\n🌟 **BONUS: +${baseNuggets.toLocaleString('en-US')} Nugget${baseNuggets > 1 ? 's' : ''}** for stretch goal! >////<`;
                }

                await User.findOneAndUpdate(
                    { userId: message.author.id },
                    { $inc: { nuggets: nuggetReward } },
                    { upsert: true }
                );

                const embed = new EmbedBuilder()
                    .setColor(0xFFD700)
                    .setTitle("🎁 WEEKLY REWARD CLAIMED!")
                    .setDescription(`Y-You earned it, I guess... The server hit the goal, so here!\n\n💰 **+${reward.toLocaleString('en-US')} Coins**${log}\n🪙 **+${baseNuggets.toLocaleString('en-US')} Nugget${baseNuggets > 1 ? 's' : ''}**${stretchBonus}`)
                    .setFooter({ text: "Don't spend it all at once, idiot!" });

                return message.reply({ embeds: [embed] });

            } catch (e) {
                console.error("Claim Error:", e);
                return message.reply("Claim failed! T-This isn't my fault! >///<");
            }
        }


        // --- !INFO and !RELS ---
        if (cmd === '!info') {
            const target = message.mentions.users.first() || message.author;
            try {
                const { embed, row } = await buildInfoEmbed(message.author.id, target.id, 0, message.guild);
                return message.reply({ embeds: [embed], components: [row] });
            } catch (e) {
                console.error('[INFO] Error building profile:', e);
                return message.reply("S-Something broke while looking up that profile! It's NOT my fault! >///< Try again!");
            }
        }

        if (cmd === '!rels' || cmd === '!relationships') {
            const target = message.mentions.users.first() || message.author;
            try {
                const { embed, row } = await buildInfoEmbed(message.author.id, target.id, 2, message.guild);
                return message.reply({ embeds: [embed], components: [row] });
            } catch (e) {
                console.error('[RELS] Error building relationships page:', e);
                return message.reply("S-Something broke while looking up relationships! It's NOT my fault! >///< Try again!");
            }
        }

        // --- !HELP (Main Menu) ---
        if (cmd === '!help') {
            const menu = new StringSelectMenuBuilder()
                .setCustomId('help_menu')
                .setPlaceholder('📖 Select a category...')
                .addOptions(
                    new StringSelectMenuOptionBuilder().setLabel('Earning & Wallet').setValue('help_earning').setDescription('Free coins, hourly income, wallet cap, bag').setEmoji('💰'),
                    new StringSelectMenuOptionBuilder().setLabel('Vault').setValue('help_vault').setDescription('Deposit, withdraw, interest, limits').setEmoji('🏦'),
                    new StringSelectMenuOptionBuilder().setLabel('Forge & Nuggets').setValue('help_forge').setDescription('Nuggets, upgrades, forge shop').setEmoji('⬆️'),
                    new StringSelectMenuOptionBuilder().setLabel('Duels & Battles').setValue('help_duels').setDescription('Taste battles, ELO, grid profile, rewards').setEmoji('⚔️'),
                    new StringSelectMenuOptionBuilder().setLabel('Betting').setValue('help_betting').setDescription('Duel betting, pools, payouts, refunds').setEmoji('💸'),
                    new StringSelectMenuOptionBuilder().setLabel('Games & Gambling').setValue('help_games').setDescription('Toss, slots, roulette').setEmoji('🎲'),
                    new StringSelectMenuOptionBuilder().setLabel('Gacha System').setValue('help_gacha').setDescription('Boxes, titles, drop rates, pity').setEmoji('🎰'),
                    new StringSelectMenuOptionBuilder().setLabel('Gacha Items').setValue('help_gacha_items').setDescription('Every gacha item explained in detail').setEmoji('🎟️'),
                    new StringSelectMenuOptionBuilder().setLabel('Anime Games').setValue('help_anime_games').setDescription('Guess OP/ED, Higher or Lower, score guess').setEmoji('🎮'),
                    new StringSelectMenuOptionBuilder().setLabel('Shop & Items').setValue('help_shop').setDescription('Frames, items, curses, services').setEmoji('🛍️'),
                    new StringSelectMenuOptionBuilder().setLabel('Bounty System').setValue('help_bounty').setDescription('Place, view, and remove bounties').setEmoji('🎯'),
                    new StringSelectMenuOptionBuilder().setLabel('Loans & Slavery').setValue('help_loans').setDescription('Lending, defaulting, becoming enslaved').setEmoji('⛓️'),
                    new StringSelectMenuOptionBuilder().setLabel('Slave Management').setValue('help_slave').setDescription('Carrot system, resist, snatcher, tools').setEmoji('🥕'),
                    new StringSelectMenuOptionBuilder().setLabel('Prestige (Isekai)').setValue('help_prestige').setDescription('Reset for permanent income multipliers').setEmoji('🚚'),
                    new StringSelectMenuOptionBuilder().setLabel('Daily & Weekly').setValue('help_daily').setDescription('Daily streak, freeze, weekly goal').setEmoji('📅'),
                    new StringSelectMenuOptionBuilder().setLabel('Taxes & Rules').setValue('help_taxes').setDescription('Every tax, fee, and rule explained').setEmoji('💸'),
                    new StringSelectMenuOptionBuilder().setLabel('Social & Relationships').setValue('help_social').setDescription('Interactions, ships, marriage, elections').setEmoji('💝'),
                    new StringSelectMenuOptionBuilder().setLabel('Trading').setValue('help_trade').setDescription('Peer-to-peer item trades').setEmoji('🔄'),
                    new StringSelectMenuOptionBuilder().setLabel('Marketplace').setValue('help_market').setDescription('List and buy items from players').setEmoji('🏪'),
                    new StringSelectMenuOptionBuilder().setLabel('Stock Market').setValue('help_stocks').setDescription('How to trade player stocks on the website').setEmoji('📈'),
                    new StringSelectMenuOptionBuilder().setLabel('Leaderboards').setValue('help_leaderboards').setDescription('All rankings and stat boards').setEmoji('🏆'),
                    new StringSelectMenuOptionBuilder().setLabel('Profile & Relationships').setValue('help_profile').setDescription('!info, !rels, your full player card').setEmoji('📊'),
                    new StringSelectMenuOptionBuilder().setLabel('Fishing — How It Works').setValue('help_fishing').setDescription('Commands, drop rates, how to get rich from fish').setEmoji('🎣'),
                    new StringSelectMenuOptionBuilder().setLabel('Fishing — Gear & World').setValue('help_fishing_gear').setDescription('Rods, bait, biomes, quests, selling').setEmoji('🌊'),
                );

            const row = new ActionRowBuilder().addComponents(menu);

            const embed = new EmbedBuilder()
                .setColor(0xFF1493)
                .setTitle("📖 Tsun Bot — Help Menu")
                .setThumbnail(client.user.displayAvatarURL())
                .setDescription(
                    "*...Fine. I'll help you. Don't make this weird.* (¬_¬)\n\n" +
                    "Pick a category from the dropdown. Everything is in here — no excuses for being lost.\n\n" +
                    "**Quick Commands:**\n" +
                    "`!free` • `!daily` • `!bag` • `!vault` • `!forge` • `!shop` • `!equip`\n" +
                    "`!duel` • `!gacha` • `!loan` • `!slave` • `!auction` • `!freedom`\n" +
                    "`!trade` • `!market` • `!bounty` • `!wanted` • `!toss` • `!slots` • `!rr`\n" +
                    "`!hl` • `!guess` • `!hug` • `!ship` • `!fish` • `!lb` • `!goal`\n" +
                    "`!info` • `!rels`"
                )
                .setFooter({ text: "D-Don't stare at me while you read this!" });

            return message.reply({ embeds: [embed], components: [row] });
        }


    },

    // --- INTERACTION HANDLER ---
    handleInteraction: async (interaction, client) => {
        // --- INFO PAGE NAVIGATION (buttons) ---
        if (interaction.isButton() && interaction.customId.startsWith('info_')) {
            const parts = interaction.customId.split('_');
            // info_{viewerId}_{targetId}_{page}
            if (parts.length !== 4) return;
            const [, viewerId, targetId, pageStr] = parts;
            const page = parseInt(pageStr);
            if (isNaN(page) || page < 0 || page > 3) return;

            // Only the viewer can navigate
            if (interaction.user.id !== viewerId) {
                return interaction.reply({ content: "This isn't your profile panel! Get your own with `!info`! (¬_¬)", flags: MessageFlags.Ephemeral });
            }

            try {
                const { embed, row } = await buildInfoEmbed(viewerId, targetId, page, interaction.guild);
                await interaction.update({ embeds: [embed], components: [row] });
            } catch (e) {
                console.error('[INFO] Button interaction error:', e);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: "S-Something broke! Try again! >///< ", flags: MessageFlags.Ephemeral }).catch(() => {});
                }
            }
            return;
        }

        if (!interaction.isStringSelectMenu()) return;
        // --- HELP MENU NAVIGATION ---
        if (interaction.customId === 'help_menu') {
            const val = interaction.values[0];
            const embed = new EmbedBuilder()
                .setColor(0xFF1493)
                .setThumbnail(client.user.displayAvatarURL());
            if (val === 'help_earning') {
                embed.setTitle('💰 Earning & Wallet')
                    .setDescription("*I-It's not like I WANT you to be rich or anything. But here's how money works around here. Pay attention.* (¬_¬)")
                    .addFields(
                        {
                            name: '💵 `!free` — Claim Free Coins',
                            value: 'Claim **0.1%** of your wallet (min 80 coins).\nCooldown scales with wealth:\n' +
                                '• < 100k → **1 hour** | > 100k → **4 hours** | > 1M → **12 hours**\n' +
                                "*I'm not running a charity for millionaires! Be grateful! (¬_¬)*"
                        },
                        {
                            name: '💬 Passive Idle Income (Automatic)',
                            value: 'Every hour, you earn coins based on your weekly chat rank:\n' +
                                `Rank 1: **${config.IDLE_COINS.RANK_1}**/hr | Rank 2: **${config.IDLE_COINS.RANK_2}**/hr | Rank 3: **${config.IDLE_COINS.RANK_3}**/hr\n` +
                                `Rank 4-5: **${config.IDLE_COINS.RANK_4_5}**/hr | Rank 6-10: **${config.IDLE_COINS.RANK_6_10}**/hr | Rank 11-30: **${config.IDLE_COINS.RANK_11_30}**/hr\n` +
                                `Rank 31-50: **${config.IDLE_COINS.RANK_31_50}**/hr | Rank 51-100: **${config.IDLE_COINS.RANK_51_100}**/hr | Everyone: **${config.IDLE_COINS.DEFAULT}**/hr\n` +
                                '*Talk more. Earn more. Not complicated, baka.*'
                        },
                        {
                            name: '👜 Coin Bag Drops',
                            value: 'Random bags drop in **#tsun** every 10–18 messages. First click wins everything.\n*Don\'t blink. Don\'t hesitate. Just grab it.*'
                        },
                        {
                            name: '💳 Wallet Cap',
                            value: `Base: **${config.ECONOMY.BASE_WALLET_CAP.toLocaleString('en-US')}** coins\n` +
                                `+**${(config.ECONOMY.WALLET_CAP_PER_LEVEL / 1000000).toFixed(0)}M** per Prestige level (up to +595M at Prestige 7)\n` +
                                '+**40,000,000** per Forge Wallet Tier (up to +400M at Tier 10)\n' +
                                'Anything above cap is **BURNED** instantly. Use `!bag` to check.'
                        },
                        {
                            name: '📦 `!bag` / `!inventory`',
                            value: 'View wallet balance, nuggets, equipped items, active effects, and all inventory. Paginated with arrow buttons.'
                        }
                    );
            }
            else if (val === 'help_vault') {
                const interest = (config.VAULT.INTEREST_RATE * 100).toFixed(0);
                const withdrawLimit = (config.VAULT.WITHDRAWAL_LIMIT * 100).toFixed(0);
                const baseCap = config.VAULT.BASE_CAPACITY.toLocaleString('en-US');
                const prestigeBonus = (config.VAULT.PRESTIGE_CAPACITY_MULTIPLIER / 1000000).toFixed(0);
                embed.setTitle('🏦 The Vault System')
                    .setDescription("*Tch! Fine, I'll explain. The vault is the ONLY place your coins are safe from taxes and the `!tax` command. Put your money here before I take it. Not that I... want you to be poor or anything.* >////<")
                    .addFields(
                        {
                            name: '📝 Commands',
                            value: '`!vault` — Check balance, withdrawal limit, and interest status\n' +
                                '`!vault deposit <amount>` (or `dep`) — Move coins into vault\n' +
                                '`!vault withdraw <amount>` (or `with`) — Pull coins out (slowly!)'
                        },
                        {
                            name: `📈 Daily Interest (${interest}%)`,
                            value: `Earn **${interest}% compound interest** every **24 hours**.\n` +
                                '⚠️ **Condition:** Send at least **1 message** per 24h window to receive interest.\n' +
                                "*I'm not rewarding ghosts. Exist in this server or get nothing. (¬_¬)*\n" +
                                "⚠️ Once the vault is full, interest stops — excess is burned."
                        },
                        {
                            name: '💰 Vault Capacity',
                            value: `Base: **${baseCap}** coins\n` +
                                `+**${prestigeBonus}M** per Prestige level\n` +
                                '+**5,000,000** per Forge Vault Tier (up to +25M at Tier 5)\n' +
                                '**2×** total capacity if you own the **Titan Vault** from the Forge shop'
                        },
                        {
                            name: `📉 Withdrawal Limit (${withdrawLimit}%)`,
                            value: `Max withdrawal: **${withdrawLimit}%** of vault balance per 24 hours.\n` +
                                '*To stop you from blowing it all in one gambling session, you addict. Be grateful.*'
                        },
                        {
                            name: '🛡️ What the Vault Protects Against',
                            value: '• Daily wealth tax\n• Owner\'s `!tax` command\n' +
                                '⚠️ Rich Tax still applies when you **withdraw** and earn income\n' +
                                '⚠️ Slaves **CANNOT** use the vault (pay your debts first, pathetic)'
                        }
                    );
            }
            else if (val === 'help_fishing') {
                embed.setTitle('\ud83c\udfa3 Fishing System \u2014 `!fish` / `!fih`')
                    .setColor(0x1E90FF)
                    .setDescription(
                        "*S-So you wanna be a fisher now? Don't come crying to me when you pull nothing but boots and trash...* >///< \n\n" +
                        "Cast your line, catch fish, stuff them in your bucket, sell them for coins. " +
                        "Better rods, better bait, and faster reflexes = more money. It's not rocket science, baka."
                    )
                    .addFields(
                        {
                            name: '\ud83c\udfae Commands',
                            value:
                                '> `!fish` \u2014 Cast your line! Free, **10s** cooldown\n' +
                                '> `!fish charter` \u2014 High-roller cast. Cost scales with wallet (see below), **1h** cooldown\n' +
                                '> `!fish travel` \u2014 Travel to new biomes\n' +
                                '> `!fish bag` \u2014 View your bucket, lock & pin fish\n' +
                                '> `!fish sell <rarity|all>` \u2014 Sell your catches\n' +
                                '> `!fish trade @user` — Trade locked fish\n' +
                                '> `!fish quest` \u2014 Daily bounty quest\n' +
                                '> `!fish repair [rod_name]` \u2014 Fix your active or specified rod\n' +
                                '> `!shop` \u2192 **Fishing Gear** for rods & bait'
                        },
                        {
                            name: '\u200b',
                            value: '\u2500\u2500\u2500 **\u2728 How Fishing Works** \u2500\u2500\u2500'
                        },
                        {
                            name: '\ud83d\udc1f Fish Rarities',
                            value:
                                '\ud83d\uddd1\ufe0f **Junk** \u2014 Literal garbage. Worth almost nothing. *Like your taste.*\n' +
                                '\ud83d\udc1f **Common** \u2014 Basic fish. Bread and butter income\n' +
                                '\ud83d\udc21 **Rare** \u2014 Now we\'re getting somewhere!\n' +
                                '\ud83e\udd88 **Ultra Rare** \u2014 Actually impressive. *N-Not that I care...*\n' +
                                '\ud83d\udc09 **Legendary** \u2014 Extremely rare. Big money\n' +
                                '\ud83d\udc51 **Mythic** \u2014 Charter & Golden Worm only. Life-changing pulls'
                        },
                        {
                            name: '\ud83d\udcca Drop Rates',
                            value: buildFishingDropTable() +
                                '*Bait and biomes shift these rates in your favor~ Check the **Gear & World** page for details!*'
                        },
                        {
                            name: '\u200b',
                            value: '\u2500\u2500\u2500 **\ud83d\udcb0 Value & Speed** \u2500\u2500\u2500'
                        },
                        {
                            name: '\u26a1 Reaction Speed Bonus',
                            value:
                                '> \u26a1 Under **1s** \u2014 **1.5x** value! *S-Show off...*\n' +
                                '> \u2705 Under **2.5s** \u2014 **1.0x** (normal)\n' +
                                '> \u26a0\ufe0f Under **4s** \u2014 **0.6x** (sluggish)\n' +
                                '> \ud83d\udc80 Over **4s** \u2014 **0.3x** (pathetic)\n\n' +
                                '*Miss the 5s window entirely? Cast fails. Bait and charter fees? Gone. Skill issue.* (\u00ac_\u00ac)'
                        },
                        {
                            name: '\ud83d\udcb5 How Fish Value Works',
                            value:
                                '> \ud83d\udcc8 Fish value **scales with your wallet** \u2014 richer = bigger base rewards\n' +
                                '> \ud83c\udfa3 **Better rods** multiply your fish value (up to **7x** with Abyssal Rod!)\n' +
                                '> \u26a1 **Faster reactions** = higher value multiplier\n' +
                                '> \ud83c\udfb2 Each fish gets a random \u00b120% value swing\n\n' +
                                '*Charter & Golden Worm fish use a separate, juicier value table. High risk, high reward~*'
                        },
                        {
                            name: '\ud83d\udea2 Normal vs Charter vs Golden',
                            value:
                                '> \ud83c\udfa3 **Normal** (`!fish`) \u2014 Free! No Mythic drops, but steady income\n' +
                                '> \ud83d\udea2 **Charter** (`!fish charter`) \u2014 Scales with wallet, 1h cooldown, includes \ud83d\udc51 Mythic\n' +
                                '> \ud83c\udf1f **Golden Worm** \u2014 Costs **1 Nugget**, replaces the table with **90% Legendary / 10% Mythic**. *D-Don\'t waste it if your reflexes are trash!* >///< '
                        },
                        {
                            name: '\ud83d\udea2 Charter Cost (scales with wallet)',
                            value:
                                '```\n' +
                                'Your Wallet       Cost\n' +
                                '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
                                'Under 50,000      1,000\n' +
                                '50,000+           5,000\n' +
                                '100,000+          10,000\n' +
                                '500,000+          50,000\n' +
                                '1,000,000+        100,000\n' +
                                '5,000,000+        500,000\n' +
                                '200,000,000+      1,000,000\n' +
                                '```' +
                                '*Fee is charged upfront. Miss the reel? Still charged. Reflexes or wallet \u2014 pick your poison.* (\u00ac_\u00ac)'
                        },
                        {
                            name: '\ud83d\udce6 Selling & Income',
                            value:
                                'Fish sit in your bucket until you sell them with `!fish sell`.\n' +
                                'Coins from selling go through the normal income pipeline \u2014 prestige bonus, slave tax, loan repayment, all of it.\n\n' +
                                '*No, you can\'t dodge taxes by being a fisherman. Nice try, baka.* (\u00ac_\u00ac)'
                        },
                        {
                            name: '🤝 Fish Trading',
                            value:
                                'Need a specific fish for a quest or want to sell a Mythic to another player? Use `!fish trade @user` to swap fish.\n' +
                                '> 🔒 **Only LOCKED fish can be traded!** (Go to `!fish bag` and lock them first!)\n\n' +
                                '*A-And don\'t come crying to me if you let some smooth-talker scam you out of your best catches! I won\'t reverse the trade!* >///<'
                        }
                    );
                try {
                    return await interaction.update({ embeds: [embed] });
                } catch (e) {
                    if (e.code !== 10062 && e.code !== 40060) console.error('[HELP] Error updating fishing help:', e);
                    return;
                }
            }
            else if (val === 'help_fishing_gear') {
                const rods = config.FISHING.GEAR.RODS;
                const biomes = config.FISHING.BIOMES;
                const baits = config.FISHING.GEAR.BAITS;

                embed.setTitle('\ud83c\udf0a Fishing \u2014 Gear & World')
                    .setColor(0x00CED1)
                    .setDescription(
                        "*This is where it gets serious. Your rod isn't just for show \u2014 it changes how much your fish are worth, " +
                        "where you can go, and how long before it snaps in half.* (\u00ac_\u00ac)\n\n" +
                        "Buy gear from `!shop` \u2192 **Fishing Gear**. Don't be cheap about it."
                    )
                    .addFields(
                        {
                            name: '\ud83c\udf8b Rods',
                            value:
                                Object.values(rods).map(rod => {
                                    const cost = rod.cost > 0 ? `**${rod.cost}** \ud83d\udc8e` : '**Free**';
                                    const dur = Number.isFinite(rod.maxDurability) ? `${rod.maxDurability} uses` : '\u221e';
                                    const repair = rod.repairCost > 0 ? `${rod.repairCost} \ud83d\udc8e to repair` : '';
                                    return `${rod.emoji} **${rod.name}** \u2014 ${cost} | **${rod.mult}x** value | ${dur}${repair ? ' | ' + repair : ''}`;
                                }).join('\n') +
                                '\n\n*Better rods = your fish are worth WAY more. The Abyssal Rod is 7x value... if you can afford it~*' +
                                '\n*Once you buy a rod, you own it forever (until season reset). Use `!equip` / `!unequip` to switch between rods anytime!*'
                        },
                        {
                            name: '\ud83d\udd27 Durability',
                            value:
                                'Rods wear down when you catch fish. Rarer catches = more wear:\n' +
                                '> \ud83d\uddd1\ufe0f Junk **0** \u00b7 \ud83d\udc1f Common **1** \u00b7 \ud83d\udc21 Rare **2** \u00b7 \ud83e\udd88 UR **5** \u00b7 \ud83d\udc09 Legendary **12** \u00b7 \ud83d\udc51 Mythic **30**\n\n' +
                                'Missed casts cost **1 durability** too. When it breaks, you\'re auto-swapped to the Flimsy Stick — but the rod stays in your inventory with 0 durability.\n' +
                                '*Use `!fish repair` to fix your active rod. You can also repair a specific rod with `!fish repair <rod_name>`. If you have the Flimsy Stick equipped, it will automatically find and repair any broken rod in your inventory!* (\u00ac_\u00ac)'
                        },
                        {
                            name: '\u200b',
                            value: '\u2500\u2500\u2500 **\ud83e\udeb1 Bait** \u2500\u2500\u2500'
                        },
                        {
                            name: '\ud83e\udeb1 Bait Types',
                            value:
                                `\ud83e\udeb1 **Worm x10** \u2014 ${baits.worm.costBase.toLocaleString('en-US')}c base (scales with wallet)\n` +
                                `> ${baits.worm.description}\n\n` +
                                `\u2728 **Glow Worm x10** \u2014 ${baits.glow_worm.costBase.toLocaleString('en-US')}c base (scales with wallet)\n` +
                                `> ${baits.glow_worm.description} *The expensive stuff is worth it... probably.* >///< \n\n` +
                                `\ud83c\udf1f **Golden Worm x1** \u2014 **${baits.golden_worm.costNuggets} Nugget** \ud83d\udc8e\n` +
                                `> ${baits.golden_worm.description} Replaces table with 90% Legendary / 10% Mythic.\n` +
                                '*Don\'t miss the catch or you just wasted a nugget, baka!*'
                        },
                        {
                            name: '\u200b',
                            value: '\u2500\u2500\u2500 **\ud83d\uddfa\ufe0f Biomes** \u2500\u2500\u2500'
                        },
                        {
                            name: '\ud83d\uddfa\ufe0f Biomes & Travel',
                            value:
                                Object.values(biomes).map(biome => {
                                    const rodName = rods[biome.reqRod]?.name || 'Flimsy Stick';
                                    const unlock = biome.reqCatches > 0 ? `${biome.reqCatches} catches` : 'Start here!';
                                    const cost = biome.travelCost > 0 ? `${biome.travelCost.toLocaleString('en-US')}c+ to travel` : 'Free';
                                    return `${biome.emoji} **${biome.name}** \u2014 ${unlock}\n> \ud83c\udf8b Needs **${rodName}** \u00b7 ${cost}\n> *${biome.description}*`;
                                }).join('\n\n') +
                                '\n\n*Later biomes cut junk rates and boost rare drops. Worth the trip~* Use `!fish travel` to move!'
                        },
                        {
                            name: '\u200b',
                            value: '\u2500\u2500\u2500 **\ud83d\udce6 Bucket & Selling** \u2500\u2500\u2500'
                        },
                        {
                            name: '\ud83d\udce6 Your Bucket',
                            value:
                                `Your bucket holds up to **${config.FISHING.MAX_INVENTORY}** fish. Full bucket = new catches get thrown back.\n\n` +
                                '> \ud83d\udd12 **Lock** fish in `!fish bag` to protect them from bulk sells\n' +
                                '> \ud83d\udccc **Pin** up to **5** fish to show off on your `!info` profile\n' +
                                '> \ud83d\udcb0 `!fish sell all` \u2014 sell everything unlocked\n' +
                                '> \ud83d\udcb0 `!fish sell <rarity>` \u2014 sell just one rarity type\n\n' +
                                '*Selling goes through income pipeline \u2014 taxes, slave cuts, the whole thing. No free rides.* (\u00ac_\u00ac)'
                        },
                        {
                            name: '\u200b',
                            value: '\u2500\u2500\u2500 **\ud83d\udccb Daily Quests** \u2500\u2500\u2500'
                        },
                        {
                            name: '\ud83d\udccb Fishing Bounties',
                            value:
                                '`!fish quest` gives you a daily bounty \u2014 catch specific fish, get bonus rewards!\n\n' +
                                '> \ud83d\udfe2 **Easy** \u2014 Catch **5-10 Rare** fish \u2192 **2x** coin reward\n' +
                                '> \ud83d\udfe1 **Medium** \u2014 Catch **3-5 UR** fish \u2192 **5x** coins + 50% nugget chance\n' +
                                '> \ud83d\udd34 **Hard** \u2014 Catch **1-2 Legendary/Mythic** \u2192 **10x** coins + **2 guaranteed nuggets** \ud83d\udc8e\n\n' +
                                '*D-Don\'t skip your dailies... not that I\'m worried about you or anything!* >///< '
                        },
                        {
                            name: '\ud83c\udfc6 Leaderboards',
                            value:
                                '> `!lb fish` \u2014 Most total catches\n' +
                                '> `!lb heavy` \u2014 Heaviest single fish\n\n' +
                                '*Pinned fish show on your `!info` too, so everyone can admire your wet trophies~* (\u00ac_\u00ac)'
                        }
                    );
                try {
                    return await interaction.update({ embeds: [embed] });
                } catch (e) {
                    if (e.code !== 10062 && e.code !== 40060) console.error('[HELP] Error updating fishing gear help:', e);
                    return;
                }
            }
            else if (val === 'help_forge') {
                embed.setTitle('⬆️ Forge & Nuggets — `!forge`')
                    .setDescription("*Nuggets are the premium currency around here and they don't grow on trees. Spend them wisely or I'll judge you.* (¬_¬)")
                    .addFields(
                        {
                            name: '💎 How to Earn Nuggets',
                            value: '• **Duel wins:** +1 Nugget every **5 cumulative wins**\n' +
                                '• **Daily streak:** Day 60 (+1), Day 100 (+2), every 30 after (+1)\n' +
                                '• **Weekly goal:** +1 from `!claimweekly` (bonus +1 if stretch goal hit)\n' +
                                '• **Prestige 7 (Master):** +3 Nuggets one-time bonus\n' +
                                'Check balance: `!bag` or `!forge`'
                        },
                        {
                            name: '⬆️ Wallet Upgrades — `!forge wallet`',
                            value: '+**40,000,000** to wallet cap per tier (max Tier 10 = +400M total)\n' +
                                'Tier 1–3: **2 Nuggets** each | Tier 4–5: **4 Nuggets** | Tier 6–7: **5 Nuggets** | Tier 8–9: **6 Nuggets** | Tier 10: **8 Nuggets**\n' +
                                'Total to max: **44 Nuggets**'
                        },
                        {
                            name: '⬆️ Vault Upgrades — `!forge vault`',
                            value: '+**5,000,000** to vault cap per tier (max Tier 5 = +25M total)\n' +
                                'Tier 1–3: **2 Nuggets** each | Tier 4–5: **3 Nuggets** each\n' +
                                'Total to max: **12 Nuggets**'
                        },
                        {
                            name: '🛒 Forge Nugget Shop — `!forge` → Shop',
                            value: '🥇 **Golden Amulet** (5💎) — +0.2× income multiplier. Stack up to 3. Bonus fades near wallet cap (same as prestige).\n' +
                                '🏛️ **Titan Vault** (5💎) — Doubles total vault capacity permanently.\n' +
                                '💳 **Debt Forgiveness** (8💎) — Instantly wipes active loan + frees from slavery.'
                        }
                    );
            }
            else if (val === 'help_duels') {
                embed.setTitle('⚔️ Taste Battle System')
                    .setDescription("*Test your taste against others. Don't embarrass yourself. I'm watching.* (¬_¬)")
                    .addFields(
                        {
                            name: '🖼️ Creating Your Profile',
                            value: '`!duel` (with image attached) — Upload a 3×3 grid to create your profile.\n' +
                                '`!duel stats` / `!duel stats @user` — View profile, ELO, win/loss record.'
                        },
                        {
                            name: '⚔️ Starting a Duel',
                            value: '`!duel @user` — Challenge someone (needs a profile).\n' +
                                '`!duel random` — Random opponent, 1h cooldown per opponent.\n' +
                                '60-second voting window. Min **2 votes** required or match is cancelled and bets refunded.'
                        },
                        {
                            name: '📊 ELO System',
                            value: 'Standard Elo formula, **K=32**.\n' +
                                '🛡️ **Elo Shield** — Negates Elo loss on next defeat (consumed).\n' +
                                '🔥 **Trash Curse** — Halves target\'s Elo gain, doubles their loss for 24h.'
                        },
                        {
                            name: '💰 Duel Rewards (Wealth-Scaled)',
                            value: 'Formula: `Base + 80 + (Loser Elo ÷ 5)`\n' +
                                '**Base by Wallet:** < 10k: **250** | 10k+: **1,000** | 50k+: **10,000**\n' +
                                '100k+: **15,000** | 500k+: **20,000** | 1M+: **30,000**\n' +
                                '🪙 **Amulets:** multiply win reward. ALL consumed on win.\n' +
                                '⚔️ **Rivals** (`!rivals @user`): +50% ELO and higher rewards.'
                        },
                        { name: '💎 Nugget Milestone', value: 'Every **5 cumulative duel wins** → +1 Nugget.' }
                    );
            }
            else if (val === 'help_betting') {
                embed.setTitle('💸 Battle Betting')
                    .setDescription("*S-So you want to gamble on other people's duels too? Fine. Just don't cry to me when you pick the loser.* (¬_¬)")
                    .addFields(
                        {
                            name: '🎰 How to Bet',
                            value: 'During any active duel, click the **💸 Gamble** button before the 60s window ends.\nChoose a fighter and enter your bet. Coins deducted immediately.'
                        },
                        {
                            name: '💰 Payouts',
                            value: 'Winners share the entire losing pool proportionally to bet size.\nOnly **profit** (not stake) goes through Rich Tax / income system.'
                        },
                        {
                            name: '🔄 Refund Conditions',
                            value: 'Full refund if:\n• Tie result\n• Match cancelled (< 2 votes)\n• Nobody bet on the winning side\n' +
                                'One-sided pools: stake returned, zero profit possible.'
                        },
                        {
                            name: '⚠️ Notes',
                            value: 'Cannot bet on your own duel. One bet per match per person.'
                        }
                    );
            }
            else if (val === 'help_games') {
                embed.setTitle('🎲 Games & Gambling')
                    .setDescription("*I can't stop you from throwing your coins away. Just... don't come crying to me afterwards.* >////<\n⚠️ All gambling commands only work in **#tsun** and **#tsun-alt**.")
                    .addFields(
                        {
                            name: '🪙 `!toss h/t <amount>` — Coin Toss',
                            value: 'Choice **FIRST**, amount **SECOND**. Accepts h/t or heads/tails. `all` to bet everything.\n' +
                                '✨ **Jackpot** (~0.5–2%): Win **3×** bet as profit\n' +
                                '💸 **Sewer** (~4–6%): Coin lost to drain (house edge)\n' +
                                '😈 **Rigged** (~2–14%): Forced opposite of your pick (scales with wealth)\n' +
                                '🎯 **Normal flip:** Standard result\n' +
                                "*The richer you are, the more the coin hates you.* (¬_¬)"
                        },
                        {
                            name: '🎰 `!slots <amount>` — Slot Machine',
                            value: 'Min **10**, Max **100,000** coins. 3s cooldown.\n' +
                                'Symbols: ❤️‍🩹 ✌️ 🔥 🥀 💔 🙏\n' +
                                '🃏 Any pair → **2×** | Triple → **3×** | 🔥🔥🔥 → **5×** | 🙏🙏🙏 → **10×**\n' +
                                '❌ No match → you lose everything.'
                        },
                        {
                            name: '🔫 `!rr <bet>` — Russian Roulette (Progressive)',
                            value: `*You wanna play with your life? Fine. Don't say I didn't warn you, baka.* (¬_¬)\n` +
                                `Bet **${config.ROULETTE.MIN_BET.toLocaleString('en-US')}**–**${config.ROULETTE.MAX_BET.toLocaleString('en-US')}** coins (or \`all\`). Survive **5 rounds** of escalating danger — cash out or push your luck!\n\n` +
                                `🔫 **The Cylinder:**\n` +
                                `> R1: **${config.ROULETTE.ROUNDS[1].bullets}**/6 bullets → **${config.ROULETTE.ROUNDS[1].mult}×** *(baby mode, even YOU can survive this)*\n` +
                                `> R2: **${config.ROULETTE.ROUNDS[2].bullets}**/6 bullets → **${config.ROULETTE.ROUNDS[2].mult}×** + 1 min mute on death\n` +
                                `> R3: **${config.ROULETTE.ROUNDS[3].bullets}**/6 bullets → **${config.ROULETTE.ROUNDS[3].mult}×** + 5 min mute *(50/50... feeling lucky?)*\n` +
                                `> R4: **${config.ROULETTE.ROUNDS[4].bullets}**/6 bullets → **${config.ROULETTE.ROUNDS[4].mult}×** + 30 min mute *(pure greed territory)*\n` +
                                `> R5: **${config.ROULETTE.ROUNDS[5].bullets}**/6 bullets → **${config.ROULETTE.ROUNDS[5].mult}×** + 2 hr mute + 🎰 **JACKPOT POOL**\n\n` +
                                `💀 **Death** = lose your bet + get muted. The further you go, the longer you shut up.\n` +
                                `💰 **Cash Out** anytime after surviving a round. You have **${config.ROULETTE.BUTTON_TIMEOUT / 1000}s** to decide or I auto-cashout for you!\n` +
                                `🎰 **Jackpot** = ${(config.ROULETTE.JACKPOT_CONTRIBUTION * 100).toFixed(0)}% of every bet feeds the pool. Survive all 5? It's ALL yours. *N-Not that anyone ever has...* >///< `
                        }
                    );
            }
            else if (val === 'help_gacha') {
                const formatTitles = (arr) => arr.map((t, i) => (i === arr.length - 1 ? '┗ ' : '┣ ') + '`' + t + '`').join('\n');
                const rarityEmojis = { COMMON: '⚪', RARE: '🔵', LEGENDARY: '🟡', ULTRA_RARE: '🟣', MYTHIC: '🔴' };
                const rarityNames = { COMMON: 'COMMON', RARE: 'RARE', LEGENDARY: 'LEGENDARY', ULTRA_RARE: 'ULTRA RARE', MYTHIC: 'MYTHIC' };
                const tsundereComments = {
                    COMMON: '*Basic stuff for basic people like you~*',
                    RARE: '*N-Not bad, I guess...*',
                    LEGENDARY: '*Okay, NOW we\'re talking! These are actually rare!*',
                    ULTRA_RARE: '*I-If you get one of these, you\'re actually lucky!* >////<',
                    MYTHIC: '*T-These are almost IMPOSSIBLE to get! Don\'t even dream about it, baka!*'
                };

                // Build dynamic drop rate table from actual DROP_TABLES
                const dropRows = [
                    { key: 'coins', label: 'Coins' }, { key: 'common_title', label: 'Common' },
                    { key: 'rare_title', label: 'Rare' }, { key: 'legendary_title', label: 'Legendary' },
                    { key: 'ultra_rare_title', label: 'Ultra Rare' }, { key: 'mythic_title', label: 'Mythic' },
                    { key: 'amulet', label: 'Amulet' }, { key: 'elo_shield', label: 'Elo Shield' },
                    { key: 'freedom_ticket', label: 'Freedom Tix' }, { key: 'bounty_shield', label: 'Bounty Shld' },
                    { key: 'double_dip', label: 'Double Dip' }, { key: 'debt_eraser', label: 'Debt Eraser' },
                    { key: 'slave_snatcher', label: 'Snatcher' }, { key: 'isekai_discount', label: 'Isekai Disc' },
                    { key: 'nugget', label: 'Nugget' }
                ];
                const fmt = (v) => v === undefined ? '  —   ' : (v + '%').padStart(5) + ' ';
                let rateTable = '```\nDrop        │ Brnz │ Slvr │ Gold\n────────────┼──────┼──────┼──────\n';
                for (const r of dropRows) {
                    const b = fmt(DROP_TABLES.bronze[r.key]);
                    const s = fmt(DROP_TABLES.silver[r.key]);
                    const g = fmt(DROP_TABLES.gold[r.key]);
                    rateTable += r.label.padEnd(12) + '│' + b + '│' + s + '│' + g + '\n';
                }
                rateTable += '```';

                const goldPrice = `**${config.GACHA_BOX_PRICES.gold.BASE.toLocaleString('en-US')}** + ${(config.GACHA_BOX_PRICES.gold.WALLET_RATE * 100).toFixed(0)}% of wallet (max ${config.GACHA_BOX_PRICES.gold.MAX?.toLocaleString('en-US') || 'uncapped'})`;

                embed.setTitle('🎰 Gacha System — `!gacha`')
                    .setDescription("*So you want to gamble for titles. Fine. The odds are not in your favour and I absolutely did not design it that way on purpose.* >////<")
                    .addFields(
                        {
                            name: '🎁 Box Types & Prices',
                            value: `💰 \`!gacha bronze\` — **${config.GACHA_BOX_PRICES.bronze.toLocaleString('en-US')}** coins\n` +
                                `💎 \`!gacha silver\` — **${config.GACHA_BOX_PRICES.silver.toLocaleString('en-US')}** coins\n` +
                                `👑 \`!gacha gold\` — ${goldPrice}\n` +
                                'Use `!gacha silver`/`gold` to consume a box from inventory instead of coins.'
                        },
                        {
                            name: '🎯 Pity System',
                            value: '🔵 Every **10 pulls** → guaranteed **Rare+** drop (Bronze/Silver) or **Ultra Rare+** (Gold).\n' +
                                '🔴 Every **50 Gold pulls** → guaranteed **MYTHIC** drop! (hard pity)\n' +
                                '🔥 **Soft Pity** kicks in at pull 40+ — Mythic rate escalates!\n' +
                                'Counters reset when the guaranteed rarity drops. Mythic pity survives season resets.\n' +
                                'Check your pity with `!gacha` dashboard. *D-Don\'t say I never help you! (¬_¬)*'
                        },
                        ...(config.GACHA_FEATURED?.enabled && config.GACHA_FEATURED.title ? [{
                            name: config.GACHA_FEATURED.bannerLabel,
                            value: (() => {
                                const rotMs = getTimeUntilRotation();
                                const rotHours = Math.floor(rotMs / 3600000);
                                const rotMins = Math.floor((rotMs % 3600000) / 60000);
                                const rotText = rotMs > 0 ? `⏰ Rotates in **${rotHours}h ${rotMins}m**` : '⏰ Rotating soon...';
                                return config.GACHA_FEATURED.bannerDescription + `\n${rotText} — *Featured title changes every 3 days! H-Hurry up before it rotates, baka!*`;
                            })()
                        }] : []),
                        ...Object.keys(GACHA_TITLES).map(rarity => ({
                            name: `${rarityEmojis[rarity]} ${rarityNames[rarity]} Titles (${GACHA_TITLES[rarity].length})`,
                            value: formatTitles(GACHA_TITLES[rarity]) + '\n' + tsundereComments[rarity]
                        })),
                        { name: '📊 Drop Rates by Box', value: rateTable },
                        {
                            name: '💵 Coin Ranges & Duplicates',
                            value: `💰 Bronze: **${COIN_RANGES.bronze[0].toLocaleString('en-US')}** – **${COIN_RANGES.bronze[1].toLocaleString('en-US')}**\n` +
                                `💎 Silver: **${COIN_RANGES.silver[0].toLocaleString('en-US')}** – **${COIN_RANGES.silver[1].toLocaleString('en-US')}**\n` +
                                `👑 Gold: **${COIN_RANGES.gold[0].toLocaleString('en-US')}** – **${COIN_RANGES.gold[1].toLocaleString('en-US')}**\n` +
                                `♻️ Dupes: ⚪**${config.DUPLICATE_FALLBACK.COMMON.toLocaleString('en-US')}** | 🔵**${config.DUPLICATE_FALLBACK.RARE.toLocaleString('en-US')}** | 🟡**${(config.DUPLICATE_FALLBACK.LEGENDARY/1000).toFixed(0)}k** | 🟣**${(config.DUPLICATE_FALLBACK.ULTRA_RARE/1000).toFixed(0)}k** | 🔴**${(config.DUPLICATE_FALLBACK.MYTHIC/1000).toFixed(0)}k**`
                        },
                        {
                            name: '⚠️ Curse of Mediocrity',
                            value: 'If active, gacha restricted to coins + common titles only for 24h.\nApplied by `!curse mediocrity @user`. Check status in `!bag`.'
                        },
                        {
                            name: '🎟️ Items?',
                            value: '*Want to know what each item does? Check the **Gacha Items** page in this menu, idiot!* (¬_¬)'
                        }
                    );
            }
            else if (val === 'help_gacha_items') {
                embed.setTitle('🎟️ Gacha Items — Detailed Guide')
                    .setDescription("*Ugh, fine. I'll explain EVERY item you can pull from gacha. Pay attention because I'm NOT repeating myself!* (¬_¬)")
                    .addFields(
                        {
                            name: '🪙 Coin Amulet',
                            value: 'Multiplies your duel win income. Stack up to **50** via `!equip` — choose how many to equip.\n' +
                                '**ALL** equipped amulets are consumed on your next duel **win**. Losses don\'t consume them.\n' +
                                'Stacking formula has diminishing returns at higher counts.\n' +
                                '*Hoard them if you dare. Just don\'t cry when they\'re all gone in one fight.* (¬_¬)'
                        },
                        {
                            name: '🛡️ Elo Shield',
                            value: 'Equip via `!equip`. When you **lose** a duel, the shield absorbs the Elo loss — your rating stays unchanged.\n' +
                                'Consumed on the loss. Only 1 active at a time. Does NOT affect your opponent\'s Elo gain.\n' +
                                '*One free L. Don\'t waste it on some random nobody.* (¬_¬)'
                        },
                        {
                            name: '🎟️ Slave Freedom Ticket',
                            value: 'Use `!freedom` while enslaved. Removes your slave tag and frees you from your master.\n' +
                                '⚠️ **Requires your debt to be fully paid first!** It won\'t wipe your loan — it only removes the slave status after you\'ve already repaid everything.\n' +
                                '*Pay what you owe first, freeloader! I\'m not running a charity!* (¬_¬)'
                        },
                        {
                            name: '🛡️ Bounty Shield',
                            value: 'Equip via `!equip`. Blocks **ALL** new bounties placed on you for **48 hours**.\n' +
                                'Existing bounties are NOT removed — this only prevents new ones.\n' +
                                'Consumed on activation. Check remaining time in `!bag`.\n' +
                                '*Sleep easy for two days... assuming nobody already has a hit out on you.* (¬_¬)'
                        },
                        {
                            name: '✌️ Double Dip',
                            value: 'Equip via `!equip` to activate. Your very next income payout is **doubled** — the base amount is 2× before prestige bonuses and taxes apply.\n' +
                                'Auto-consumed the moment you earn income (duels, !free, idle, etc). Only **1** can be active at a time.\n' +
                                'Drops from: Silver & Gold boxes only.\n' +
                                '*Make it count. Don\'t waste it on some pathetic !free claim.* (¬_¬)'
                        },
                        {
                            name: '💳 Debt Eraser',
                            value: 'Equip via `!equip`. Erases **30%** of your oldest active loan\'s remaining balance.\n' +
                                'The lender **gets paid** that 30% — it\'s not free money, the debt is settled legitimately.\n' +
                                'If the 30% finishes off the loan, you\'re freed from slavery too!\n' +
                                'Stackable — use multiple to chip away at large debts.\n' +
                                'Drops from: Silver & Gold boxes.\n' +
                                '*It\'s NOT a full wipe. Read the fine print next time!* >////<'
                        },
                        {
                            name: '🎣 Slave Snatcher',
                            value: 'Equip via `!equip`, then enter the **slave\'s** user ID (not the owner\'s).\n' +
                                'Steals someone else\'s slave — transfers ownership AND their loan to you. Resets any active carrot.\n' +
                                'The old owner loses their slave. The slave gets a new master (you).\n' +
                                'Drops from: Gold box only (**0.5%** chance). 🔴 MYTHIC rarity.\n' +
                                '*The cruelest item in the game and I love it.* (¬_¬)'
                        },
                        {
                            name: '🎫 Isekai Discount',
                            value: 'Equip via `!equip` to activate the flag. Next time you use `!isekai`, the prestige cost is **25% off**.\n' +
                                'One-time use. Flag persists until consumed by an isekai.\n' +
                                'Drops from: Gold box only.\n' +
                                '*A coupon for reincarnation. Peak tacky.* (¬_¬)'
                        },
                        {
                            name: '💎 Nugget',
                            value: 'Instantly adds **1 Nugget** to your balance when pulled. No equip needed — it\'s applied automatically.\n' +
                                'Drops from: Bronze (**0.1%**), Silver (**0.5%**), Gold (**5%**).\n' +
                                '*D-Don\'t look at me like that, it\'s just one! Be grateful!* >////<'
                        },
                        {
                            name: '💰 Coins',
                            value: 'A random coin reward based on box tier:\n' +
                                `💰 Bronze: **${COIN_RANGES.bronze[0].toLocaleString('en-US')}** – **${COIN_RANGES.bronze[1].toLocaleString('en-US')}**\n` +
                                `💎 Silver: **${COIN_RANGES.silver[0].toLocaleString('en-US')}** – **${COIN_RANGES.silver[1].toLocaleString('en-US')}**\n` +
                                `👑 Gold: **${COIN_RANGES.gold[0].toLocaleString('en-US')}** – **${COIN_RANGES.gold[1].toLocaleString('en-US')}**\n` +
                                '*The consolation prize. At least it\'s something.* (¬_¬)'
                        }
                    );
            }
            else if (val === 'help_anime_games') {
                let guessTable = '';
                for (const tier of config.GUESS_REWARDS) {
                    const label = tier.threshold === Infinity ? '5M+' : (tier.threshold >= 1000000 ? `${(tier.threshold/1000000).toFixed(0)}M` : `${(tier.threshold/1000).toFixed(0)}k`);
                    guessTable += `${label}: **${tier.reward.toLocaleString('en-US')}** | `;
                }
                guessTable = guessTable.slice(0, -3);
                embed.setTitle('🎮 Anime Trivia & Manga Games')
                    .setDescription("*P-Prove you actually watch anime instead of just collecting titles, you fraud!* (¬_¬)")
                    .addFields(
                        {
                            name: '🎵 `!guess opening/ending [difficulty]`',
                            value: 'A clip plays and you type the anime name. First correct answer wins!\n' +
                                '🟢 **easy** (8s) 1× | 🟡 **medium** (5s) 1.5× | 🔴 **hard** (3s) 2.5× | 💀 **insane** (1s) 4×\n' +
                                '**Base Rewards by Wallet:**\n' +
                                '`0–10k:` **250** | `10k–50k:` **700** | `50k–100k:` **1,500**\n' +
                                '`100k–500k:` **6,000** | `500k–1M:` **15,000** | `1M–5M:` **35,000** | `5M+:` **65,000**\n' +
                                '🔥 **Streak Bonus:** 3+ wins = 1.25× | 5+ = 1.5× | 10+ = 2.0× (capped)\n' +
                                '⚠️ *Insane has slightly reduced payouts for rich players... d-don\'t blame me, blame inflation!*'
                        },
                        {
                            name: '📊 `!guess` — MAL Score Guessing',
                            value: 'A random manga appears. Everyone types a score (0–10). Closest wins!\n' +
                                'Auto-triggers in **#general** every ~220 messages. Needs **2+ players** for rewards.\n' +
                                '🎯 **Exact Match** = 1.5× bonus! | 🔥 **8 Win Streak** = 8h timeout (share the wealth!)\n' +
                                'Rewards: ' + guessTable
                        },
                        {
                            name: '📈 `!higherlower` / `!hl` — Higher or Lower',
                            value: '*I-It\'s not like I made this game fun on purpose or anything...* >///<\n' +
                                'Guess if the next manga\'s MAL score is **higher** or **lower**. Build streaks for MASSIVE payouts!\n\n' +
                                '**💰 Tiered Base:** Streak 1–9: `150` | 10–19: `250` | 20–49: `400` | 50–99: `750` | 100+: `1,500`\n' +
                                '**📊 Bag Mult:** Scales with your wallet via `log10(coins)`\n' +
                                '**⏭️ Skip:** 1 free per game, then costs **15%** of your current pot from wallet\n' +
                                '**⚡ Speed Bonus:** ⚡<3s +4% | 🔥3-5s +2% | 💨5-8s +1% | >8s resets combo\n' +
                                '**🎯 Clutch Bonus:** Guess correctly when scores differ by ≤0.05 → +10% per clutch!\n' +
                                '**⚠️ RISK:** Click **Quit** = keep 100%. Guess wrong or timeout = lose **75%** of your bag!\n' +
                                '⏰ Timers: `1–19:` 30s | `20–49:` 20s | `50+:` 15s\n' +
                                'Rankings: `!lb hl`'
                        }
                    );
            }
            else if (val === 'help_shop') {
                embed.setTitle('🛍️ The Shop — `!shop`')
                    .setDescription("*Welcome to the only place I'll interact with you willingly. Browse, buy, and get out.* (¬_¬)\n⚠️ Most prices = base + 10% of your wallet. Richer = pricier.")
                    .addFields(
                        {
                            name: '🏷️ Titles',
                            value: `**${config.ITEMS.SHOP_TITLES.length}** shop-exclusive titles — **${config.SHOP_PRICES.TITLE_PRICE.toLocaleString('en-US')}c** base each.\n` +
                                'Permanent once bought. Equip via `!equip`. Cannot buy duplicates.'
                        },
                        {
                            name: '⚔️ Items & Upgrades',
                            value: `🎨 **Random Frame** (~${config.SHOP_PRICES.RANDOM_FRAME.toLocaleString('en-US')}c) — Random color frame\n` +
                                '🎨 **Custom Frame** (~5,000c) — Pick hex color\n' +
                                `🛡️ **Elo Shield** (~${config.SHOP_PRICES['Elo Shield'].toLocaleString('en-US')}c) — Absorbs one Elo loss. Stackable.\n` +
                                `🪙 **Coin Amulet** (~${config.SHOP_PRICES['Coin Amulet'].toLocaleString('en-US')}c) — 1.5× duel win. Stack up to 50.\n` +
                                `👻 **Trash Curse** (~${config.SHOP_PRICES['Trash Curse'].toLocaleString('en-US')}c) — Nerf target's Elo for 24h.\n` +
                                `🎭 **Curse of Mediocrity** (~${config.SHOP_PRICES['Curse of Mediocrity'].BASE.toLocaleString('en-US')}c + 20% wallet) — Restrict gacha for 24h.\n` +
                                '⏰ **Reset Cooldowns** (~15,000c) — Resets `!free` cooldown.\n' +
                                '❄️ **Streak Freeze** (50% wallet, min 100k) — Auto-saves daily streak.'
                        },
                        {
                            name: '🔥 Special Services',
                            value: `🏷️ **Slave Tag Remover** (~${config.SHOP_PRICES['Slave Tag Remover'].toLocaleString('en-US')}c) — Remove slave nickname tag.\n` +
                                `💰🌸 **Sugar Daddy / Sugar Mommy** (~1,000,000c base) — Cosmetic Discord role. Pick on purchase.\n` +
                                `⚠️ **One purchase per season.** You can switch between Daddy/Mommy for free anytime after buying.`
                        },
                        {
                            name: '🏴‍☠️ Shady Merchant — Sell Items',
                            value: 'Access via `!shop` → Shady Merchant.\n' +
                                'Prices randomize daily (luck-based multipliers).\n' +
                                'Daily sell cap: **200,000** coins. **1 free refresh/day**, then paid.\n' +
                                'Bulk sell up to **20** items at once!'
                        },
                        {
                            name: '🎒 Managing Items',
                            value: '`!bag` / `!inventory` — View everything\n' +
                                '`!equip` — Equip titles, shields, amulets, consumables\n' +
                                '`!curse @user` — Use Trash Curse or Mediocrity\n'
                        }
                    );
            }
            else if (val === 'help_bounty') {
                embed.setTitle('🎯 Bounty System')
                    .setDescription("*Put a price on someone's head. Get your revenge funded by the community. Very mature.* (¬_¬)")
                    .addFields(
                        {
                            name: '📋 Commands',
                            value: `\`!bounty @user <amount>\` — Place bounty (min **${config.ECONOMY.MIN_BOUNTY.toLocaleString('en-US')}** coins)\n` +
                                '`!wanted` — View top 10 Most Wanted list\n' +
                                '`!bounty remove @user` — Cancel your bounty, get refunded'
                        },
                        {
                            name: '💸 How It Works',
                            value: `You pay → **${(config.ECONOMY.BOUNTY_TAX_RATE * 100).toFixed(0)}%** burned as fee → remainder becomes bounty reward.\n` +
                                'Next person to win a `!duel` against target claims it automatically.\nMultiple people can stack bounties on the same target.'
                        },
                        {
                            name: '🛡️ Bounty Shield',
                            value: 'From gacha. Equip via `!equip` to block new bounties while active.'
                        },
                        {
                            name: '⚠️ Rules',
                            value: 'Cannot bounty yourself. Cannot bounty the bot.\nFull refund on removal (your portion only).'
                        }
                    );
            }

            else if (val === 'help_loans') {
                const slaveTax = (config.ECONOMY.SLAVE_TAX_RATE * 100).toFixed(0);
                const loanRepay = (config.ECONOMY.LOAN_REPAY_RATE * 100).toFixed(0);
                embed.setTitle('⛓️ Loans & Slavery')
                    .setDescription("*Lend money to someone, or get trapped into debt. Either way, someone's getting owned.* >////<")
                    .addFields(
                        {
                            name: '💰 Giving a Loan — `!loan @user <amount> <interest%>`',
                            value: 'Interest: **1% to 20%** — your choice. Duration: **3 days** to repay.\n' +
                                'Max **6 active outgoing** loans. Borrower: max **1 active** loan.\n' +
                                'Example: `!loan @user 10000 10` → lend 10k at 10% (they owe 11k)'
                        },
                        {
                            name: '📊 Loan Commands',
                            value: '`!loan` — Your full loan dashboard: debt, given loans, slaves\n' +
                                '`!loan repay` — Manually repay balance (partial OK)\n' +
                                '`!loan forgive @user` — Forgive slave\'s debt, release them'
                        },
                        {
                            name: '⚠️ Defaulting (Failure to Repay in 3 Days)',
                            value: '• You become your lender\'s **slave**\n' +
                                `• **${slaveTax}%** of ALL income → master automatically\n` +
                                `• **${loanRepay}%** → loan repayment hourly\n` +
                                '• Nickname changes to "[Name] (Master\'s Slave)"\n' +
                                '• **Cannot use vault** while enslaved'
                        },
                        {
                            name: '🆓 How to Escape',
                            value: '• Repay full debt (income chips away automatically; `!loan repay` to speed up)\n' +
                                '• **Slave Freedom Ticket** (gacha) → `!freedom` (debt must be fully paid first!)\n' +
                                '• **Debt Eraser** (gacha) → `!equip` — erases 30% of remaining debt\n' +
                                '• **Debt Forgiveness** (forge, 8💎) — also removes slavery\n' +
                                '• Master forgives you: `!loan forgive @user`'
                        },
                        {
                            name: '🔨 Selling a Slave — `!auction list @slave`',
                            value: `Auction runs **24 hours**. \`!auction bid <amount>\` to bid.\n` +
                                `Winner pays **${((1 - config.ECONOMY.AUCTION_FEE_RATE) * 100).toFixed(0)}%** to seller + **${(config.ECONOMY.AUCTION_FEE_RATE * 100).toFixed(0)}%** burned.\n` +
                                'Debt transfers to new owner unchanged.'
                        }
                    );
            }
            else if (val === 'help_slave') {
                const carrotMaxRatio = config.ECONOMY.CARROT_MAX_RATIO;
                embed.setTitle('🥕 Slave Management')
                    .setDescription("*Own a slave? Good. Now don't mess this up. There's a whole system here.*  (¬_¬)")
                    .addFields(
                        {
                            name: '📋 Owner Commands',
                            value: '`!slave` / `!slave list` — View slaves, income, carrot status\n' +
                                '`!slave info @user` — View any slave\'s public status\n' +
                                '`!slave rename @slave <name>` — Brand your slave with a custom name. They can\'t change it, obviously. (¬_¬)\n' +
                                '`!slave rename @slave clear` — Remove the custom name. Back to their default tag.\n' +
                                '`!slave carrot @slave <amount>` — Boost slave\'s income\n' +
                                '`!slave top` — Leaderboard: most coins spent on carrots'
                        },
                        {
                            name: '⛓️ If YOU Are Enslaved',
                            value: '`!slave` — Your status: owner, debt, income split, time-to-freedom\n' +
                                '`!slave resist` — Nullify owner\'s carrot for **6 hours**. One use per ownership.'
                        },
                        {
                            name: '💬 Passive Slave Income',
                            value: 'Slaves generate coins hourly: `(daily messages ÷ 10) × prestige mult`\n' +
                                '**40%** → Master | **20%** → Loan repayment | **40%** → Slave keeps'
                        },
                        {
                            name: '🥕 How Carrots Work',
                            value: '`!slave carrot @slave <amount>` — costs you coins, boosts generation.\n' +
                                'Bonus/hr = `carrotAmount ÷ (remainingDebt ÷ 100)`\n' +
                                `Lasts 24 hours. Max carrot = **${carrotMaxRatio}×** remaining debt.\n` +
                                '⚠️ More income = faster loan repayment = they escape sooner.\n' +
                                '⚠️ If slave escapes with active carrot, remaining value is **BURNED**.'
                        },
                        {
                            name: '🎣 Slave Snatcher',
                            value: 'Ultra-rare gacha drop. Use via `!equip` → Slave Snatcher.\n' +
                                'Steal someone\'s slave: you become new owner, debt transfers, carrot resets.'
                        }
                    );
            }
            else if (val === 'help_prestige') {
                const roles = config.ROLES.PRESTIGE;
                const costs = config.ECONOMY.PRESTIGE_COSTS;
                const mults = config.ECONOMY.PRESTIGE_MULTIPLIERS;
                let prestigeTable = '';
                for (let i = 0; i < roles.length; i++) {
                    const mult = `+${(mults[i + 1] * 100).toFixed(0)}%`;
                    prestigeTable += `**${roles[i]}** — ${costs[i].toLocaleString('en-US')}c (${mult} income)\n`;
                }
                embed.setTitle('🚚 Isekai — Prestige System — `!isekai`')
                    .setDescription("*You want to throw everything away for a fresh start? F-Fine. Prestige makes you permanently more powerful in exchange for losing everything.* (¬_¬)")
                    .addFields(
                        {
                            name: '♻️ What You Lose vs Keep',
                            value: '❌ **LOSE:** All coins, inventory, titles, bounties, fish bucket, bait, active fishing quests\n' +
                                '✅ **KEEP:** Battle ELO, duel grid, all-time stats, fishing rods, biomes, fishing stats\n' +
                                '🎁 **GAIN:** Permanent income multiplier, higher wallet/vault caps'
                        },
                        { name: '📈 Prestige Levels & Costs', value: prestigeTable + '*Costs scale with each level — plan ahead!*' },
                        {
                            name: '💪 What Prestige Does',
                            value: 'Income multiplier on **EVERYTHING**: duels, gambling, idle, slave income.\n' +
                                `Wallet cap: +**${(config.ECONOMY.WALLET_CAP_PER_LEVEL / 1000000).toFixed(0)}M** per level\n` +
                                `Vault cap: +**${(config.VAULT.PRESTIGE_CAPACITY_MULTIPLIER / 1000000).toFixed(0)}M** per level\n` +
                                '\n⚠️ The bonus fades as your wallet fills up:\n' +
                                '**0–80% full** → full bonus | **80–95%** → fades | **95%+** → gone\n' +
                                "*I-It's not like I designed this to punish you! It just... works that way. (¬_¬)*\n" +
                                'Prestige is your comeback tool. Not your throne.'
                        },
                        {
                            name: '🚫 Requirements',
                            value: 'No active loans. Not a slave. Must have full coin cost in wallet.'
                        },
                        {
                            name: '🎁 Bonuses & Discounts',
                            value: '🎫 **Isekai Discount** (gacha) — 25% off next isekai cost. Via `!equip`.'
                        }
                    );
            }
            else if (val === 'help_daily') {
                embed.setTitle('📅 Daily Streak & Weekly Goal')
                    .setDescription("*Show up every day. Collect the reward. It's not hard. I'll pretend I don't notice if you never miss one.* >////<")
                    .addFields(
                        {
                            name: '📋 `!daily` — Daily Reward',
                            value: 'Claim every **20 hours**. Streak breaks at **36+ hours** without claiming.'
                        },
                        {
                            name: '🏆 Streak Milestones',
                            value: 'Day 2: **+5,000c** | Day 3: **+10,000c** | Day 5: **+30,000c**\n' +
                                'Day 7: **+50,000c** + Random Gacha Title\n' +
                                'Day 10: **+80,000c** | Day 14: **+100,000c** + Gold Gacha Box\n' +
                                'Day 21: **+300,000c** | Day 30: **+500,000c** + Gold Gacha Box\n' +
                                'Day 60: **+1M** + 1💎 + 10x Gold Box\n' +
                                'Day 100: **+50M** + 10💎 🏆\n' +
                                'Every 30 after 100: **+5M** + 2💎\n' +
                                "*Come back when you have a 100-day streak.* >////<"
                        },
                        {
                            name: '❄️ Streak Freeze',
                            value: 'Buy from `!shop` → Items. Costs **50% of wallet** (min 100k).\n' +
                                'Auto-activates on miss. One per purchase. Stack multiples for extra safety.'
                        },
                        {
                            name: '🎯 `!goal` — Weekly Server Goal',
                            value: 'Server collectively earns toward a weekly coin goal. Every coin counts.\n' +
                                '`!claimweekly` when goal is met: **+' + (config.ECONOMY.WEEKLY_REWARD_COINS || 2000).toLocaleString('en-US') + 'c** + **' + (config.ECONOMY.WEEKLY_REWARD_NUGGETS || 1).toLocaleString('en-US') + '💎**\n' +
                                '🌟 Stretch (2× goal): extra **+' + (config.ECONOMY.WEEKLY_REWARD_NUGGETS || 1).toLocaleString('en-US') + '💎**. One claim per person per week.'
                        }
                    );
            }
            else if (val === 'help_taxes') {
                embed.setTitle('💸 Taxes & Economy Rules')
                    .setDescription("*Yes, I take your money sometimes. There are rules. Read them so you can't complain later.* (¬_¬)")
                    .addFields(
                        {
                            name: '🔥 Rich Tax — On Income',
                            value: 'Tax hits AFTER your prestige and amulet bonuses are added.\n' +
                                'Earn more with your fancy multipliers? Great. Now I take more too. (¬_¬)\n' +
                                '• Wallet > **100k**: 20% of (base + bonuses) burned\n' +
                                '• Wallet > **1M**: 30% of (base + bonuses) burned'
                        },
                        {
                            name: '📅 Daily Wealth Tax — On Balance',
                            value: 'Taken once per day from your wallet:\n' +
                                '• 100k–500k: **10%** | 500k–1M: **20%** | > 1M: **30%**\n' +
                                'Feeds the weekly server goal.\n' +
                                '🛡️ Active slaves and debtors are exempt.'
                        },
                        {
                            name: '⛓️ Slave Tax — On Income',
                            value: `**${(config.ECONOMY.SLAVE_TAX_RATE * 100).toFixed(0)}%** of every coin you earn → master. Instant, automatic, no exceptions.`
                        },
                        {
                            name: '🏷️ Market Fee',
                            value: `**${(config.ECONOMY.MARKET_FEE_RATE * 100).toFixed(0)}%** of sale price burned on marketplace purchases.`
                        },
                        {
                            name: '🎯 Bounty Fee',
                            value: `**${(config.ECONOMY.BOUNTY_TAX_RATE * 100).toFixed(0)}%** burned on placement. Remaining becomes reward.`
                        },
                        {
                            name: '🛒 Auction Fee',
                            value: `**${(config.ECONOMY.AUCTION_FEE_RATE * 100).toFixed(0)}%** of winning bid burned. Seller gets the rest.`
                        },
                        {
                            name: '🛡️ Safe Zones',
                            value: '**Vault** — Protected from daily tax and `!tax`\n' +
                                '**Slaves/Debtors** — Exempt from daily wealth tax'
                        }
                    );
            }
            else if (val === 'help_social') {
                embed.setTitle('💝 Social & Relationships')
                    .setDescription("*I-It's not like I care about your social life or anything. But here are the commands.* (¬_¬)")
                    .addFields(
                        {
                            name: '🫂 Free Interactions',
                            value: '`!hug` `!kiss` `!pat` `!cuddle` `!poke` `!slap` `!bonk` `@user`\nNo cost, no cooldown. Use in any channel.'
                        },
                        {
                            name: '💕 Relationships',
                            value: '`!ship @user` — Calculate compatibility score (permanent)\n' +
                                '`!ship @a @b` — Ship two others\n' +
                                '`!ship status @user` — View full relationship card\n' +
                                '`!propose @user` — Costs **30%** of your coins\n' +
                                '`!marry @user` — Both pay **50%** of their coins\n' +
                                '`!breakup` — End relationship. No refunds. 48h cooldown.\n' +
                                '`!rivals @user` — Permanent rival. +50% ELO from duel wins.\n' +
                                '`!shipbattle @A @B vs @C @D` — 1h public vote. 2% wallet to start.'
                        },
                        {
                            name: '💍 Notes',
                            value: '48h cooldown after rejection or breakup.\nShip scores are permanent.\nMarried partners get jealousy messages (25% chance on !hug/!kiss someone else).'
                        },
                        {
                            name: '🗳️ Election System',
                            value: 'Community can vote out mods via tournament bracket.\n' +
                                'Revolution Poll (1h) → Purge Poll (1h) → Applications (30m) → Tournament\n' +
                                '`!electionstatus` | `!electioncandidates`'
                        }
                    );
            }
            else if (val === 'help_trade') {
                embed.setTitle('🔄 Player Trading — `!trade`')
                    .setDescription("*You want to give someone your stuff? Fine. But I'm watching — no funny business.* (¬_¬)")
                    .addFields(
                        {
                            name: '📦 Starting a Trade',
                            value: '`!trade @user` — Opens a **3-minute** trade session.\nBoth see the window. Click **SELECT ITEMS** to pick offerings.\nFor stackable items, enter quantity after selecting.'
                        },
                        {
                            name: '✅ Confirming',
                            value: 'Both must click **CONFIRM**. First to confirm shows ✅ READY.\n' +
                                'Both confirmed → **5-second countdown** → items transfer.\n' +
                                'Use **EMERGENCY CANCEL** during countdown if something looks wrong.'
                        },
                        {
                            name: '🚫 Rules',
                            value: '❌ Cannot trade coins\n❌ Cannot trade equipped items (unequip first)\n❌ Slaves cannot start trades\n' +
                                '✅ Any inventory item can be traded (titles, tickets, amulets, etc.)'
                        },
                        {
                            name: '🛡️ Scam Prevention',
                            value: 'The 5s countdown is your review window. Items verified before transfer.\nTrade expires after 3 minutes if unconfirmed.'
                        }
                    );
            }
            else if (val === 'help_market') {
                embed.setTitle('🏪 Player Marketplace — `!market`')
                    .setDescription("*Sell your stuff to whoever wants it. Buy what others are selling. I take a small cut.* (¬_¬)")
                    .addFields(
                        {
                            name: '📦 Listing Items',
                            value: '`!market sell` — Select item and set price.\n' +
                                'Min price: **40%** of item base value.\nMax **5** active listings. Expire after **7 days** (items auto-return).'
                        },
                        {
                            name: '🛒 Browsing & Buying',
                            value: `\`!market\` — Browse all listings\n\`!market buy <ID>\` — Purchase\n**${(config.ECONOMY.MARKET_FEE_RATE * 100).toFixed(0)}%** fee burned on every sale.`
                        },
                        {
                            name: '📝 Managing Listings',
                            value: '`!market mine` — Your active listings\n`!market cancel <ID>` — Remove listing (no fee on cancel)'
                        },
                        {
                            name: '💰 Minimum Prices by Rarity',
                            value: `⚪ Common: **${config.GACHA_MIN_PRICES.COMMON.toLocaleString('en-US')}c** | 🔵 Rare: **${config.GACHA_MIN_PRICES.RARE.toLocaleString('en-US')}c**\n` +
                                `🟡 Legendary: **${config.GACHA_MIN_PRICES.LEGENDARY.toLocaleString('en-US')}c** | 🟣 Ultra Rare: **${config.GACHA_MIN_PRICES.ULTRA_RARE.toLocaleString('en-US')}c**\n` +
                                `🔴 Mythic: **${config.GACHA_MIN_PRICES.MYTHIC.toLocaleString('en-US')}c**`
                        }
                    );
            }
            else if (val === 'help_leaderboards') {
                embed.setTitle('🏆 Leaderboards — `!leaderboard` / `!lb`')
                    .setDescription("*Hmph. So you want to see where you rank. Probably not as high as you think.* (¬_¬)")
                    .addFields(
                        {
                            name: '💬 Chat Rankings',
                            value: '`!lb chats` — Today\'s most active chatters\n' +
                                '`!lb chats alltime` — All-time messages'
                        },
                        {
                            name: '💰 Wealth Rankings',
                            value: '`!lb rich` — Top 10 wealthiest\n' +
                                '`!lb poor` — Bottom 10\n' +
                                '`!lb overlord` — Season Overlord Rankings (OP)'
                        },
                        {
                            name: '⚔️ Battle Rankings',
                            value: '`!lb duel top` — Highest ELO\n' +
                                '`!lb duel losers` — Lowest ELO'
                        },
                        {
                            name: '🎮 Game Rankings',
                            value: '`!lb hl` — Higher Lower best streaks\n' +
                                '`!lb op` / `!lb ed` — Anime trivia streaks'
                        },
                        {
                            name: '🔤 Buzzword Rankings',
                            value: '`!lb buzz` — Who says certain words the most. Pick a keyword from the dropdown and see the top addicts.\n' +
                                "*I-I'm not obsessively tracking everything you say... it's just data collection! (¬_¬)*"
                        },
                        {
                            name: '🥕 Slave Rankings',
                            value: '`!slave top` — Most coins spent on carrots. Generous or just bad at risk management?'
                        }
                    );
            }
            else if (val === 'help_profile') {
                embed.setTitle('📊 Profile & Relationships — `!info` & `!rels`')
                    .setDescription("*You want to stalk yourself? Or worse, someone else? Fine. Here's how.* (¬_¬)")
                    .addFields(
                        {
                            name: '📊 `!info` — Your Full Profile',
                            value: '4-page card with everything the bot knows about you.\n' +
                                '**Page 0 — Overview:** Economy, prestige, ELO, bounty, wallet/vault (self only)\n' +
                                '**Page 1 — Loadout:** Equipped items, forge upgrades, active effects (self only)\n' +
                                '**Page 2 — Relationships:** Marriage, dating, rivals, notable ships, history\n' +
                                '**Page 3 — Records:** Streaks, game scores, gacha pity, chat stats'
                        },
                        {
                            name: '👁️ `!info @user` — View Someone Else',
                            value: 'Public data only — no wallet, no active effects, no debt info.\n' +
                                'Relationships and records are always public because drama is a spectator sport. (¬_¬)'
                        },
                        {
                            name: '💝 `!rels` / `!relationships`',
                            value: 'Shortcut that jumps directly to the relationships page of `!info`.\n' +
                                '`!rels @user` to creep on someone else\'s love life.'
                        },
                        {
                            name: '🗑️ Navigation',
                            value: 'Use the tab buttons to jump between pages. Only you can navigate your own panel.'
                        }
                    );
            }
            else if (val === 'help_stocks') {
                embed.setTitle('📈 TsunStocks — The Stock Market')
                    .setDescription("*You want to play the stock market? Fine, but don't come crying to me when you lose all your coins, baka!* (¬_¬)")
                    .addFields(
                        {
                            name: '📊 What is it?',
                            value: 'Everyone in the server has a stock price (even you, loser). You can buy and sell shares of each other to earn coins! If you think some idiot is going to chat a lot, buy their stock early. D-Don\'t buy mine though, that\'s weird! >///<'
                        },
                        {
                            name: '💹 How do prices go UP?',
                            value: `• **Chatting:** Send messages (+${config.STOCKS.MESSAGE_PRICE_BUMP.toFixed(1)} coins/msg, cap of ${config.STOCKS.MESSAGE_HOURLY_CAP}/hr, so don't spam, baka!)\n` +
                                   `• **Winning Duels:** Flexing ELO (+${config.STOCKS.DUEL_WIN_BUMP.toFixed(1)} coins per win)\n` +
                                   `• **Minigames:** Surviving roulette or winning HL (+${config.STOCKS.MINIGAME_WIN_BUMP.toFixed(1)} coins per win)\n` +
                                   `• **Buying:** Price pumps by +${(config.STOCKS.BUY_PRESSURE * 100).toFixed(0)}% whenever someone buys (buy pressure is real!)`
                        },
                        {
                            name: '📉 How do prices go DOWN?',
                            value: `• **Losing Duels:** Being a complete loser (-${config.STOCKS.DUEL_LOSS_DROP.toFixed(1)} coins per loss)\n` +
                                   `• **Selling:** Dumping shares drops price by -${(config.STOCKS.SELL_PRESSURE * 100).toFixed(0)}% (paper hands, hmph!)\n` +
                                   `• **Decay:** Price decays by -${(config.STOCKS.INACTIVITY_DECAY_RATE * 100).toFixed(0)}% per hour if they go silent for ${config.STOCKS.INACTIVITY_THRESHOLD / 3600000}h! Don't buy dead chatters, they are useless! (¬_¬)`
                        },
                        {
                            name: '💸 Passive Income & Roles',
                            value: `• **CEO Salary:** Get paid **${(config.STOCKS.CEO_SALARY_RATE * 100).toFixed(0)}% of your stock price** daily just for existing! Keep your stock high to print coins.\n` +
                                   `• **Dividends:** Hold shares of the **top ${config.STOCKS.DIVIDEND_TOP_N} most active chatters** to receive **${config.STOCKS.DIVIDEND_PER_SHARE} coins/share** daily!\n` +
                                   '• **Blue Chip Role:** Top 5 highest-priced stocks get the exclusive **Blue Chip** role. Go brag about it!'
                        },
                        {
                            name: '🌐 How do I trade?',
                            value: `Go to the website: **https://tsun.vercel.app** and log in with your Discord account (if you can manage that).\n*There is a **${(config.STOCKS.BROKER_FEE * 100).toFixed(0)}% broker fee** on both buy and sell, so don't try any stupid day-trading, idiot! (¬_¬)*`
                        },
                        {
                            name: '⌨️ Discord Commands',
                            value: '`!stock info @user` — Stalk their stock stats like a creep (¬_¬)\n' +
                                   '`!stock buy @user [amount]` — Buy their shares because you have nothing better to do.\n' +
                                   '`!stock sell @user [amount]` — Dump their boring shares for coins.\n' +
                                   '`!stock portfolio` — Check your gains (or losses, which would be hilarious).\n' +
                                   '`!stock market` — Check the leaderboard, gainers, and absolute losers of the day.'
                        },
                        {
                            name: '🛑 Limits',
                            value: `You can only hold a maximum of **${config.STOCKS.MAX_SHARES_PER_USER} shares** of any single person. Also, the price only changes by ${(config.STOCKS.BUY_PRESSURE * 100).toFixed(0)}% per trade, so rich whales can't manipulate the market to lock you out. Even you can afford to play, baka!`
                        }
                    );
            }

            try {
                await interaction.update({ embeds: [embed] });
            } catch (e) {
                // Interaction may have timed out - try to edit the original message instead
                if (e.code === 10062 || e.code === 40060) {
                    console.log('[HELP] Interaction timed out, ignoring...');
                } else {
                    console.error('[HELP] Error updating interaction:', e);
                }
            }
        }
    },

    // --- TRACKING LOGIC ---
    trackMessage: async (message) => {
        if (!message.guild) return;
        try {
            const update = {
                $inc: {
                    "stats.daily.messages": 1,
                    "stats.daily.characters": message.content.length,
                    "stats.weekly.messages": 1,
                    "stats.allTime.messages": 1,
                    "stats.allTime.characters": message.content.length
                },
                $set: { lastActiveTime: Date.now() }
            };
            const chanId = message.channel.id;
            update.$inc[`stats.allTime.channels.${chanId}`] = 1;

            await User.findOneAndUpdate({ userId: message.author.id }, update, { upsert: true });
        } catch (err) { console.error("Stats Error:", err); }
    },

    trackReaction: async (uid, tid) => {
        try {
            await User.findOneAndUpdate({ userId: uid }, {
                $inc: { "stats.daily.reactionsGiven": 1, "stats.allTime.reactionsGiven": 1 }
            }, { upsert: true });

            await User.findOneAndUpdate({ userId: tid }, {
                $inc: { "stats.daily.reactionsReceived": 1, "stats.allTime.reactionsReceived": 1 }
            }, { upsert: true });
        } catch (e) { }
    },

    checkAndResetStats: async () => {
        const nowTime = Date.now();
        const dateObj = new Date();
        const todayStr = dateObj.toISOString().split('T')[0];
        
        // Only perform the daily stats reset during the midnight hour (00:xx UTC) and only once per day
        if (dateObj.getUTCHours() === 0 && lastStatsResetDay !== todayStr) {
            lastStatsResetDay = todayStr;
            console.log("🧹 Performing Daily Stats Reset...");
            try {
                await User.updateMany({}, {
                    $set: { "stats.daily": { messages: 0, characters: 0, reactionsGiven: 0, reactionsReceived: 0 } }
                });
                console.log("✅ Daily Stats Reset Complete!");
            } catch (e) {
                console.error("Daily Reset Error:", e);
            }
        }

        try {
            // --- WEEKLY RESET CHECK ---
            // Check if we need to reset weekly stats (every 7 days) for ALL servers
            const allStats = await ServerStats.find({});
            const oneWeek = 7 * 24 * 60 * 60 * 1000;

            for (const stats of allStats) {
                const lastWeeklyReset = stats.lastWeeklyReset || 0;
                if (nowTime - lastWeeklyReset >= oneWeek) {
                    stats.weeklyCoinCount = 0;
                    stats.weeklyClaimers = [];
                    stats.goalAnnouncedThisWeek = false;
                    stats.lastWeeklyReset = nowTime;
                    await stats.save();

                    // Reset weekly message stats for all users
                    await User.updateMany({}, { $set: { "stats.weekly.messages": 0 } });

                    console.log(`✅ Weekly Stats Reset Complete for guild ${stats.guildId}!`);
                }
            }
        } catch (e) { console.error("Weekly Reset Error:", e); }
    }
};

