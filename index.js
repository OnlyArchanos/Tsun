require('dotenv').config();
const { Client, GatewayIntentBits, ActivityType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const mongoose = require('mongoose');
const connectDB = require('./utils/database');
const User = require('./models/User');
const Loan = require('./models/Loan');
const Auction = require('./models/Auction');
const Relationship = require('./models/Relationship');
const ServerStats = require('./models/ServerStats');
const BuzzwordCount = require('./models/BuzzwordCount');
const { checkAndApplyDailyTax } = require('./commands/economy');
const { distributeIncome } = require('./utils/income');
const { getDisplayName, createCleaningMap, getVaultCap } = require('./utils/helpers');
const config = require('./config');
const BUZZWORD_SET = new Set((config.BUZZWORDS || []).flatMap(g => Array.isArray(g) ? g : [g]).map(w => w.toLowerCase()));
const phrases = require('./config/phrases');
const roleSync = require('./utils/roleSync');
const { rotateFeaturedBanner } = require('./utils/gacha');
const mangaCache = require('./utils/mangaCache');
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;
const ADMIN_PAGE_AUTH_TOKEN = '__TSUN_ADMIN_AUTH__';
const ADMIN_AUDIT_LIMIT = 100;
const ADMIN_PAGE_PATH = path.join(__dirname, 'public', 'admin.html');
const adminChangeLog = [];
const ADMIN_USER_DETAIL_PROJECTION = [
    'userId',
    'elo',
    'wins',
    'losses',
    'gridUrl',
    'coins',
    'nuggets',
    'nuggetDuelMilestone',
    'upgrades',
    'goldenAmuletCount',
    'titanVaultUsed',
    'isekaiDiscountActive',
    'doubleDipActive',
    'mediocrityExpiry',
    'bounty',
    'inventory',
    'strippedRoles',
    'prestige',
    'gachaPity',
    'gachaTotalSpent',
    'dailyStreak',
    'lastDailyClaim',
    'longestDailyStreak',
    'isSlave',
    'slaveOwner',
    'activeCarrot',
    'carrotResistUsed',
    'resistExpiresAt',
    'equippedTitle',
    'frameColor',
    'trashTasteExpiry',
    'botBanExpiry',
    'forcedNickname',
    'currentDuelStreak',
    'vaultCoins',
    'bountyShieldExpiry'
].join(' ');

if (!process.env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET env var is required');
}

if (!process.env.DASHBOARD_PASSWORD) {
    console.warn("⚠️ DASHBOARD_PASSWORD is missing. Admin login will reject all attempts.");
}
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: true
    }
}));

function pushAdminChange(entry) {
    adminChangeLog.unshift(entry);
    if (adminChangeLog.length > ADMIN_AUDIT_LIMIT) {
        adminChangeLog.length = ADMIN_AUDIT_LIMIT;
    }
}

function getValueByPath(source, fieldPath) {
    const tokens = fieldPath.split('.');
    let current = source;
    for (const token of tokens) {
        if (current === null || current === undefined) return undefined;
        current = current[token];
    }
    return current;
}

function flattenPatch(source, prefix = '', out = {}) {
    Object.entries(source || {}).forEach(([key, value]) => {
        if (key === 'note') return;
        const nextPath = prefix ? `${prefix}.${key}` : key;
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            flattenPatch(value, nextPath, out);
            return;
        }
        out[nextPath] = value;
    });
    return out;
}

function sanitizeFlattenedPatch(flattenedPatch) {
    const safePatch = {};

    Object.entries(flattenedPatch || {}).forEach(([path, value]) => {
        const segments = String(path).split('.');
        const hasUnsafeSegment = segments.some((segment) => segment === '_id' || segment === '__v' || segment.startsWith('$'));
        const rootStartsWithDollar = String(path).startsWith('$');

        if (hasUnsafeSegment || rootStartsWithDollar) {
            return;
        }

        safePatch[path] = value;
    });

    return safePatch;
}

function parsePositiveInt(value, fallback = 1) {
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed < 1) return fallback;
    return parsed;
}

function createObjectIdQuery(id) {
    if (mongoose.Types.ObjectId.isValid(id)) {
        return { _id: id };
    }
    return { _id: null };
}

function renderAdminPage(req, res) {
    try {
        const html = fs.readFileSync(ADMIN_PAGE_PATH, 'utf8');
        const hydrated = html.replace(ADMIN_PAGE_AUTH_TOKEN, req.session?.authenticated ? 'true' : 'false');
        res.type('html').send(hydrated);
    } catch (error) {
        console.error('Failed to load public/admin.html:', error);
        res.status(500).send('Admin dashboard is unavailable.');
    }
}

function requireAdminAuth(req, res, next) {
    if (req.session?.authenticated === true) {
        return next();
    }
    return res.status(401).json({ error: 'Unauthorized' });
}

app.get('/', (req, res) => {
    res.send('Tsun is awake! (¬_¬)');
});

app.listen(port, () => {
    console.log(`🔗 Keep-Alive Server listening on port ${port}`);
});



// HELPER: Drop coin bag
async function dropCoinBag(channel) {
    const embed = new EmbedBuilder()
        .setColor(0xFFD700)
        .setDescription("U-Ugh! I dropped my coin bag again! First one to grab it gets the coins, you greedy bastards! >///<")
        .setFooter({ text: "Hurry up before I change my mind!" });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('grab_coins').setLabel('Grab Coins').setStyle(ButtonStyle.Success).setEmoji('💰')
    );

    const msg = await channel.send({ embeds: [embed], components: [row] });

    const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 30000 }); // 30 seconds

    let grabbed = false;

    collector.on('collect', async i => {
        if (grabbed || i.customId !== 'grab_coins') return;
        grabbed = true;

        const reward = Math.floor(Math.random() * (config.TIMING.COIN_BAG_REWARD_MAX - config.TIMING.COIN_BAG_REWARD_MIN + 1)) + config.TIMING.COIN_BAG_REWARD_MIN; // Use config values

        const log = await distributeIncome(i.user.id, reward);

        await i.reply({ content: `Y-You got ${reward} coins! Don't spend them all at once, idiot! >///<${log}`, ephemeral: true });
        collector.stop();
        msg.edit({ components: [] });
    });

    collector.on('end', () => {
        if (!grabbed) {
            msg.edit({ content: "No one grabbed it... T-That's fine, I didn't want to give away coins anyway! (¬_¬)", embeds: [], components: [] });
        }
    });
}

// HELPER: Post random tsundere phrase with user placeholders
async function postRandomPhrase(channel, guild) {
    try {
        // 1. Get top daily chatters
        const topChatters = await User.find({ 'stats.daily.messages': { $gt: 0 } })
            .sort({ 'stats.daily.messages': -1 })
            .limit(10);

        // 2. Pick random phrase
        let phrase = phrases[Math.floor(Math.random() * phrases.length)];

        // 3. Replace {{user}} with random top 5 chatter
        if (phrase.includes('{{user}}') && topChatters.length > 0) {
            const user = topChatters[Math.floor(Math.random() * Math.min(5, topChatters.length))];
            const name = await getDisplayName(user.userId, guild);
            phrase = phrase.replace(/\{\{user\}\}/g, `**${name}**`);
        }

        // 4. Replace {{user1}} and {{user2}} with two different chatters
        if ((phrase.includes('{{user1}}') || phrase.includes('{{user2}}')) && topChatters.length > 0) {
            const shuffled = [...topChatters].sort(() => Math.random() - 0.5);
            const user1 = shuffled[0];
            const user2 = shuffled[1] || shuffled[0]; // Fallback if only 1 chatter

            const name1 = await getDisplayName(user1.userId, guild);
            const name2 = await getDisplayName(user2.userId, guild);

            phrase = phrase.replace(/\{\{user1\}\}/g, `**${name1}**`);
            phrase = phrase.replace(/\{\{user2\}\}/g, `**${name2}**`);
        }

        // 5. Send the phrase
        await channel.send(phrase);
    } catch (e) {
        console.error("Phrase post error:", e);
    }
}

// --- IMPORT MODULES ---
const battleSystem = require('./commands/battle');
const economySystem = require('./commands/economy');
const utilitySystem = require('./commands/utility');
const electionSystem = require('./commands/election');
const tradeSystem = require('./commands/trade');
const marketSystem = require('./commands/market');
const higherLowerSystem = require('./commands/higherLower');
const leaderboardSystem = require('./commands/leaderboard');
const guessOpSystem = require('./commands/guessOp');
const forgeSystem = require('./commands/forge');
const socialSystem = require('./commands/social');
const fishingSystem = require('./commands/fishing');
const fishTradeSystem = require('./commands/fishTrade');
const stockSystem = require('./commands/stock');
const stockEngine = require('./utils/stockEngine');
const CARROT_RESET_SET = {
    'activeCarrot.amount': 0,
    'activeCarrot.bonusPerHr': 0,
    'activeCarrot.expiresAt': 0,
    'activeCarrot.ownerId': null
};

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessageReactions
    ]
});

async function resolveDiscordIdentity(userId, localCache = null) {
    const fallback = { discordName: 'Unknown', discordTag: 'Unknown' };
    if (!userId) return fallback;

    if (localCache && localCache.has(userId)) {
        return localCache.get(userId);
    }

    try {
        const member = await client.guilds.cache.first()?.members.fetch(userId).catch(() => null);
        const result = {
            discordName: member?.displayName || 'Unknown',
            discordTag: member?.user?.username || 'Unknown'
        };
        if (localCache) localCache.set(userId, result);
        return result;
    } catch {
        if (localCache) localCache.set(userId, fallback);
        return fallback;
    }
}

function recordFlattenedChanges({ action = 'edit', entity = 'user', entityId, beforeDoc, flattenedPatch, note = '' }) {
    const timestamp = Date.now();
    Object.entries(flattenedPatch).forEach(([field, newValue]) => {
        const oldValue = getValueByPath(beforeDoc, field);
        if (JSON.stringify(oldValue) === JSON.stringify(newValue)) return;
        pushAdminChange({
            action,
            entity,
            entityId,
            field,
            oldValue,
            newValue,
            timestamp,
            note: note || null
        });
    });
}

function parseLoanStatus(value) {
    if (!value) return null;
    const upper = String(value).toUpperCase();
    if (['ACTIVE', 'DEFAULTED', 'PAID'].includes(upper)) {
        return upper;
    }
    return null;
}

function parseRelationshipStatus(value) {
    if (!value) return null;
    const lower = String(value).toLowerCase();
    if (['none', 'dating', 'married', 'enemies'].includes(lower)) {
        return lower;
    }
    return null;
}

app.get('/admin', renderAdminPage);

app.post('/admin/login', (req, res) => {
    const submittedPassword = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!process.env.DASHBOARD_PASSWORD || submittedPassword !== process.env.DASHBOARD_PASSWORD) {
        return res.redirect('/admin?error=1');
    }

    req.session.authenticated = true;
    req.session.save(() => {
        res.redirect('/admin');
    });
});

app.get('/admin/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/admin');
    });
});

app.use('/admin/api', requireAdminAuth);

app.get('/admin/api/meta', async (req, res) => {
    return res.json({
        inventoryItems: config.ITEMS?.NON_TITLE || [],
        frameColors: config.ITEMS?.FRAME_COLORS || [],
        richTax: {
            middleThreshold: 100000,
            middleRate: 0.2,
            highThreshold: 1000000,
            highRate: 0.5
        },
        economy: {
            slaveTaxRate: config.ECONOMY?.SLAVE_TAX_RATE || 0.4,
            loanRepayRate: config.ECONOMY?.LOAN_REPAY_RATE || 0.2,
            vaultInterestRate: config.VAULT?.INTEREST_RATE || 0.02,
            coinBagMin: 80,
            coinBagMax: 250,
            coinBagTriggerMin: config.TIMING?.COIN_BAG_MIN || 10,
            coinBagTriggerMax: config.TIMING?.COIN_BAG_MAX || 18
        }
    });
});

app.get('/admin/api/overview', async (req, res) => {
    try {
        const [
            totalUsers,
            activeAuctions,
            marriedCouples,
            activeLoanAgg,
            nuggetsAgg,
            richestUser,
            highestEloUser,
            statsDoc
        ] = await Promise.all([
            User.countDocuments({}),
            Auction.countDocuments({ active: true }),
            Relationship.countDocuments({ status: 'married' }),
            Loan.aggregate([
                { $match: { status: 'ACTIVE' } },
                { $group: { _id: null, count: { $sum: 1 }, totalValue: { $sum: '$remainingAmount' } } }
            ]),
            User.aggregate([{ $group: { _id: null, totalNuggets: { $sum: '$nuggets' } } }]),
            User.findOne({}).sort({ coins: -1 }).lean(),
            User.findOne({}).sort({ elo: -1 }).lean(),
            ServerStats.findOne({}).lean()
        ]);

        const cache = new Map();
        const richestResolved = richestUser ? await resolveDiscordIdentity(richestUser.userId, cache) : { discordName: 'Unknown', discordTag: 'Unknown' };
        const highestResolved = highestEloUser ? await resolveDiscordIdentity(highestEloUser.userId, cache) : { discordName: 'Unknown', discordTag: 'Unknown' };
        const loanSummary = activeLoanAgg[0] || { count: 0, totalValue: 0 };
        const totalNuggets = nuggetsAgg[0]?.totalNuggets || 0;

        return res.json({
            totalUsers,
            activeLoans: {
                count: loanSummary.count,
                totalValue: loanSummary.totalValue
            },
            activeAuctions,
            marriedCouples,
            weekly: {
                weeklyCoinCount: statsDoc?.weeklyCoinCount || 0,
                weeklyGoal: statsDoc?.weeklyGoal || 0
            },
            totalNuggets,
            richestUser: richestUser ? {
                userId: richestUser.userId,
                coins: richestUser.coins || 0,
                discordName: richestResolved.discordName,
                discordTag: richestResolved.discordTag
            } : null,
            highestEloUser: highestEloUser ? {
                userId: highestEloUser.userId,
                elo: highestEloUser.elo || 0,
                discordName: highestResolved.discordName,
                discordTag: highestResolved.discordTag
            } : null
        });
    } catch (error) {
        console.error('Admin overview error:', error);
        return res.status(500).json({ error: 'Failed to load overview' });
    }
});

app.get('/admin/api/users', async (req, res) => {
    try {
        const page = parsePositiveInt(req.query.page, 1);
        const pageSize = 20;
        const search = String(req.query.search || '').trim().toLowerCase();
const projection = 'userId coins nuggets prestige elo isSlave gridUrl bountyShieldExpiry mediocrityExpiry trashTasteExpiry botBanExpiry doubleDipActive isekaiDiscountActive upgrades';
        const cache = new Map();

        if (!search) {
            const [total, users] = await Promise.all([
                User.countDocuments({}),
                User.find({})
                    .select(projection)
                    .sort({ userId: 1 })
                    .skip((page - 1) * pageSize)
                    .limit(pageSize)
                    .lean()
            ]);

            const enrichedUsers = await Promise.all(users.map(async (user) => {
                const identity = await resolveDiscordIdentity(user.userId, cache)
                    .catch(() => ({ discordName: 'Unknown', discordTag: 'Unknown' }));
                return { ...user, ...identity };
            }));

            return res.json({
                users: enrichedUsers,
                page,
                pageSize,
                total,
                totalPages: Math.max(1, Math.ceil(total / pageSize))
            });
        }

        const users = await User.find({}).select(projection).lean();
        const enrichedUsers = await Promise.all(users.map(async (user) => {
            const identity = await resolveDiscordIdentity(user.userId, cache)
                .catch(() => ({ discordName: 'Unknown', discordTag: 'Unknown' }));
            return { ...user, ...identity };
        }));

        const filteredUsers = enrichedUsers.filter((user) => {
            const discordName = (user.discordName || '').toLowerCase();
            const discordTag = (user.discordTag || '').toLowerCase();
            return user.userId.includes(search) || discordName.includes(search) || discordTag.includes(search);
        });

        const total = filteredUsers.length;
        const start = (page - 1) * pageSize;
        const pagedUsers = filteredUsers.slice(start, start + pageSize);

        return res.json({
            users: pagedUsers,
            page,
            pageSize,
            total,
            totalPages: Math.max(1, Math.ceil(total / pageSize))
        });
    } catch (error) {
        console.error('Admin users list error:', error);
        return res.status(500).json({ error: 'Failed to load users' });
    }
});

app.get('/admin/api/users/:userId', async (req, res) => {
    try {
        const user = await User.findOne({ userId: req.params.userId }).select(ADMIN_USER_DETAIL_PROJECTION).lean();
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        const discord = await resolveDiscordIdentity(user.userId);
        return res.json({ ...user, ...discord });
    } catch (error) {
        console.error('Admin user detail error:', error);
        return res.status(500).json({ error: 'Failed to load user' });
    }
});

app.patch('/admin/api/users/:userId', async (req, res) => {
    try {
        const existingUser = await User.findOne({ userId: req.params.userId }).lean();
        if (!existingUser) {
            return res.status(404).json({ error: 'User not found' });
        }

        const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
        const flattenedPatch = sanitizeFlattenedPatch(flattenPatch(req.body));

        if (Object.keys(flattenedPatch).length === 0) {
            return res.status(400).json({ error: 'No fields provided for update' });
        }

        await User.updateOne({ userId: req.params.userId }, { $set: flattenedPatch });
        recordFlattenedChanges({
            action: 'edit',
            entity: 'user',
            entityId: req.params.userId,
            beforeDoc: existingUser,
            flattenedPatch,
            note
        });

        const updatedUser = await User.findOne({ userId: req.params.userId }).lean();
        const discord = await resolveDiscordIdentity(req.params.userId);
        return res.json({ user: { ...updatedUser, ...discord } });
    } catch (error) {
        console.error('Admin user update error:', error);
        return res.status(500).json({ error: 'Failed to update user' });
    }
});

app.get('/admin/api/users/:userId/grid', async (req, res) => {
    try {
        const user = await User.findOne({ userId: req.params.userId }).select('userId gridUrl').lean();
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        if (!user.gridUrl) {
            return res.status(404).json({ error: 'No grid set' });
        }
        const discord = await resolveDiscordIdentity(user.userId);
        return res.json({
            userId: user.userId,
            gridUrl: user.gridUrl,
            ...discord
        });
    } catch (error) {
        console.error('Admin user grid error:', error);
        return res.status(500).json({ error: 'Failed to load grid' });
    }
});

app.delete('/admin/api/users/:userId/grid', async (req, res) => {
    try {
        const user = await User.findOne({ userId: req.params.userId }).select('userId gridUrl').lean();
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        await User.updateOne({ userId: req.params.userId }, { $set: { gridUrl: null } });
        pushAdminChange({
            action: 'delete',
            entity: 'user',
            entityId: req.params.userId,
            field: 'gridUrl',
            oldValue: user.gridUrl,
            newValue: null,
            timestamp: Date.now(),
            note: null
        });

        const discord = await resolveDiscordIdentity(req.params.userId);
        return res.json({ success: true, userId: req.params.userId, gridUrl: null, ...discord });
    } catch (error) {
        console.error('Admin remove grid error:', error);
        return res.status(500).json({ error: 'Failed to remove grid' });
    }
});

app.get('/admin/api/loans', async (req, res) => {
    try {
        const status = parseLoanStatus(req.query.status);
        const filter = status ? { status } : {};
        const loans = await Loan.find(filter).select('-__v').sort({ dueDate: 1 }).lean();
        const cache = new Map();

        const enrichedLoans = await Promise.all(loans.map(async (loan) => {
            const [borrowerDiscord, lenderDiscord] = await Promise.all([
                resolveDiscordIdentity(loan.borrowerId, cache).catch(() => ({ discordName: 'Unknown', discordTag: 'Unknown' })),
                resolveDiscordIdentity(loan.lenderId, cache).catch(() => ({ discordName: 'Unknown', discordTag: 'Unknown' }))
            ]);
            return {
                ...loan,
                borrowerDiscordName: borrowerDiscord.discordName,
                borrowerDiscordTag: borrowerDiscord.discordTag,
                lenderDiscordName: lenderDiscord.discordName,
                lenderDiscordTag: lenderDiscord.discordTag
            };
        }));

        return res.json({ loans: enrichedLoans });
    } catch (error) {
        console.error('Admin loans list error:', error);
        return res.status(500).json({ error: 'Failed to load loans' });
    }
});

app.patch('/admin/api/loans/:loanId', async (req, res) => {
    try {
        const loanQuery = createObjectIdQuery(req.params.loanId);
        const existingLoan = await Loan.findOne(loanQuery).lean();
        if (!existingLoan) {
            return res.status(404).json({ error: 'Loan not found' });
        }

        const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
        const flattenedPatch = sanitizeFlattenedPatch(flattenPatch(req.body));
        if (Object.keys(flattenedPatch).length === 0) {
            return res.status(400).json({ error: 'No fields provided for update' });
        }

        await Loan.updateOne(loanQuery, { $set: flattenedPatch });
        recordFlattenedChanges({
            action: 'edit',
            entity: 'loan',
            entityId: req.params.loanId,
            beforeDoc: existingLoan,
            flattenedPatch,
            note
        });

        const updatedLoan = await Loan.findOne(loanQuery).lean();
        const borrowerDiscord = await resolveDiscordIdentity(updatedLoan.borrowerId);
        const lenderDiscord = await resolveDiscordIdentity(updatedLoan.lenderId);

        return res.json({
            loan: {
                ...updatedLoan,
                borrowerDiscordName: borrowerDiscord.discordName,
                borrowerDiscordTag: borrowerDiscord.discordTag,
                lenderDiscordName: lenderDiscord.discordName,
                lenderDiscordTag: lenderDiscord.discordTag
            }
        });
    } catch (error) {
        console.error('Admin loan update error:', error);
        return res.status(500).json({ error: 'Failed to update loan' });
    }
});

app.post('/admin/api/loans/:loanId/forgive', async (req, res) => {
    try {
        const loanQuery = createObjectIdQuery(req.params.loanId);
        const loan = await Loan.findOne(loanQuery).lean();
        if (!loan) {
            return res.status(404).json({ error: 'Loan not found' });
        }
        if (loan.status === 'PAID') {
            return res.status(400).json({ error: 'Loan is already paid' });
        }

        await Loan.updateOne(loanQuery, { $set: { status: 'PAID', remainingAmount: 0 } });
        await User.updateOne(
            { userId: loan.borrowerId },
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

        pushAdminChange({
            action: 'forgive',
            entity: 'loan',
            entityId: req.params.loanId,
            field: 'status',
            oldValue: loan.status,
            newValue: 'PAID',
            timestamp: Date.now(),
            note: 'Loan forgiven from admin dashboard'
        });

        const borrowerDiscord = await resolveDiscordIdentity(loan.borrowerId);
        const lenderDiscord = await resolveDiscordIdentity(loan.lenderId);
        return res.json({
            success: true,
            loanId: req.params.loanId,
            borrowerId: loan.borrowerId,
            lenderId: loan.lenderId,
            borrowerDiscordName: borrowerDiscord.discordName,
            borrowerDiscordTag: borrowerDiscord.discordTag,
            lenderDiscordName: lenderDiscord.discordName,
            lenderDiscordTag: lenderDiscord.discordTag
        });
    } catch (error) {
        console.error('Admin loan forgive error:', error);
        return res.status(500).json({ error: 'Failed to forgive loan' });
    }
});

app.get('/admin/api/auctions', async (req, res) => {
    try {
        const auctions = await Auction.find({}).select('-__v').sort({ endTime: 1 }).lean();
        const cache = new Map();
        const enrichedAuctions = await Promise.all(auctions.map(async (auction) => {
            const slaveDiscord = await resolveDiscordIdentity(auction.slaveId, cache);
            const sellerDiscord = await resolveDiscordIdentity(auction.sellerId, cache);
            const bidderDiscord = await resolveDiscordIdentity(auction.currentBidder, cache);
            return {
                ...auction,
                slaveDiscordName: slaveDiscord.discordName,
                slaveDiscordTag: slaveDiscord.discordTag,
                sellerDiscordName: sellerDiscord.discordName,
                sellerDiscordTag: sellerDiscord.discordTag,
                bidderDiscordName: bidderDiscord.discordName,
                bidderDiscordTag: bidderDiscord.discordTag
            };
        }));

        return res.json({ auctions: enrichedAuctions });
    } catch (error) {
        console.error('Admin auctions list error:', error);
        return res.status(500).json({ error: 'Failed to load auctions' });
    }
});

app.delete('/admin/api/auctions/:auctionId', async (req, res) => {
    try {
        const auctionId = req.params.auctionId;
        const filter = mongoose.Types.ObjectId.isValid(auctionId)
            ? { $or: [{ _id: auctionId }, { auctionId }] }
            : { auctionId };

        const existingAuction = await Auction.findOne(filter).lean();
        if (!existingAuction) {
            return res.status(404).json({ error: 'Auction not found' });
        }

        await Auction.updateOne(filter, { $set: { active: false } });
        pushAdminChange({
            action: 'delete',
            entity: 'auction',
            entityId: auctionId,
            field: 'active',
            oldValue: existingAuction.active,
            newValue: false,
            timestamp: Date.now(),
            note: 'Auction cancelled from admin dashboard'
        });

        return res.json({ success: true, auctionId, active: false });
    } catch (error) {
        console.error('Admin auction cancel error:', error);
        return res.status(500).json({ error: 'Failed to cancel auction' });
    }
});

app.get('/admin/api/stats', async (req, res) => {
    try {
        const stats = await ServerStats.findOne({}).lean();
        return res.json({ stats: stats || {} });
    } catch (error) {
        console.error('Admin stats load error:', error);
        return res.status(500).json({ error: 'Failed to load stats' });
    }
});

app.patch('/admin/api/stats', async (req, res) => {
    try {
        const existingStats = await ServerStats.findOne({}).lean();
        if (!existingStats) {
            return res.status(404).json({ error: 'ServerStats not found' });
        }

        const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
        const payload = { ...req.body };
        if (payload.clearWeeklyClaimers) {
            payload.weeklyClaimers = [];
            delete payload.clearWeeklyClaimers;
        }
        const flattenedPatch = sanitizeFlattenedPatch(flattenPatch(payload));
        if (Object.keys(flattenedPatch).length === 0) {
            return res.status(400).json({ error: 'No fields provided for update' });
        }

        await ServerStats.updateOne({ _id: existingStats._id }, { $set: flattenedPatch });
        recordFlattenedChanges({
            action: 'edit',
            entity: 'stats',
            entityId: String(existingStats._id),
            beforeDoc: existingStats,
            flattenedPatch,
            note
        });

        const updatedStats = await ServerStats.findOne({ _id: existingStats._id }).lean();
        return res.json({ stats: updatedStats });
    } catch (error) {
        console.error('Admin stats update error:', error);
        return res.status(500).json({ error: 'Failed to update stats' });
    }
});

app.get('/admin/api/relationships', async (req, res) => {
    try {
        const status = parseRelationshipStatus(req.query.status);
        const filter = status ? { status } : {};
        const relationships = await Relationship.find(filter).select('-__v').sort({ confirmedAt: -1 }).lean();
        const cache = new Map();

        const enrichedRelationships = await Promise.all(relationships.map(async (relationship) => {
            const user1Discord = await resolveDiscordIdentity(relationship.user1Id, cache);
            const user2Discord = await resolveDiscordIdentity(relationship.user2Id, cache);
            return {
                ...relationship,
                user1DiscordName: user1Discord.discordName,
                user1DiscordTag: user1Discord.discordTag,
                user2DiscordName: user2Discord.discordName,
                user2DiscordTag: user2Discord.discordTag
            };
        }));

        return res.json({ relationships: enrichedRelationships });
    } catch (error) {
        console.error('Admin relationships list error:', error);
        return res.status(500).json({ error: 'Failed to load relationships' });
    }
});

app.patch('/admin/api/relationships/:relId', async (req, res) => {
    try {
        const relQuery = createObjectIdQuery(req.params.relId);
        const existingRel = await Relationship.findOne(relQuery).lean();
        if (!existingRel) {
            return res.status(404).json({ error: 'Relationship not found' });
        }

        const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
        const flattenedPatch = sanitizeFlattenedPatch(flattenPatch(req.body));
        if (Object.keys(flattenedPatch).length === 0) {
            return res.status(400).json({ error: 'No fields provided for update' });
        }

        await Relationship.updateOne(relQuery, { $set: flattenedPatch });
        recordFlattenedChanges({
            action: 'edit',
            entity: 'relationship',
            entityId: req.params.relId,
            beforeDoc: existingRel,
            flattenedPatch,
            note
        });

        const updatedRel = await Relationship.findOne(relQuery).lean();
        const user1Discord = await resolveDiscordIdentity(updatedRel.user1Id);
        const user2Discord = await resolveDiscordIdentity(updatedRel.user2Id);

        return res.json({
            relationship: {
                ...updatedRel,
                user1DiscordName: user1Discord.discordName,
                user1DiscordTag: user1Discord.discordTag,
                user2DiscordName: user2Discord.discordName,
                user2DiscordTag: user2Discord.discordTag
            }
        });
    } catch (error) {
        console.error('Admin relationship update error:', error);
        return res.status(500).json({ error: 'Failed to update relationship' });
    }
});

app.get('/admin/api/audit', (req, res) => {
    return res.json({ changes: adminChangeLog });
});

// ==================== STARTUP LOGIC ====================
client.once('clientReady', async () => {
    console.log("🔌 Connecting to Database...");
    await connectDB();
    console.log(`🚀 Tsun is online as ${client.user.tag}`);

    // Ensure ServerStats exists for every guild (prevents rotateFeaturedBanner from silently skipping on fresh DB)
    for (const [, guild] of client.guilds.cache) {
        await ServerStats.findOneAndUpdate(
            { guildId: guild.id },
            { $setOnInsert: { guildId: guild.id } },
            { upsert: true }
        );
    }

    // Rotate featured gacha banner (picks random mythic title, rotates every 3 days)
    rotateFeaturedBanner();

    client.user.setPresence({
        activities: [{ name: 'judging your taste', type: ActivityType.Watching }],
        status: 'online'
    });

    // 0. INITIAL ROLE SYNC (Startup)
    client.guilds.cache.forEach(async guild => {
        await roleSync.ensureAllRoles(guild);
        await roleSync.syncAllUserTitleRoles(guild);
        await roleSync.syncAllUserPrestigeRoles(guild);
        await roleSync.syncTrueMemberRoles(guild);
        await roleSync.syncBasicallyEveryoneRoles(guild);
    });

    // 0.5 INITIALIZE MANGA CACHE
    mangaCache.init();

    // 1. ELECTION TIMER CHECKER (Runs every 30 seconds)
    setInterval(() => {
        electionSystem.checkTimers(client);
    }, 30 * 1000);


    // 3. BOT BAN AUTO-REMOVER (Runs every 1 minute)
    setInterval(async () => {
        const now = Date.now();
        const bannedUsers = await User.find({ botBanExpiry: { $gt: 0, $lt: now } }).lean();

        for (const bannedUser of bannedUsers) {
            await User.updateOne({ _id: bannedUser._id }, { $set: { botBanExpiry: 0 } });
            console.log(`🔓 Unbanned user ${bannedUser.userId} from bot usage.`);
        }
    }, 60 * 1000);

    // 4. LOAN DEFAULT CHECKER (Runs every 1 minute)
    setInterval(async () => {
        const now = Date.now();
        // Find loans that are ACTIVE but past their due date
        const expiredLoans = await Loan.find({ status: 'ACTIVE', dueDate: { $lt: now } }).lean();

        if (expiredLoans.length > 0) {
            console.log(`💸 Processing ${expiredLoans.length} defaulted loans...`);
        }

        for (const loan of expiredLoans) {
            // 1. Update Loan Status Atomically to prevent double defaulting
            const updateResult = await Loan.updateOne(
                { _id: loan._id, status: 'ACTIVE' },
                { $set: { status: 'DEFAULTED' } }
            );
            
            if (updateResult.modifiedCount === 0) continue; // Already processed by another thread

            // 2. Update Borrower Status (Become Slave)
            await User.findOneAndUpdate(
                { userId: loan.borrowerId },
                {
                    $set: {
                        isSlave: true,
                        slaveOwner: loan.lenderId,
                        carrotResistUsed: false,
                        resistExpiresAt: 0,
                        ...CARROT_RESET_SET
                    }
                }
            );

            // 3. Discord Actions (Nickname Shaming & Announcement)
            client.guilds.cache.forEach(async guild => {
                try {
                    const member = await guild.members.fetch(loan.borrowerId).catch(() => null);
                    if (!member) return;

                    let lenderName = "Master";
                    try {
                        const lenderMember = await guild.members.fetch(loan.lenderId);
                        lenderName = lenderMember.displayName;
                    } catch (e) {
                        const lenderUser = await client.users.fetch(loan.lenderId).catch(() => null);
                        if (lenderUser) lenderName = lenderUser.username;
                    }

                    const suffix = ` (${lenderName}'s Slave)`;
                    const maxBaseLen = 32 - suffix.length;

                    if (maxBaseLen > 0) {
                        if (guild.members.me.permissions.has(PermissionFlagsBits.ManageNicknames) && member.manageable) {
                            const oldName = member.displayName.replace(socialSystem.REL_SUFFIX_REGEX, '');
                            if (!oldName.includes(suffix)) {
                                const newName = oldName.substring(0, maxBaseLen) + suffix;
                                await member.setNickname(newName);
                            }
                        }

                        // Strip Privileged Roles (Owner/Fatso) immediately on default
                        await roleSync.stripPrivilegedRoles(guild, loan.borrowerId);
                    }

                    // SEARCH FOR CHANNEL IN TSUN OR TSUN-ALT
                    const channel = guild.channels.cache.find(c => [config.CHANNELS.MAIN, config.CHANNELS.ALT].includes(c.name));
                    if (channel) {
                        const embed = new EmbedBuilder()
                            .setColor(0x000000)
                            .setTitle("🔔 DEBT DEFAULT!")
                            .setDescription(
                                `<@${loan.borrowerId}> failed to repay their debt to <@${loan.lenderId}>!\n\n` +
                                `⛓️ **They are now a SLAVE!**\n` +
                                `📉 **Penalties:**\n` +
                                `• 40% of income goes to Owner.\n` +
                                `• 20% of income goes to Loan Repayment.\n` +
                                `• Name changed to show submission.`
                            )

                        channel.send({ content: `<@${loan.borrowerId}>`, embeds: [embed] });
                    }

                } catch (err) {
                    console.error(`Error processing default for ${loan.borrowerId} in guild ${guild.id}:`, err);
                }
            });
        }
    }, 60 * 1000);

    // 5. STATS RESETTER (Runs every 1 hour)
    setInterval(() => utilitySystem.checkAndResetStats(), 60 * 60 * 1000);

    // MARKET LISTING EXPIRY (Runs every 1 hour)
    setInterval(() => marketSystem.checkExpiredListings(client), 60 * 60 * 1000);

    // 6. DAILY WEALTH TAX (Runs every 1 minute)
    setInterval(() => {
        economySystem.checkAndApplyDailyTax(client);
    }, 60 * 1000);

    // 7. SLAVE PASSIVE INCOME (Runs every hour)
    setInterval(async () => {
        try {
            const slaves = await User.find({ isSlave: true, slaveOwner: { $ne: null } }).lean();

            for (const slave of slaves) {
                // Calculate income based on daily messages
                const dailyMessages = slave.stats?.daily?.messages || 0;
                const prestige = slave.prestige || 0;
                const prestigeMultiplier = 1.0 + (prestige * 0.2);
                let hourlyIncome = Math.floor(100 + (dailyMessages / 10) * prestigeMultiplier);
                const now = Date.now();
                const carrotActive = slave.activeCarrot?.expiresAt > now;
                const resistActive = (slave.resistExpiresAt || 0) > now;

                if (carrotActive && !resistActive) {
                    hourlyIncome += slave.activeCarrot.bonusPerHr || 0;
                }

                if (slave.activeCarrot?.expiresAt && slave.activeCarrot.expiresAt <= now) {
                    await User.findOneAndUpdate(
                        { userId: slave.userId },
                        { $set: CARROT_RESET_SET }
                    );
                }

                // Only process if there's income to give
                if (hourlyIncome > 0) {
                    // Use distributeIncome to properly apply taxes, vault caps, and loan repayments
                    // NOTE: Amulets are NOT consumed for passive income (only for active wins)
                    const log = await distributeIncome(slave.userId, hourlyIncome);

                    // Track stats for both master and slave atomically
                    const ownerCut = Math.floor(hourlyIncome * config.ECONOMY.SLAVE_TAX_RATE);
                    await User.updateOne({ userId: slave.slaveOwner }, { $inc: { masterIncomeFromSlaves: ownerCut } });
                    await User.updateOne({ userId: slave.userId }, { $inc: { slaveIncomeGenerated: hourlyIncome } });

                    console.log(`💰 Slave ${slave.userId} generated ${hourlyIncome} coins for master ${slave.slaveOwner}${log ? ' (taxed)' : ''}`);
                }
            }
        } catch (err) {
            console.error("Error processing slave passive income:", err);
        }
    }, 60 * 60 * 1000); // Every 1 hour

    // 7.5. IDLE COINS (Runs every hour — passive income by weekly activity rank)
    setInterval(async () => {
        try {
            const users = await User.find({ 'stats.weekly.messages': { $gt: 0 } })
                .sort({ 'stats.weekly.messages': -1 })
                .select('userId stats.weekly.messages')
                .lean();

            if (users.length === 0) return;

            const ic = config.IDLE_COINS;
            for (let i = 0; i < users.length; i++) {
                const rank = i + 1;
                let amount;
                if (rank === 1) amount = ic.RANK_1;
                else if (rank === 2) amount = ic.RANK_2;
                else if (rank === 3) amount = ic.RANK_3;
                else if (rank <= 5) amount = ic.RANK_4_5;
                else if (rank <= 10) amount = ic.RANK_6_10;
                else if (rank <= 30) amount = ic.RANK_11_30;
                else if (rank <= 50) amount = ic.RANK_31_50;
                else if (rank <= 100) amount = ic.RANK_51_100;
                else amount = ic.DEFAULT;

                await distributeIncome(users[i].userId, amount);
            }
            console.log(`💤 Idle coins: distributed to ${users.length} users`);
        } catch (err) {
            console.error("Error processing idle coins:", err);
        }
    }, 60 * 60 * 1000); // Every 1 hour

    // 8. VAULT INTEREST & RESET (Runs every 1 hour, checks if 24h passed)
    setInterval(async () => {
        try {
            const now = Date.now();
            const usersWithVault = await User.find({ vaultCoins: { $gt: 0 } }).lean();

            for (const u of usersWithVault) {
                // Check if 24 hours passed since last interest
                if (!u.lastVaultInterest || (now - u.lastVaultInterest) >= (24 * 60 * 60 * 1000)) {
                    
                    // ACTIVITY CHECK: Must have messaged in last 24h
                    // We check lastActiveTime for precision.
                    const lastActive = u.lastActiveTime || 0;
                    const isActive = (now - lastActive) < (24 * 60 * 60 * 1000);

                    let interestPaid = 0;
                    if (isActive) {
                        const interest = Math.floor(u.vaultCoins * config.VAULT.INTEREST_RATE);
                        
                        // Cap check
                        const prestigeLevel = u.prestige || 0;
                        const vaultTier = u.upgrades?.vaultTier || 0;
                        const titanVaultUsed = !!u.titanVaultUsed;
                        const maxCapacity = getVaultCap(prestigeLevel, vaultTier, titanVaultUsed);
                        
                        if (u.vaultCoins + interest <= maxCapacity) {
                            interestPaid = interest;
                            console.log(`🏦 Paid ${interestPaid} interest to ${u.userId}`);
                        } else {
                             // Fill to max
                             const space = Math.max(0, maxCapacity - u.vaultCoins);
                             interestPaid = space;
                             console.log(`🏦 Paid partial interest ${interestPaid} to ${u.userId} (Cap Reached)`);
                        }
                    }

                    // Intentional behavior: reset daily withdrawal window every 24h even if inactive.
                    // Activity check gates interest only; withdrawals remain available to all vault holders.
                    // Reset Withdrawal Limit & Update Timer Atomically
                    await User.updateOne(
                        { userId: u.userId }, 
                        { 
                            $inc: { vaultCoins: interestPaid },
                            $set: { vaultDailyWithdrawn: 0, lastVaultInterest: now } 
                        }
                    );
                }
            }
        } catch (e) {
            console.error("Vault Interest Error:", e);
        }
    }, 60 * 60 * 1000); // Every 1 hour

    // 9. AUCTION EXPIRY CHECKER (Runs every 1 minute)
    setInterval(async () => {
        try {
            const expiredAuctions = await Auction.find({ active: true, endTime: { $lt: Date.now() } }).lean();

            for (const auction of expiredAuctions) {
                // Pre-Lock the Auction to strictly prevent duplicate thread execution
                const lock = await Auction.findOneAndUpdate(
                    { _id: auction._id, active: true },
                    { $set: { active: false } }
                );

                const guild = client.guilds.cache.get(auction.guildId);
                if (!guild) continue;

                const channel = guild.channels.cache.find(ch => ch.name === config.CHANNELS.MAIN || ch.name === config.CHANNELS.GENERAL);
                if (!channel) continue;

                // CASE 1: No bids - slave stays with owner
                if (!auction.currentBidder || auction.currentBid === 0) {
                    channel.send(`⏰ Auction for <@${auction.slaveId}> ended with **no bids**. Slave remains with owner.`);
                    continue;
                }

                // CASE 2: Successful sale - transfer ownership
                const slave = await User.findOne({ userId: auction.slaveId }).select('userId').lean();
                const seller = await User.findOne({ userId: auction.sellerId }).select('userId').lean();
                const winner = await User.findOne({ userId: auction.currentBidder }).select('userId').lean();

                if (!slave || !seller || !winner) {
                    console.error(`Auction ${auction.auctionId} - Missing user data`);
                    continue;
                }

                // Calculate payment: 95% to seller, 5% burned
                const sellerProceeds = Math.floor(auction.currentBid * 0.95);
                const burned = auction.currentBid - sellerProceeds;

                // Pay seller through distributeIncome (applies Rich Tax, Slave Tax, Loan Repayment, Vault Cap)
                await distributeIncome(seller.userId, sellerProceeds);

                // Transfer ownership Atomically
                await User.findOneAndUpdate(
                    { userId: slave.userId },
                    {
                        $set: {
                            slaveOwner: winner.userId,
                            carrotResistUsed: false,
                            resistExpiresAt: 0,
                            ...CARROT_RESET_SET
                        }
                    }
                );

                // Transfer debt to new owner Atomically
                await Loan.updateOne(
                    { borrowerId: slave.userId, lenderId: seller.userId, status: { $in: ['ACTIVE', 'DEFAULTED'] } },
                    { $set: { lenderId: winner.userId } }
                );

                // Update nickname
                try {
                    const member = await guild.members.fetch(slave.userId);
                    const winnerMember = await guild.members.fetch(winner.userId);
                    const cleanName = member.displayName.replace(/\s\([^)]*'s Slave\)$/, "").replace(socialSystem.REL_SUFFIX_REGEX, '');
                    let lenderName = winnerMember.displayName;
                    if (lenderName.length > 15) lenderName = lenderName.substring(0, 15) + '..';
                    const suffix = ` (${lenderName}'s Slave)`;
                    const maxLen = Math.max(1, 32 - suffix.length);
                    const newName = cleanName.substring(0, maxLen) + suffix;
                    
                    if (member.manageable) {
                        await member.setNickname(newName);
                    }
                } catch (e) {
                    console.log("Failed to update slave nickname:", e);
                }

                // Announce
                const embed = new EmbedBuilder()
                    .setColor(0xFFD700)
                    .setTitle("🔨 AUCTION ENDED!")
                    .setDescription(
                        `**<@${auction.slaveId}>** has been sold!\n\n` +
                        `🏆 **Winner:** <@${winner.userId}>\n` +
                        `💰 **Final Bid:** ${auction.currentBid.toLocaleString('en-US')} coins\n` +
                        `💵 **Seller Received:** ${sellerProceeds.toLocaleString('en-US')} (95%)\n` +
                        `🔥 **Burned:** ${burned.toLocaleString('en-US')} (5%)\n\n` +
                        `Ownership and all debts have been transferred.`
                    );

                channel.send({ embeds: [embed] });
                console.log(`✅ Auction ${auction.auctionId} completed - ${slave.userId} sold for ${auction.currentBid}`);
            }
        } catch (err) {
            console.error("Error processing auction expiry:", err);
        }
    }, 60 * 1000); // Every 1 minute

    // 10. COMPREHENSIVE ROLE SYNC (Titles + Prestige) - Runs every 24 hours
    setInterval(async () => {
        try {
            console.log("🔄 Running Daily Role Sync...");
            for (const guild of client.guilds.cache.values()) {
                await roleSync.ensureAllRoles(guild);
                await roleSync.syncAllUserTitleRoles(guild);
                await roleSync.syncAllUserPrestigeRoles(guild);
                await roleSync.syncTrueMemberRoles(guild);
                await roleSync.syncBasicallyEveryoneRoles(guild);
            }
            console.log("✅ Daily Role Sync Complete.");
        } catch (err) {
            console.error("Error in daily role sync:", err);
        }
    }, 24 * 60 * 60 * 1000); // Every 24 hours

    // 11. RELATIONSHIP MILESTONES & NEGLECT DECAY (Runs every 1 hour)
    setInterval(() => {
        socialSystem.checkRelationshipDecayAndMilestones();
    }, 60 * 60 * 1000);

    // 12. FEATURED GACHA BANNER ROTATION (Runs every 1 hour, rotates every 3 days)
    setInterval(() => {
        rotateFeaturedBanner();
    }, 60 * 60 * 1000);

    // 13. TSUNSTOCKS: Hourly snapshot + inactivity decay
    setInterval(async () => {
        try {
            await stockEngine.snapshotPrices();
            await stockEngine.runInactivityDecay();
        } catch (err) {
            console.error('[TsunStocks] Hourly timer error:', err);
        }
    }, 60 * 60 * 1000);

    // 14. TSUNSTOCKS: Daily reset (previousClose, CEO salary, dividends, Blue Chip role)
    setInterval(async () => {
        try {
            const { ceoPayouts } = await stockEngine.runDailyReset();

            // Pay CEO salaries via distributeIncome
            for (const { userId, amount } of ceoPayouts) {
                try {
                    await distributeIncome(userId, amount);
                } catch (e) {
                    console.error(`[TsunStocks] CEO salary error for ${userId}:`, e.message);
                }
            }

            // Pay dividends to holders of top 5 most active users
            const topActive = await User.find({})
                .sort({ 'stats.daily.messages': -1 })
                .limit(config.STOCKS.DIVIDEND_TOP_N)
                .select('userId');
            const topIds = topActive.map(u => u.userId);

            if (topIds.length > 0) {
                const Portfolio = require('./models/Portfolio');
                const holdings = await Portfolio.find({ targetUserId: { $in: topIds }, shares: { $gt: 0 } });
                for (const h of holdings) {
                    const dividendAmount = h.shares * config.STOCKS.DIVIDEND_PER_SHARE;
                    if (dividendAmount > 0) {
                        try {
                            await distributeIncome(h.ownerId, dividendAmount);
                        } catch (e) {
                            console.error(`[TsunStocks] Dividend error for ${h.ownerId}:`, e.message);
                        }
                    }
                }
                console.log(`[TsunStocks] Dividends paid for ${holdings.length} holdings across top ${topIds.length} active users.`);
            }

            // Sync Blue Chip role (top 5 stock prices)
            const Stock = require('./models/Stock');
            const topStocks = await Stock.find({}).sort({ currentPrice: -1 }).limit(config.STOCKS.BLUE_CHIP_COUNT);
            const blueChipIds = new Set(topStocks.map(s => s.userId));
            for (const [, guild] of client.guilds.cache) {
                const role = guild.roles.cache.find(r => r.name === config.STOCKS.BLUE_CHIP_ROLE);
                if (!role) {
                    // Create the role if it doesn't exist
                    try {
                        const newRole = await guild.roles.create({ name: config.STOCKS.BLUE_CHIP_ROLE, color: 0xFFD700, reason: 'TsunStocks Blue Chip role' });
                        for (const uid of blueChipIds) {
                            const member = await guild.members.fetch(uid).catch(() => null);
                            if (member) await member.roles.add(newRole).catch(() => {});
                        }
                    } catch (e) {
                        console.error('[TsunStocks] Failed to create Blue Chip role:', e.message);
                    }
                    continue;
                }
                // Remove from everyone, then add to top 5
                for (const [, member] of role.members) {
                    if (!blueChipIds.has(member.id)) {
                        await member.roles.remove(role).catch(() => {});
                    }
                }
                for (const uid of blueChipIds) {
                    const member = await guild.members.fetch(uid).catch(() => null);
                    if (member && !member.roles.cache.has(role.id)) {
                        await member.roles.add(role).catch(() => {});
                    }
                }
            }
            console.log('[TsunStocks] Daily reset + Blue Chip sync complete.');
        } catch (err) {
            console.error('[TsunStocks] Daily timer error:', err);
        }
    }, 24 * 60 * 60 * 1000);
});

// ==================== MESSAGE HANDLER ====================
const guildMessageCounts = new Map();

// Caching Maps
const buzzwordCooldowns = new Map(); // user id -> timestamp
const profileUpdateCooldowns = createCleaningMap(3600000, 1800000); // 1h cooldown per user

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // 0. Stats Tracking (moved before ban check so stats are always tracked)
    utilitySystem.trackMessage(message);

    // 0.1 TsunStocks: update stock price on message activity
    stockEngine.onMessage(message.author.id);

    // 0.2 Cache Discord Profile (throttled to 1h per user)
    if (!profileUpdateCooldowns.get(message.author.id)) {
        profileUpdateCooldowns.set(message.author.id, true);
        User.updateOne(
            { userId: message.author.id },
            { $set: { 
                displayName: message.member?.displayName || message.author.username,
                avatarUrl: message.author.displayAvatarURL({ size: 128, extension: 'png' }) || null
            }},
            { upsert: true }
        ).catch(err => console.error('[Profile Cache] Error:', err.message));
    }

    // 0.5 Buzzword Tracking (fire-and-forget, non-blocking, 30s cooldown per user)
    if (BUZZWORD_SET.size > 0) {
        const lastBuzz = buzzwordCooldowns.get(message.author.id);
        const now = Date.now();
        if (!lastBuzz || now - lastBuzz >= 15000) {
            const words = message.content.toLowerCase().split(/[^a-zA-Z0-9]+/).filter(Boolean);
            const hits = new Map();
            for (const word of words) {
                if (BUZZWORD_SET.has(word)) hits.set(word, Math.min((hits.get(word) || 0) + 1, 3));
            }
            if (hits.size > 0) {
                buzzwordCooldowns.set(message.author.id, now);
                for (const [keyword, count] of hits) {
                    BuzzwordCount.updateOne(
                        { keyword, userId: message.author.id },
                        { $inc: { count } },
                        { upsert: true }
                    ).catch(err => console.error('[BUZZ] Tracking error:', err.message));
                }
            }
        }
    }


    // 1. Bot Ban Check (Only for commands, not every message)
    const cmd = message.content.toLowerCase().split(' ')[0];
    if (cmd.startsWith('!')) {
        const user = await User.findOne({ userId: message.author.id });
        if (user && user.botBanExpiry > Date.now()) {
            const remaining = user.botBanExpiry - Date.now();
            const hours = Math.floor(remaining / 3600000);
            const mins = Math.ceil((remaining % 3600000) / 60000);
            const timeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins} minute(s)`;
            return message.reply(`🚫 You're banned from using the bot for ${timeStr}, idiot! >///<`);
        }
    }

    // 2. Coin Bag Drop (UPDATED: Allows tsun-alt)
    if (message.guild && [config.CHANNELS.MAIN, config.CHANNELS.ALT].includes(message.channel.name)) {
        let count = guildMessageCounts.get(message.guild.id) || 0;
        count++;
        guildMessageCounts.set(message.guild.id, count);

        if (!guildMessageCounts.has(message.guild.id + '_target')) {
            guildMessageCounts.set(message.guild.id + '_target', Math.floor(Math.random() * (config.TIMING.COIN_BAG_MAX - config.TIMING.COIN_BAG_MIN + 1)) + config.TIMING.COIN_BAG_MIN);
        }

        let target = guildMessageCounts.get(message.guild.id + '_target');
        if (count >= target) {
            dropCoinBag(message.channel);
            guildMessageCounts.set(message.guild.id, 0);
            guildMessageCounts.set(message.guild.id + '_target', Math.floor(Math.random() * (config.TIMING.COIN_BAG_MAX - config.TIMING.COIN_BAG_MIN + 1)) + config.TIMING.COIN_BAG_MIN);
        }
    }

    // 3. Auto !guess in #general (Triggers every GUESS_TRIGGER messages)
    if (message.guild && message.channel.name === config.CHANNELS.GENERAL) {
        let guessCount = guildMessageCounts.get(message.guild.id + '_guess') || 0;
        guessCount++;
        guildMessageCounts.set(message.guild.id + '_guess', guessCount);

        if (guessCount >= config.TIMING.GUESS_TRIGGER) {
            guildMessageCounts.set(message.guild.id + '_guess', 0);
            // Auto-trigger !guess
            battleSystem.startGuessGame(message);
        }

        // 4. Auto-comment with tsundere phrases (Triggers every PHRASE_TRIGGER messages)
        let phraseCount = guildMessageCounts.get(message.guild.id + '_phrase') || 0;
        phraseCount++;
        guildMessageCounts.set(message.guild.id + '_phrase', phraseCount);

        if (phraseCount >= config.TIMING.PHRASE_TRIGGER) {
            guildMessageCounts.set(message.guild.id + '_phrase', 0);
            postRandomPhrase(message.channel, message.guild);
        }
    }

    // 3. Command Routing
    const args = message.content.split(' ');

    // --- CENTRALIZED CHANNEL RESTRICTION ---
    const GAMBLING_COMMANDS = config.GAMBLING_COMMANDS;

    if (GAMBLING_COMMANDS.includes(cmd)) {
        if (![config.CHANNELS.MAIN, config.CHANNELS.ALT].includes(message.channel.name)) {
            return message.reply("H-Hah? This isn't the gambling hall! Go to #tsun or #tsun-alt if you want to throw your life away! I'm not dealing with your addiction here! (¬_¬)");
        }
    }
    // ---------------------------------------

    if (cmd === '!giveaway') {
        if (message.author.id !== config.OWNER_ID) {
            return message.reply("H-Hah? Only the owner can give away money, you greedy bastard! Know your place! >///< ");
        }

        const isNuggets = args[1]?.toLowerCase() === 'nuggets';
        const amountIndex = isNuggets ? 3 : 2;
        const amount = parseInt(args[amountIndex]);
        const currencyName = isNuggets ? 'nuggets' : 'coins';
        const currencyEmoji = isNuggets ? '💎' : '💰';

        if (isNaN(amount) || amount <= 0) return message.reply("Invalid amount! Usage: `!giveaway [nuggets] @user/@role [amount]`");

        // Check for role mention first
        const targetRole = message.mentions.roles.first();
        if (targetRole) {
            // Try to fetch all members to ensure we get offline ones, but handle rate limits gracefully
            try {
                if (message.guild.memberCount !== message.guild.members.cache.size) {
                    await message.guild.members.fetch();
                }
            } catch (err) {
                console.warn(`[Giveaway] Rate limited or failed to fetch all members, falling back to cached members: ${err.message}`);
            }

            // Re-fetch role from cache to ensure member list is updated
            const role = message.guild.roles.cache.get(targetRole.id);

            // Distribute to all members in the role
            const members = role.members.filter(m => !m.user.bot);

            if (members.size === 0) {
                return message.reply("That role has no members (excluding bots)! What a waste... (¬_¬)");
            }

            let successCount = 0;
            let totalDistributed = 0;

            for (const [memberId, member] of members) {
                try {
                    if (isNuggets) {
                        await User.findOneAndUpdate(
                            { userId: memberId },
                            { $inc: { nuggets: amount } },
                            { upsert: true }
                        );
                    } else {
                        await distributeIncome(memberId, amount);
                    }
                    successCount++;
                    totalDistributed += amount;
                } catch (e) {
                    console.error(`Failed to give ${currencyName} to ${memberId}:`, e);
                }
            }

            return message.reply(
                `🎁 **MASS GIVEAWAY!**\n` +
                `${currencyEmoji} **${amount.toLocaleString('en-US')} ${currencyName}** given to **${successCount}/${members.size}** members with the **${targetRole.name}** role!\n` +
                `📊 **Total Distributed:** ${totalDistributed.toLocaleString('en-US')} ${currencyName}\n` +
                `I-It's not like I wanted to be generous or anything! >///< `
            );
        }

        // Single user mention
        const target = message.mentions.users.first();
        if (!target) return message.reply("Tag someone or a role to give money to! Usage: `!giveaway [nuggets] @user/@role [amount]`");

        if (isNuggets) {
            await User.findOneAndUpdate(
                { userId: target.id },
                { $inc: { nuggets: amount } },
                { upsert: true }
            );
            return message.reply(`🎁 **GIVEAWAY!** ${target.username} received **${amount} nuggets** from the owner!`);
        } else {
            const log = await distributeIncome(target.id, amount);
            return message.reply(`🎁 **GIVEAWAY!** ${target.username} received **${amount} coins** from the owner!${log}`);
        }
    }

    if (cmd === '!owner') {
        if (message.author.id !== config.OWNER_ID) {
            return message.reply("H-Hah? Only the TRUE owner can use this command! Baka! >///<");
        }

        const guild = message.guild;
        if (!guild) return;

        const ownerRoleName = config.ROLES?.OWNER || 'Owner';
        const role = guild.roles.cache.find(r => r.name.toLowerCase() === ownerRoleName.toLowerCase());

        if (!role) {
            return message.reply(`❌ The **${ownerRoleName}** role doesn't exist in this server! You need to create it manually first, idiot! (¬_¬)`);
        }

        try {
            const member = await guild.members.fetch(message.author.id);
            if (member.roles.cache.has(role.id)) {
                return message.reply(`You already have the **${ownerRoleName}** role, dummy! Stop wasting my time! (¬_¬)`);
            }

            await member.roles.add(role, "Owner command used");
            return message.reply(`✅ **GRANTED!** You now have the **${ownerRoleName}** role. D-Don't let it go to your head! >///<`);
        } catch (e) {
            console.error("Failed to add owner role:", e);
            return message.reply("S-Something went wrong while adding the role... It's not my fault! Try again later! >///<");
        }
    }

    if (cmd === '!ban') {
        if (message.author.id !== config.OWNER_ID) return message.reply("H-Hah? Only the owner can ban people, you idiot! Know your place! >///<");
        const target = message.mentions.users.first();
        if (!target) return message.reply("Tag someone to ban, genius! Usage: `!ban @user [hours]` or `!ban @user` to unban");
        if (target.id === message.author.id) return message.reply("You can't ban yourself, baka!");

        const targetUser = await User.findOne({ userId: target.id }) || new User({ userId: target.id });
        const displayName = await getDisplayName(target.id, message.guild);

        // Unban: No time provided or 0
        if (!args[2] || parseInt(args[2]) === 0) {
            // Check if user was actually banned
            if (!targetUser.botBanExpiry || targetUser.botBanExpiry <= Date.now()) {
                return message.reply(`${displayName} isn't banned, dummy! There's nothing to unban! (¬_¬)`);
            }
            await User.updateOne({ userId: target.id }, { $set: { botBanExpiry: 0 } });
            return message.reply(`✅ **UNBANNED!** ${displayName} can use the bot again! I-It's not like I missed them or anything! >///<`);
        }

        // Ban: Time in HOURS (max 168 hours = 1 week)
        const banHours = parseFloat(args[2]);
        if (isNaN(banHours) || banHours <= 0 || banHours > 168) {
            return message.reply("Invalid time! Use hours (0.1-168), you moron! Example: `!ban @user 24` for 24 hours.");
        }

        const expiryMs = Date.now() + (banHours * 3600000); // hours to ms
        await User.updateOne(
            { userId: target.id }, 
            { $set: { botBanExpiry: expiryMs, gridUrl: null } },
            { upsert: true }
        );

        // Format readable time
        let readableTime;
        if (banHours < 1) {
            readableTime = `${Math.round(banHours * 60)} minute(s)`;
        } else if (banHours < 24) {
            readableTime = `${banHours} hour(s)`;
        } else {
            readableTime = `${Math.round(banHours / 24 * 10) / 10} day(s)`;
        }
        return message.reply(`🚫 **BANNED!** ${displayName} can't use the bot for ${readableTime}! Serves them right! >///< `);
    }

    // === RENAME COMMAND (OWNER ONLY) ===
    if (cmd === '!rename') {
        if (message.author.id !== config.OWNER_ID) {
            return message.reply("H-Hah? Only the owner can rename people, you idiot! Know your place! >///< ");
        }
        const target = message.mentions.users.first();
        if (!target) return message.reply("Tag someone to rename! Usage: `!rename @user [NewName]` or `!rename @user` to clear");
        if (target.id === message.author.id) return message.reply("You can't rename yourself, baka!");

        const targetUser = await User.findOne({ userId: target.id }) || new User({ userId: target.id });
        const newName = args.slice(2).join(' ').trim();

        // Clear forced nickname if no name provided or "clear"
        if (!newName || newName.toLowerCase() === 'clear') {
            await User.updateOne({ userId: target.id }, { $set: { forcedNickname: null } });
            const displayName = await getDisplayName(target.id, message.guild);
            return message.reply(`✅ **FREED!** ${displayName} can change their name again! N-Not that I care! >///< `);
        }

        // Set forced nickname
        const truncatedName = newName.substring(0, 32); // Discord max nickname length
        await User.updateOne(
            { userId: target.id }, 
            { $set: { forcedNickname: truncatedName } },
            { upsert: true }
        );

        // Apply the nickname immediately
        try {
            const member = await message.guild.members.fetch(target.id);
            if (member.manageable) {
                await member.setNickname(truncatedName);
            }
        } catch (e) {
            console.error("Failed to set forced nickname:", e);
        }

        const displayName = await getDisplayName(target.id, message.guild);
        return message.reply(`📛 **RENAMED!** ${target.username} is now **"${truncatedName}"**! They can't escape this name! (¬_¬)`);
    }

    // === REMOVE RENAME COMMAND (OWNER ONLY) ===
    if (cmd === '!removerename') {
        if (message.author.id !== config.OWNER_ID) {
            return message.reply("H-Hah? Only the owner can do this, you idiot! Know your place! >///< ");
        }
        const target = message.mentions.users.first();
        if (!target) return message.reply("Tag someone to free! Usage: `!removerename @user`");

        const targetUser = await User.findOne({ userId: target.id }).select('forcedNickname').lean();
        if (!targetUser || !targetUser.forcedNickname) {
            return message.reply(`${target.username} doesn't have a forced nickname! They're already free, baka! (¬_¬)`);
        }

        await User.updateOne({ userId: target.id }, { $set: { forcedNickname: null } });

        const displayName = await getDisplayName(target.id, message.guild);
        return message.reply(`✅ **FREED!** ${displayName} can change their name again! N-Not that I care! >///< `);
    }


    if (cmd === '!guess') {
        const type = args[1]?.toLowerCase();
        if (['opening', 'openings', 'ending', 'endings'].includes(type)) {
            return guessOpSystem.handle(message, client);
        }
        return battleSystem.handle(message, client);
    }

    if (cmd.startsWith('!duel') || (message.attachments.size > 0 && message.content.includes('!duel'))) {
        return battleSystem.handle(message, client);
    }

    if (cmd === '!higherlower' || cmd === '!hl') {
        if (![config.CHANNELS.MAIN, config.CHANNELS.ALT].includes(message.channel.name)) {
            return message.reply("Play games in #tsun or #tsun-alt, baka! (¬_¬)");
        }
        return higherLowerSystem.handle(message, client);
    }

    // UPDATED: Centralized check handles the channel restriction now
    if (['!shop', '!free', '!bag','!prestige', '!inventory', '!equip', '!unequip', '!curse', '!toss', '!slots', '!loan', '!rr', '!roulette', '!tax', '!bounty', '!wanted', '!isekai', '!gacha', '!freedom', '!auction', '!vault', '!slave', '!daily'].includes(cmd)) {
        return economySystem.handle(message, client);
    }

    if (['!startelection', '!cancelelection', '!endelection', '!electionstatus', '!electioncandidates', '!endpoll', '!endapplications'].includes(cmd)) {
        return electionSystem.handle(message, client);
    }

    // UPDATED: Added !goal and !claimweekly
    if (['!help', '!goal', '!claimweekly', '!resetserver', '!restoredailystreak', '!info', '!rels', '!relationships'].includes(cmd)) {
        return utilitySystem.handle(message, client);
    }

    if (cmd === '!leaderboard' || cmd === '!lb') {
        const type = args[1]?.toLowerCase();
        if (type === 'op' || type === 'ed') {
            return guessOpSystem.handle(message, client);
        }
        return leaderboardSystem.handle(message, client);
    }

    // Trade System
    if (cmd === '!trade') {
        return tradeSystem.handle(message, client);
    }

    // Market System
    if (cmd === '!market') {
        return marketSystem.handle(message, client);
    }

    // Forge System
    if (cmd === '!forge') {
        return forgeSystem.handle(message, client);
    }

    // Fishing System
    if (cmd === '!fish' || cmd === '!fishing' || cmd === '!fih') {
        return fishingSystem.handle(message, client);
    }

    // TsunStocks
    if (cmd === '!stock' || cmd === '!stocks') {
        return stockSystem.handle(message, client);
    }

    // Social Commands (any channel)
    if (['!hug', '!kiss', '!pat', '!slap', '!bonk', '!cuddle', '!poke', '!ship', '!propose', '!marry', '!breakup', '!rivals', '!shipbattle'].includes(cmd)) {
        // Jealousy mechanic — fire-and-forget, never blocks the command
        if ((cmd === '!hug' || cmd === '!kiss') && message.mentions.users.size > 0) {
            const hugTarget = message.mentions.users.first();
            (async () => {
                try {
                    const marriedRel = await Relationship.findOne({
                        $or: [
                            { user1Id: message.author.id, status: 'married' },
                            { user2Id: message.author.id, status: 'married' }
                        ]
                    });
                    if (!marriedRel) return;
                    const partnerId = marriedRel.user1Id === message.author.id ? marriedRel.user2Id : marriedRel.user1Id;
                    if (hugTarget.id === partnerId) return;
                    if (Math.random() >= 0.25) return;
                    const tsunChannel = message.guild.channels.cache.find(c => c.name === config.CHANNELS.MAIN);
                    if (tsunChannel) {
                        await tsunChannel.send(`Interesting choice, <@${message.author.id}>. I'm sure <@${partnerId}> won't mind. Probably. >////<`);
                    }
                } catch {}
            })();
        }
        return socialSystem.handle(message, client);
    }

    // --- !RAT (Anonymous Tip) ---
    if (cmd === '!rat') {
        const target = message.mentions.users.first();
        if (!target) return message.reply('Usage: `!rat @target <message>` (¬_¬)');
        if (target.id === message.author.id) return message.reply("You can't rat on yourself, idiot! (¬_¬)");
        if (target.bot) return message.reply("You can't rat on a bot! (¬_¬)");

        const ratArgs = message.content.split(/\s+/).slice(2);
        const ratMsg = ratArgs.join(' ').trim();
        if (!ratMsg) return message.reply('You need to include a message! `!rat @target <message>` (¬_¬)');
        if (ratMsg.length > 200) return message.reply('Keep it under 200 characters, motor-mouth! (¬_¬)');

        const ratter = await User.findOne({ userId: message.author.id });
        if (!ratter || ratter.coins < 500) return message.reply("You need at least **500 coins** to rat! Go earn something first! (¬_¬)");

        // 6h cooldown per target
        const lastRat = (ratter.lastRatTargets || []).find(r => r.targetId === target.id);
        if (lastRat && (Date.now() - lastRat.timestamp) < 21600000) {
            const remaining = 21600000 - (Date.now() - lastRat.timestamp);
            const h = Math.floor(remaining / 3600000);
            const m = Math.floor((remaining % 3600000) / 60000);
            return message.reply(`You already ratted on them recently! Wait **${h}h ${m}m**. (¬_¬)`);
        }

        // Deduct 500 coins + update cooldown (atomic guard)
        const deductResult = await User.findOneAndUpdate(
            { userId: message.author.id, coins: { $gte: 500 } },
            {
                $inc: { coins: -500, systemSpent: 500 },
                $pull: { lastRatTargets: { targetId: target.id } }
            },
            { new: true }
        );
        if (!deductResult) return message.reply("You need at least **500 coins** to rat! (¬_¬)");
        await User.updateOne(
            { userId: message.author.id },
            {
                $push: { lastRatTargets: { $each: [{ targetId: target.id, timestamp: Date.now() }], $slice: -10 } }
            }
        );

        // Delete original message
        message.delete().catch(() => {});

        // Post anonymous tip in #general
        const generalChannel = message.guild.channels.cache.find(c => c.name === config.CHANNELS.GENERAL);
        if (generalChannel) {
            const targetMember = await message.guild.members.fetch(target.id).catch(() => null);
            const displayName = targetMember?.displayName || target.username;

            const embed = new EmbedBuilder()
                .setColor(0x8B0000)
                .setTitle('🚨 ANONYMOUS TIP RECEIVED 🚨')
                .setDescription(`**Target:** ${displayName}\n**Report:** "${ratMsg}"`)
                .setFooter({ text: '— Anonymous Source | I\'m not saying I believe this. I\'m also not saying I don\'t. (¬_¬)' });

            await generalChannel.send({ content: `<@${target.id}>`, embeds: [embed] });
        }
    }
});

// ==================== REACTION HANDLER ====================
client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;
    try {
        if (reaction.partial) await reaction.fetch();
        if (reaction.message.partial) await reaction.message.fetch();
        utilitySystem.trackReaction(user.id, reaction.message.author.id);
    } catch (err) {
        console.error('Reaction Error:', err);
    }
});

// ==================== INTERACTION HANDLER ====================
client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton() || interaction.isModalSubmit() || interaction.isStringSelectMenu()) {
        const handlers = [
            ['battle', battleSystem],
            ['economy', economySystem],
            ['election', electionSystem],
            ['utility', utilitySystem],
            ['trade', tradeSystem],
            ['market', marketSystem],
            ['forge', forgeSystem],
            ['social', socialSystem],
            ['higherLower', higherLowerSystem],
            ['fishing', fishingSystem],
            ['fishTrade', fishTradeSystem],
            ['stock', stockSystem],
        ];

        for (const [name, system] of handlers) {
            try {
                await system.handleInteraction(interaction, client);
            } catch (err) {
                console.error(`[${name}] Interaction handler error:`, err);
            }
        }
    }
});

// ==================== NICKNAME ENFORCER (FORCED RENAME + SLAVE LOCK) ====================
client.on('guildMemberUpdate', async (oldMember, newMember) => {
    // 1. Check if nickname actually changed
    if (oldMember.displayName === newMember.displayName) return;
    if (newMember.user.bot) return;

    // 2. Get user data
    const user = await User.findOne({ userId: newMember.id });
    if (!user) return;

    // 3. Permission Check (Can we manage them?)
    if (!newMember.manageable) return;

    // === PRIORITY 1: FORCED NICKNAME (from !rename) ===
    if (user.forcedNickname) {
        // Check if current name matches forced nickname
        if (newMember.displayName !== user.forcedNickname) {
            try {
                await newMember.setNickname(user.forcedNickname);
                console.log(`📛 Reverted forced nickname for ${newMember.user.tag}`);

                const channel = newMember.guild.channels.cache.find(c => ['tsun', 'tsun-alt'].includes(c.name));
                if (channel) {
                    const embed = new EmbedBuilder()
                        .setColor(0xFF0000)
                        .setTitle('⚠️ NICE TRY!')
                        .setDescription(`<@${newMember.id}> tried to change their name!\nYou can't escape your punishment! (¬_¬)`);
                    channel.send({ embeds: [embed] });
                }
            } catch (err) {
                console.error("Failed to enforce forced nickname:", err);
            }
        }
        return; // Forced nickname takes priority, don't check slave status
    }

    // === PRIORITY 2: SLAVE NICKNAME ===
    if (user.isSlave && user.slaveOwner) {
        // Determine the Enforced Name
        let lenderName = "Master";
        try {
            const ownerMember = await newMember.guild.members.fetch(user.slaveOwner).catch(() => null);
            if (ownerMember) lenderName = ownerMember.displayName;
            else {
                const ownerUser = await client.users.fetch(user.slaveOwner).catch(() => null);
                if (ownerUser) lenderName = ownerUser.username;
            }
        } catch (e) { }

        // Prevent overly long owner names from breaking the 32-char limit
        if (lenderName.length > 15) lenderName = lenderName.substring(0, 15) + '..';
        const requiredSuffix = ` (${lenderName}'s Slave)`;

        // Check if the NEW name complies
        if (!newMember.displayName.endsWith(requiredSuffix)) {
            // They tried to rebel!
            let targetName = oldMember.displayName;

            // If even the old name was wrong (e.g. manual mod change), force a fix
            if (!targetName.endsWith(requiredSuffix)) {
                const baseName = newMember.user.username;
                const maxLen = Math.max(1, 32 - requiredSuffix.length);
                targetName = baseName.substring(0, maxLen) + requiredSuffix;
            }

            // Apply Fix
            try {
                await newMember.setNickname(targetName);
                console.log(`🔒 Reverted slave nickname for ${newMember.user.tag}`);

                const channel = newMember.guild.channels.cache.find(c => ['tsun', 'tsun-alt'].includes(c.name));
                if (channel) {
                    channel.send(`⚠️ **REBELLION SUPPRESSED!**\n<@${newMember.id}> tried to change their name! Know your place, slave! (¬_¬)`);
                }
            } catch (err) {
                console.error("Failed to enforce slave nickname:", err);
            }
        }
        return; // Slave nickname takes priority
    }
});

// ==================== DEBUG & STARTUP ====================
console.log("🔍 Checking Environment Variables...");
if (!process.env.DISCORD_TOKEN) console.error("❌ CRITICAL: DISCORD_TOKEN is missing!");
else console.log("✅ DISCORD_TOKEN is present.");

if (!process.env.MONGO_URI) console.error("❌ CRITICAL: MONGO_URI is missing!");
else console.log("✅ MONGO_URI is present.");

process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled promise rejection:', error);
});


console.log("⚔️ Attempting to login to Discord...");


// Add detailed debug listeners
client.on('error', error => console.error("❌ CLIENT ERROR:", error));
client.on('warn', info => console.warn(`[WARN] ${info}`));

client.login(process.env.DISCORD_TOKEN)
    .then(() => console.log("✅ client.login() promise resolved."))
    .catch(err => {
        console.error("❌ FAILED to login to Discord:", err);
    });

