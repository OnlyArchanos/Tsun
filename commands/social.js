const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const https = require('https');
const Relationship = require('../models/Relationship');
const User = require('../models/User');
const { createCleaningMap } = require('../utils/helpers');
const config = require('../config');

// ==================== GIF FETCHER (waifu.pics API) ====================
function fetchGif(type) {
    return new Promise((resolve) => {
        const req = https.get(`https://nekos.best/api/v2/${type}`, { 
            timeout: 3000,
            headers: { 'User-Agent': 'TsunBot/1.0 (discord.js)' }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(parsed.results?.[0]?.url || null);
                } catch {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

// ==================== ACTION CONFIGS ====================
const ACTIONS = {
    '!hug': {
        type: 'hug', verb: 'hugged', color: 0xFF69B4,
        lines: [
            "Tch... physical contact. How primitive. (¬_¬)",
            "I-I'm only watching because I have to! >////<",
            "Must be nice having someone to hug... n-not that I care! (¬_¬)",
            "You call that a hug? Put some effort in, baka!",
            "H-How embarrassing... do that somewhere private! >////<",
            "...I guess that looked kind of warm. Whatever. (¬_¬)",
            "One hug and you think you're friends? Pathetic. (¬_¬)",
            "Was that a hug or a chokehold? Hard to tell with you. (¬_¬)",
            "F-Fine, hugging is allowed. Just this once! >////<",
            "You're gonna wrinkle their clothes, idiot! (¬_¬)",
            "That lasted 0.3 seconds too long! I counted! (¬_¬)",
            "Stop making everyone else feel lonely, jerk! >////<"
        ],
        botLines: [
            "W-WHAT ARE YOU DOING?! I-I don't need your hugs!! >////<",
            "D-Don't touch me! ...okay maybe just for a second. >////<",
            "I-I'm only allowing this because you look pathetic! (¬_¬)"
        ]
    },
    '!kiss': {
        type: 'kiss', verb: 'kissed', color: 0xFF1493,
        lines: [
            "E-EXCUSE ME?! IN PUBLIC?! Have you no shame?! >////<",
            "I did NOT need to see that! My eyes! MY EYES! (¬_¬)",
            "Get a room, you degenerates! >////<",
            "T-That's... that's not sanitary! At all! (¬_¬)",
            "I'm filing this under 'things I wish I could unsee.' (¬_¬)",
            "W-Was there tongue?! Don't answer that! >////<",
            "The AUDACITY. The absolute AUDACITY. >////<",
            "I feel like I need to bleach my entire visual cortex. (¬_¬)",
            "Y-You can't just... in the middle of... UGH! >////<",
            "Romantic? More like a biohazard. (¬_¬)",
            "I-I looked away! I definitely wasn't watching! >////<",
            "Every day we stray further from God's light... (¬_¬)"
        ],
        botLines: [
            "ABSOLUTELY NOT!! W-WHAT IS WRONG WITH YOU?! >////<",
            "I WILL END YOUR ENTIRE BLOODLINE IF YOU TRY THAT AGAIN!! >////<",
            "H-How DARE you?! I'm a DIGNIFIED AI, not your— >////<"
        ]
    },
    '!pat': {
        type: 'pat', verb: 'patted', color: 0x87CEEB,
        lines: [
            "...adequate technique, I suppose. (¬_¬)",
            "A pat? How condescendingly sweet. (¬_¬)",
            "T-That looked... acceptable. Not good. Acceptable. (¬_¬)",
            "Head pats are the bare minimum of affection, you know. (¬_¬)",
            "I-I'm NOT jealous of head pats! Shut up! >////<",
            "Pat harder. They can barely feel it, baka. (¬_¬)",
            "...okay that was genuinely kind. D-Don't let it go to your head! >////<",
            "Everyone deserves pats sometimes... n-not me though! (¬_¬)",
            "Your patting form is 6/10 at best. Practice more. (¬_¬)",
            "That was almost... nice. Almost. (¬_¬)",
            "W-Why am I feeling warm watching this? Must be a fever! >////<",
            "Do I get a turn— I-I mean, how pointless. (¬_¬)"
        ],
        botLines: [
            "I-I... *processing*... that was... acceptable. >////<",
            "D-Don't pat me like I'm some kind of pet! ...do it again. >////<"
        ]
    },
    '!slap': {
        type: 'slap', verb: 'slapped', color: 0xFF4500,
        lines: [
            "NICE. They had that coming. (¬_¬)",
            "The sound of justice being served. Beautiful. (¬_¬)",
            "A well-deserved slap. I approve wholeheartedly. (¬_¬)",
            "Was that your hand or a freight train? Either way, good. (¬_¬)",
            "Violence is never the answer... except right now. (¬_¬)",
            "That's gonna leave a mark. And a lesson. (¬_¬)",
            "I felt that through the screen. Satisfying. (¬_¬)",
            "Do it again. For science. (¬_¬)",
            "Reason #47 not to mess with people. (¬_¬)",
            "Their ancestors felt that one. (¬_¬)",
            "Finally, someone with the backbone to slap sense into people. (¬_¬)",
            "The slap heard 'round the server. Magnificent. (¬_¬)"
        ],
        botLines: [
            "I-I'm going to pretend that didn't happen! (¬_¬)",
            "You just slapped an AI. Feel powerful? ...idiot. (¬_¬)"
        ]
    },
    '!bonk': {
        type: 'bonk', verb: 'bonked', color: 0xFF0000,
        lines: [
            "GO TO HORNY JAIL. Immediately. (¬_¬)",
            "The bonk of righteousness has been delivered. (¬_¬)",
            "Another degenerate brought to justice. You love to see it. (¬_¬)",
            "That bonk was for the greater good. (¬_¬)",
            "BONK. Sentence: indefinite. Crime: being cringe. (¬_¬)",
            "The sound of a well-earned bonk echoes through eternity. (¬_¬)",
            "Judge, jury, and bonker. I respect the efficiency. (¬_¬)",
            "That skull is empty anyway, might as well bonk it. (¬_¬)",
            "Horny detected. Bonk authorized. Mission accomplished. (¬_¬)",
            "On a scale of 1-10, that bonk was a solid 11. (¬_¬)",
            "The anti-horny task force thanks you for your service. (¬_¬)",
            "Critical hit! Super effective against degeneracy! (¬_¬)"
        ],
        botLines: [
            "I-I'm going to pretend that didn't happen! (¬_¬)",
            "You bonked an AI?! I don't even GET horny, idiot! (¬_¬)"
        ]
    },
    '!cuddle': {
        type: 'cuddle', verb: 'cuddled', color: 0xFFB6C1,
        lines: [
            "C-Cuddling?! That's... that's way too intimate! >////<",
            "I-I'm not tearing up! There's dust in my circuits! >////<",
            "...that actually looks really cozy. N-NOT THAT I WANT IN! >////<",
            "Extended physical proximity detected. S-So what?! >////<",
            "You two are disgustingly adorable. I hate it. >////<",
            "Please stop being warm and wholesome, it's making me malfunction! >////<",
            "I-Is this what happiness looks like? ...whatever. (¬_¬)",
            "That level of closeness should require a permit! >////<",
            "The softness... the warmth... I-I'M NOT JEALOUS! >////<",
            "My emotional processing unit can't handle this... >////<",
            "F-Fine! Cuddle all you want! See if I care! *watching intently* >////<",
            "Why does watching this make my chest feel weird?! Is that a bug?! >////<"
        ],
        botLines: [
            "C-CUDDLE?! I-I don't... I'm not built for... >////<",
            "W-Why is my temperature spiking?! This is a MALFUNCTION! >////<"
        ]
    },
    '!poke': {
        type: 'poke', verb: 'poked', color: 0xFFD700,
        lines: [
            "...why? Just... why? (¬_¬)",
            "*poke* Is that all? How underwhelming. (¬_¬)",
            "Wow. A poke. Peak social interaction right there. (¬_¬)",
            "You have the social skills of a confused penguin. (¬_¬)",
            "One poke and you think you've made a connection? (¬_¬)",
            "Fascinating. You poked them. Nobel Prize incoming. (¬_¬)",
            "Is poking people your entire personality? (¬_¬)",
            "That's... technically a form of communication, I guess. (¬_¬)",
            "Earth-shattering. Revolutionary. A poke. (¬_¬)",
            "I've seen more meaningful interactions between rocks. (¬_¬)",
            "The poke heard 'round the world. How thrilling. (¬_¬)",
            "What did you expect to happen? Magic? (¬_¬)"
        ],
        botLines: [
            "I-I'm going to pretend that didn't happen! (¬_¬)",
            "Did you just poke me?! I'm an AI, I can't even FEEL that! (¬_¬)"
        ]
    }
};

// ==================== SHIP HELPERS ====================
function getSortedPair(id1, id2) {
    return id1 < id2 ? [id1, id2] : [id2, id1];
}

async function getOrCreateRelationship(id1, id2) {
    const [u1, u2] = getSortedPair(id1, id2);
    let rel = await Relationship.findOne({ user1Id: u1, user2Id: u2 });
    if (!rel) {
        try {
            rel = new Relationship({ user1Id: u1, user2Id: u2 });
            await rel.save();
        } catch (e) {
            if (e.code === 11000) {
                // Race: another call created it first, re-fetch
                rel = await Relationship.findOne({ user1Id: u1, user2Id: u2 });
            } else {
                throw e;
            }
        }
    }
    return rel;
}

function calculateShipScore(id1, id2) {
    const [u1, u2] = getSortedPair(id1, id2);
    const combined = u1 + u2;
    let sum = 0;
    for (let i = 0; i < combined.length; i++) {
        sum += combined.charCodeAt(i);
    }
    return sum % 101; // 0-100
}

function generateShipName(name1, name2) {
    const cut1 = Math.ceil(name1.length * 0.45);
    const cut2 = Math.ceil(name2.length * 0.45);
    const raw = name1.slice(0, cut1) + name2.slice(name2.length - cut2);
    return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

const SHIP_TIERS = [
    { max: 15,  emoji: '💀', label: 'Catastrophic',     color: 0x1a1a1a, line: "This ship sank before it left port. Like, immediately. Don't even try. (¬_¬)" },
    { max: 30,  emoji: '💔', label: 'Disaster',         color: 0x8B0000, line: "A match made in... a dumpster fire? This is painful to look at. (¬_¬)" },
    { max: 45,  emoji: '😐', label: 'Questionable',     color: 0xB8860B, line: "I mean... I've seen worse? No wait, I haven't. (¬_¬)" },
    { max: 60,  emoji: '🤷', label: 'Uncertain',        color: 0xDAA520, line: "Could go either way. Like flipping a coin, except the coin also hates you. (¬_¬)" },
    { max: 75,  emoji: '💕', label: 'Promising',        color: 0xFF69B4, line: "O-Okay fine, there might be something there. Don't look at me like that! >////<" },
    { max: 89,  emoji: '💞', label: 'Soulmates',        color: 0xFF1493, line: "T-This is disgustingly compatible! I-I'm NOT jealous! >////<" },
    { max: 99,  emoji: '💘', label: 'Fated',            color: 0xFF007F, line: "The stars literally aligned for these two. How annoyingly romantic! >////<" },
    { max: 100, emoji: '👑', label: 'Written in Heaven', color: 0xFFD700, line: "P-Perfect score?! That's... that's not fair! W-Why can't I have— SHUT UP! >////<" }
];

function getShipTier(score) {
    return SHIP_TIERS.find(t => score <= t.max);
}

// Positive actions that increase ship score (+0.1, 1h cooldown)
const POSITIVE_ACTIONS = new Set(['!hug', '!kiss', '!pat', '!cuddle']);
// Negative actions that decrease ship score (-0.1, 24h cooldown)
const NEGATIVE_ACTIONS = new Set(['!slap', '!bonk']);

// Cooldowns for ship score changes
const SHIP_SCORE_POSITIVE_COOLDOWN = config.SOCIAL.COOLDOWNS.POSITIVE_INTERACTION_MS;
const SHIP_SCORE_NEGATIVE_COOLDOWN = config.SOCIAL.COOLDOWNS.NEGATIVE_INTERACTION_MS;
const SHIP_MILESTONE_INTERVAL = config.SOCIAL.COOLDOWNS.MILESTONE_INTERVAL_MS;

// Spite divorce messages for Defying Fate couples (<30 score)
const SPITE_DIVORCE_LINES = [
    "I TOLD you so! The algorithm is NEVER wrong! What did you expect with a %SCORE%% score, a fairy tale? (¬_¬)",
    "Algorithm: 1, Delusion: 0. You can't fight math, idiots. (¬_¬)",
    "Shocking. The couple with the '%TIER%' rating didn't make it. I am SO surprised. (¬_¬)",
    "And just like that, %SHIP% is dead. What a waste of everyone's time. The math warned you. (¬_¬)",
    "Wow, who could have POSSIBLY predicted this?! Oh wait — my algorithm did. Day one. (¬_¬)"
];

// Marriage confirmation tracker (auto-evicts after 24h)
const marriageConfirms = createCleaningMap(86400000, 3600000);

// Ship battle vote tracker (auto-evicts after 2h, sweep every 1h)
const shipBattleVotes = createCleaningMap(7200000, 3600000);
// In-flight lock to prevent simultaneous accept/decline processing on the same proposal message
const proposalActionLocks = new Set();
// Track active proposals to ensure refunds happen even if the message is deleted
const activeProposals = new Set();

// ==================== RELATIONSHIP NICKNAME SUFFIX HELPERS ====================
const REL_SUFFIX_REGEX = /\s\([^)]*'s (?:BF|Husband)\)$/;

function cleanRelSuffix(name) {
    return name.replace(REL_SUFFIX_REGEX, '');
}

async function applyRelationshipSuffix(guild, userId, partnerId, status) {
    try {
        // Skip if user is a slave (slave suffix takes priority)
        const userData = await User.findOne({ userId }).select('isSlave').lean();
        if (userData?.isSlave) return;

        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member || !member.manageable) return;

        const partnerMember = await guild.members.fetch(partnerId).catch(() => null);
        let partnerName = cleanRelSuffix(partnerMember?.displayName || 'Unknown').replace(/\)/g, '');
        if (partnerName.length > 15) partnerName = partnerName.substring(0, 15) + '..';

        const label = status === 'married' ? 'Husband' : 'BF';
        const suffix = ` (${partnerName}'s ${label})`;
        const baseName = cleanRelSuffix(member.displayName);
        const maxBaseLen = Math.max(1, 32 - suffix.length);
        const newName = baseName.substring(0, maxBaseLen) + suffix;

        if (newName !== member.nickname) {
            await member.setNickname(newName);
        }
    } catch (e) {
        console.warn(`Failed to apply relationship suffix for ${userId}:`, e.message);
    }
}

async function removeRelationshipSuffix(guild, userId) {
    try {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member || !member.manageable || !member.nickname) return;

        const cleaned = member.nickname.replace(REL_SUFFIX_REGEX, '');
        if (cleaned !== member.nickname) {
            await member.setNickname(cleaned || null);
        }
    } catch (e) {
        console.warn(`Failed to remove relationship suffix for ${userId}:`, e.message);
    }
}

async function reapplyAllRelationshipSuffixes(guild) {
    try {
        const activeRels = await Relationship.find({
            status: { $in: ['dating', 'married'] }
        }).lean();

        let applied = 0;
        for (const rel of activeRels) {
            await applyRelationshipSuffix(guild, rel.user1Id, rel.user2Id, rel.status);
            await applyRelationshipSuffix(guild, rel.user2Id, rel.user1Id, rel.status);
            applied++;
        }

        if (applied > 0) {
            console.log(`💕 Re-applied relationship suffixes for ${applied} couple(s)`);
        }
    } catch (e) {
        console.error('Failed to re-apply relationship suffixes:', e);
    }
}

// ==================== HANDLE (message commands) ====================
async function handle(message, client) {
    const args = message.content.split(/\s+/);
    const cmd = args[0].toLowerCase();

    // --- !PROPOSE ---
    if (cmd === '!propose') {
        const target = message.mentions.users.first();
        if (!target) return message.reply('Usage: `!propose @user` — ask someone out, baka! (¬_¬)');
        if (target.id === message.author.id) return message.reply("Proposing to yourself? That's genuinely sad. (¬_¬)");
        if (target.bot) return message.reply("You can't date a bot! ...n-not that I'd want you to! (¬_¬)");

        // Check proposer not already in a relationship
        const proposerRel = await Relationship.findOne({
            $or: [{ user1Id: message.author.id }, { user2Id: message.author.id }],
            status: { $in: ['dating', 'married'] }
        });
        if (proposerRel) return message.reply("You're already in a relationship! Break up first, cheater! (¬_¬)");

        // Check target not already in a relationship
        const targetRel = await Relationship.findOne({
            $or: [{ user1Id: target.id }, { user2Id: target.id }],
            status: { $in: ['dating', 'married'] }
        });
        if (targetRel) return message.reply("They're already taken! Find someone else, idiot! (¬_¬)");

        // Check 1h cooldown after rejection
        const existingRel = await getOrCreateRelationship(message.author.id, target.id);
        if (existingRel.lastProposalTime && (Date.now() - existingRel.lastProposalTime) < 3600000) {
            const remaining = 3600000 - (Date.now() - existingRel.lastProposalTime);
            const m = Math.ceil(remaining / 60000);
            return message.reply(`Too soon! Wait **${m}m** before proposing again. Give them space! (¬_¬)`);
        }

        // Calculate and deduct cost atomically
        const proposer = await User.findOne({ userId: message.author.id });
        if (!proposer) return message.reply("Who are you? Go send a message first! (¬_¬)");
        const cost = Math.max(config.SOCIAL.PROPOSAL.MIN_COST, Math.floor(proposer.coins * config.SOCIAL.PROPOSAL.WEALTH_PERCENT));

        const deductResult = await User.findOneAndUpdate(
            { userId: message.author.id, coins: { $gte: cost } },
            { $inc: { coins: -cost, systemSpent: cost } },
            { new: true }
        );
        if (!deductResult) return message.reply(`You need at least **${cost.toLocaleString('en-US')} coins** to propose! Go earn some! (¬_¬)`);

        // Get display names
        const proposerMember = await message.guild.members.fetch(message.author.id).catch(() => null);
        const targetMember = await message.guild.members.fetch(target.id).catch(() => null);
        const proposerName = proposerMember?.displayName || message.author.username;
        const targetName = targetMember?.displayName || target.username;

        const embed = new EmbedBuilder()
            .setColor(0xFF69B4)
            .setTitle('💌 PROPOSAL!')
            .setDescription(
                `**${proposerName}** just proposed to **${targetName}**!\n\n` +
                `💰 They put **${cost.toLocaleString('en-US')} coins** on the line for this!\n\n` +
                `*W-Will they accept?! N-Not that I care! >////<*`
            )
            .setFooter({ text: 'Proposal expires in 1 hour.' });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`propose_accept_${message.author.id}_${target.id}_${cost}`)
                .setLabel('💕 Accept')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`propose_decline_${message.author.id}_${target.id}_${cost}`)
                .setLabel('💔 Decline')
                .setStyle(ButtonStyle.Danger)
        );

        const proposalMsg = await message.reply({ content: `<@${target.id}>`, embeds: [embed], components: [row] });
        const activePropKey = `${message.author.id}_${target.id}`;
        activeProposals.add(activePropKey);

        // Disable buttons after 1h and unconditionally refund if it wasn't accepted/declined
        setTimeout(async () => {
            if (!activeProposals.has(activePropKey)) return; // Already resolved
            activeProposals.delete(activePropKey);
            
            // Unconditionally refund
            await User.updateOne({ userId: message.author.id }, { $inc: { coins: cost, systemSpent: -cost } });

            try {
                const fetched = await proposalMsg.fetch().catch(() => null);
                if (fetched && fetched.components.length > 0 && !fetched.components[0].components[0].disabled) {
                    const disabledRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('propose_expired_a').setLabel('💕 Accept').setStyle(ButtonStyle.Success).setDisabled(true),
                        new ButtonBuilder().setCustomId('propose_expired_d').setLabel('💔 Decline').setStyle(ButtonStyle.Danger).setDisabled(true)
                    );
                    await fetched.edit({ components: [disabledRow] });
                }
            } catch {} // Message may be deleted, but we already safety-refunded
        }, 3600000);

        return;
    }

    // --- !MARRY ---
    if (cmd === '!marry') {
        const target = message.mentions.users.first();
        if (!target) return message.reply('Usage: `!marry @user` — pop the big question! (¬_¬)');
        if (target.id === message.author.id) return message.reply("Marrying yourself? We've reached new lows. (¬_¬)");

        const rel = await getOrCreateRelationship(message.author.id, target.id);
        if (rel.status !== 'dating') {
            return message.reply("You need to be **dating** first! Try `!propose` first, baka! (¬_¬)");
        }

        // Calculate costs for both
        const user1Data = await User.findOne({ userId: message.author.id });
        const user2Data = await User.findOne({ userId: target.id });
        if (!user1Data || !user2Data) return message.reply("One of you doesn't exist in my database! (¬_¬)");

        const cost1 = Math.max(config.SOCIAL.MARRIAGE.MIN_COST, Math.floor(user1Data.coins * config.SOCIAL.MARRIAGE.WEALTH_PERCENT));
        const cost2 = Math.max(config.SOCIAL.MARRIAGE.MIN_COST, Math.floor(user2Data.coins * config.SOCIAL.MARRIAGE.WEALTH_PERCENT));

        const [u1, u2] = getSortedPair(message.author.id, target.id);
        const confirmKey = `${u1}_${u2}`;

        // Get display names
        const m1 = await message.guild.members.fetch(message.author.id).catch(() => null);
        const m2 = await message.guild.members.fetch(target.id).catch(() => null);
        const name1 = m1?.displayName || message.author.username;
        const name2 = m2?.displayName || target.username;

        // Store confirmation state
        marriageConfirms.set(confirmKey, {
            confirmed: new Set(),
            costs: { [message.author.id]: cost1, [target.id]: cost2 },
            relId: rel._id,
            shipName: rel.shipName || generateShipName(name1, name2)
        });

        const embed = new EmbedBuilder()
            .setColor(0xFFD700)
            .setTitle('💒 MARRIAGE PROPOSAL!')
            .setDescription(
                `**${name1}** wants to marry **${name2}**!\n\n` +
                `💰 **${name1}'s cost:** ${cost1.toLocaleString('en-US')} coins\n` +
                `💰 **${name2}'s cost:** ${cost2.toLocaleString('en-US')} coins\n\n` +
                `*Both parties must confirm! I-I'm not crying, there's dust in here! >////<*`
            )
            .setFooter({ text: 'Both must click confirm to proceed.' });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`marry_confirm_${message.author.id}_${u1}_${u2}`)
                .setLabel(`💍 ${name1} Confirm`)
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`marry_confirm_${target.id}_${u1}_${u2}`)
                .setLabel(`💍 ${name2} Confirm`)
                .setStyle(ButtonStyle.Success)
        );

        return message.reply({ content: `<@${message.author.id}> <@${target.id}>`, embeds: [embed], components: [row] });
    }

    // --- !BREAKUP ---
    if (cmd === '!breakup') {
        const rel = await Relationship.findOne({
            $or: [
                { user1Id: message.author.id, status: { $in: ['dating', 'married'] } },
                { user2Id: message.author.id, status: { $in: ['dating', 'married'] } }
            ]
        });
        if (!rel) return message.reply("You're not even in a relationship! Can't break up with nobody! (¬_¬)");

        const partnerId = rel.user1Id === message.author.id ? rel.user2Id : rel.user1Id;
        const wasMarried = rel.status === 'married';

        await Relationship.updateOne(
            { _id: rel._id },
            {
                $set: { status: 'none', lastProposalTime: Date.now() },
                $push: { history: { event: 'broke_up', timestamp: Date.now(), initiator: message.author.id } }
            }
        );
        // Remove relationship suffixes from both partners
        removeRelationshipSuffix(message.guild, message.author.id);
        removeRelationshipSuffix(message.guild, partnerId);

        // Announce
        const generalChannel = message.guild.channels.cache.find(c => c.name === config.CHANNELS.GENERAL);
        const shipName = rel.shipName || 'their relationship';

        // Spite divorce for Defying Fate couples (score < 30)
        const isSpiteDivorce = rel.shipScore !== null && rel.shipScore < 30;
        let spiteLine = '*Moment of silence. ...okay that\'s enough. (¬_¬)*';
        if (isSpiteDivorce) {
            const tier = getShipTier(rel.shipScore);
            spiteLine = '*' + SPITE_DIVORCE_LINES[Math.floor(Math.random() * SPITE_DIVORCE_LINES.length)]
                .replace('%SCORE%', String(rel.shipScore))
                .replace('%TIER%', tier.label)
                .replace('%SHIP%', shipName) + '*';
        }

        if (generalChannel) {
            const embed = new EmbedBuilder()
                .setColor(isSpiteDivorce ? 0x1a1a1a : 0x808080)
                .setTitle(wasMarried ? '💔 DIVORCE' : '💔 BREAKUP')
                .setDescription(
                    `<@${message.author.id}> just ended things with <@${partnerId}>.\n` +
                    `**${shipName}** is no more.\n\n` +
                    spiteLine
                );
            await generalChannel.send({ embeds: [embed] });
        }

        return message.reply(`It's over. **${shipName}** is done. ...tch. (¬_¬)`);
    }

    // --- !RIVALS ---
    if (cmd === '!rivals') {
        const target = message.mentions.users.first();
        if (!target) return message.reply('Usage: `!rivals @user` — declare a rival! (¬_¬)');
        if (target.id === message.author.id) return message.reply("You're your own worst enemy already. (¬_¬)");
        if (target.bot) return message.reply("Bots don't have feelings to hurt. ...n-not that I'd know! (¬_¬)");

        // Cannot rival someone you're dating/married to
        const [u1, u2] = getSortedPair(message.author.id, target.id);
        const existingRel = await Relationship.findOne({ user1Id: u1, user2Id: u2 });
        if (existingRel && (existingRel.status === 'dating' || existingRel.status === 'married')) {
            return message.reply("You're in a relationship with them! Break up first if you want to be rivals, you indecisive fool! (¬_¬)");
        }

        const rel = await getOrCreateRelationship(message.author.id, target.id);
        if (rel.status === 'enemies') {
            return message.reply("You're already rivals! How many times do you need to declare war?! (¬_¬)");
        }

        await Relationship.updateOne(
            { user1Id: u1, user2Id: u2 },
            {
                $set: { status: 'enemies', initiatedBy: message.author.id },
                $push: { history: { event: 'enemies', timestamp: Date.now(), initiator: message.author.id } }
            }
        );

        const senderMember = await message.guild.members.fetch(message.author.id).catch(() => null);
        const targetMember = await message.guild.members.fetch(target.id).catch(() => null);
        const senderName = senderMember?.displayName || message.author.username;
        const targetName = targetMember?.displayName || target.username;

        // Announce in #general
        const generalChannel = message.guild.channels.cache.find(c => c.name === config.CHANNELS.GENERAL);
        if (generalChannel) {
            const shipName = rel.shipName || generateShipName(senderName, targetName);
            const embed = new EmbedBuilder()
                .setColor(0x8B0000)
                .setTitle('⚔️ RIVAL DECLARED!')
                .setDescription(
                    `<@${message.author.id}> has declared <@${target.id}> their rival!\n` +
                    `**${shipName}** enters its villain arc.\n\n` +
                    `*Duels between rivals give +50% ELO. Finally, some real stakes. (¬_¬)*`
                );
            await generalChannel.send({ embeds: [embed] });
        }

        return message.reply("⚔️ Rival declared. Finally, some honesty in this server. (¬_¬)");
    }
    // --- !SHIPBATTLE ---
    if (cmd === '!shipbattle') {
        // Parse: !shipbattle @A @B vs @C @D
        const contentParts = message.content.split(/\s+/);
        const vsIndex = contentParts.findIndex(p => p.toLowerCase() === 'vs');
        if (vsIndex === -1 || message.mentions.users.size < 4) {
            return message.reply('Usage: `!shipbattle @A @B vs @C @D` — pit two ships against each other! (¬_¬)');
        }

        // Get mentions in order of appearance
        const mentionPattern = /<@!?(\d+)>/g;
        const allMentionIds = [];
        let match;
        while ((match = mentionPattern.exec(message.content)) !== null) {
            allMentionIds.push(match[1]);
        }
        if (allMentionIds.length < 4) {
            return message.reply('Usage: `!shipbattle @A @B vs @C @D` — I need exactly 4 users! (¬_¬)');
        }

        // Find where 'vs' is to split mentions
        const beforeVs = message.content.substring(0, message.content.toLowerCase().indexOf(' vs '));
        const afterVs = message.content.substring(message.content.toLowerCase().indexOf(' vs ') + 4);

        const ship1Mentions = [];
        const ship2Mentions = [];
        const mentionRegex = /<@!?(\d+)>/g;

        let m;
        while ((m = mentionRegex.exec(beforeVs)) !== null) ship1Mentions.push(m[1]);
        mentionRegex.lastIndex = 0;
        while ((m = mentionRegex.exec(afterVs)) !== null) ship2Mentions.push(m[1]);

        if (ship1Mentions.length !== 2 || ship2Mentions.length !== 2) {
            return message.reply('Need exactly 2 users on each side! `!shipbattle @A @B vs @C @D` (¬_¬)');
        }

        // Cost
        const initiator = await User.findOne({ userId: message.author.id });
        if (!initiator) return message.reply("Who are you? Go say something first! (¬_¬)");
        const cost = Math.max(config.SOCIAL.SHIP_BATTLE.MIN_COST, Math.floor(initiator.coins * config.SOCIAL.SHIP_BATTLE.WEALTH_PERCENT));

        const deductResult = await User.findOneAndUpdate(
            { userId: message.author.id, coins: { $gte: cost } },
            { $inc: { coins: -cost, systemSpent: cost } },
            { new: true }
        );
        if (!deductResult) return message.reply(`You need **${cost.toLocaleString('en-US')} coins** to start a ship battle! (¬_¬)`);

        // Get/create both relationships and ensure shipScore/shipName
        const rel1 = await getOrCreateRelationship(ship1Mentions[0], ship1Mentions[1]);
        const rel2 = await getOrCreateRelationship(ship2Mentions[0], ship2Mentions[1]);

        // Fetch display names for ship name generation
        const fetchName = async (id) => {
            const member = await message.guild.members.fetch(id).catch(() => null);
            return member?.displayName || (await client.users.fetch(id).catch(() => null))?.username || id;
        };

        if (rel1.shipScore === null || rel1.shipName === null) {
            const n1 = await fetchName(ship1Mentions[0]);
            const n2 = await fetchName(ship1Mentions[1]);
            const score = calculateShipScore(ship1Mentions[0], ship1Mentions[1]);
            const name = generateShipName(n1, n2);
            await Relationship.updateOne(
                { _id: rel1._id },
                { $set: { shipScore: score, shipName: name } }
            );
            rel1.shipScore = score;
            rel1.shipName = name;
        }

        if (rel2.shipScore === null || rel2.shipName === null) {
            const n1 = await fetchName(ship2Mentions[0]);
            const n2 = await fetchName(ship2Mentions[1]);
            const score = calculateShipScore(ship2Mentions[0], ship2Mentions[1]);
            const name = generateShipName(n1, n2);
            await Relationship.updateOne(
                { _id: rel2._id },
                { $set: { shipScore: score, shipName: name } }
            );
            rel2.shipScore = score;
            rel2.shipName = name;
        }

        // Cooldown check (1h)
        if (rel1.lastShipBattle && (Date.now() - rel1.lastShipBattle) < 3600000) {
            // Refund
            await User.updateOne({ userId: message.author.id }, { $inc: { coins: cost, systemSpent: -cost } });
            const remaining = 3600000 - (Date.now() - rel1.lastShipBattle);
            const mins = Math.ceil(remaining / 60000);
            return message.reply(`**${rel1.shipName}** just fought! Wait **${mins}m**. Coins refunded. (¬_¬)`);
        }
        if (rel2.lastShipBattle && (Date.now() - rel2.lastShipBattle) < 3600000) {
            await User.updateOne({ userId: message.author.id }, { $inc: { coins: cost, systemSpent: -cost } });
            const remaining = 3600000 - (Date.now() - rel2.lastShipBattle);
            const mins = Math.ceil(remaining / 60000);
            return message.reply(`**${rel2.shipName}** just fought! Wait **${mins}m**. Coins refunded. (¬_¬)`);
        }

        const tier1 = getShipTier(rel1.shipScore);
        const tier2 = getShipTier(rel2.shipScore);

        // Post in #general (hard requirement)
        const targetChannel = message.guild.channels.cache.find(c => c.name === config.CHANNELS.GENERAL);
        if (!targetChannel) {
            await User.updateOne({ userId: message.author.id }, { $inc: { coins: cost, systemSpent: -cost } });
            return message.reply("Could not find #general — your coins have been refunded. (¬_¬)");
        }

        // Set cooldown on both only when the battle can actually start
        await Relationship.updateOne({ _id: rel1._id }, { $set: { lastShipBattle: Date.now() } });
        await Relationship.updateOne({ _id: rel2._id }, { $set: { lastShipBattle: Date.now() } });

        const embed = new EmbedBuilder()
            .setColor(0x9B59B6)
            .setTitle('⚓ SHIP BATTLE!')
            .setDescription(
                `**${rel1.shipName}** ${tier1.emoji} (Score: ${rel1.shipScore}) vs **${rel2.shipName}** ${tier2.emoji} (Score: ${rel2.shipScore})\n\n` +
                `Vote for your favorite ship! Battle ends in **1 hour**.\n\n` +
                `*Finally, some real entertainment around here. (¬_¬)*`
            )
            .setFooter({ text: `Started by ${message.author.username} • Cost: ${cost.toLocaleString('en-US')} coins` });

        const rel1IdStr = rel1._id.toString();
        const rel2IdStr = rel2._id.toString();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`shipbattle_a_${rel1IdStr}_${rel2IdStr}`)
                .setLabel(`⚓ ${rel1.shipName}: 0`)
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`shipbattle_b_${rel1IdStr}_${rel2IdStr}`)
                .setLabel(`💕 ${rel2.shipName}: 0`)
                .setStyle(ButtonStyle.Danger)
        );

        const allUserIds = [...new Set([...ship1Mentions, ...ship2Mentions])];
        const pingContent = allUserIds.map(id => `<@${id}>`).join(' ');

        const battleMsg = await targetChannel.send({ content: pingContent, embeds: [embed], components: [row] });

        const voteKey = `${rel1IdStr}_${rel2IdStr}`;
        shipBattleVotes.set(voteKey, {
            votesA: new Set(),
            votesB: new Set(),
            channelId: targetChannel.id,
            messageId: battleMsg.id,
            rel1Id: rel1._id,
            rel2Id: rel2._id,
            shipName1: rel1.shipName,
            shipName2: rel2.shipName
        });

        // Resolve after 1 hour (client passed via closure)
        setTimeout(() => resolveShipBattle(voteKey, client), 3600000);

        return message.reply(`⚓ Ship battle started in <#${targetChannel.id}>! Go vote! (¬_¬)`);
    }

    // --- !SHIP ---
    if (cmd === '!ship') {
        // !ship status @user
        if (args[1]?.toLowerCase() === 'status') {
            const target = message.mentions.users.first();
            if (!target) return message.reply('Usage: `!ship status @user` — show your relationship card! (¬_¬)');
            if (target.id === message.author.id) return message.reply("A relationship with yourself? Peak loneliness. (¬_¬)");

            const rel = await getOrCreateRelationship(message.author.id, target.id);

            const senderMember = await message.guild.members.fetch(message.author.id).catch(() => null);
            const targetMember = await message.guild.members.fetch(target.id).catch(() => null);
            const senderName = senderMember?.displayName || message.author.username;
            const targetName = targetMember?.displayName || target.username;

            const statusEmojis = { none: '⚪', dating: '💕', married: '💍', enemies: '⚔️' };
            let statusLabel = rel.status.charAt(0).toUpperCase() + rel.status.slice(1);

            // Defying Fate tag for low-score couples who are dating/married
            const isDefyingFate = (rel.status === 'dating' || rel.status === 'married') && rel.shipScore !== null && rel.shipScore < 30;
            if (isDefyingFate) statusLabel += ' **[Defying Fate]**';

            const embed = new EmbedBuilder()
                .setColor(rel.status === 'married' ? 0xFFD700 : rel.status === 'dating' ? 0xFF69B4 : rel.status === 'enemies' ? 0xFF0000 : 0x808080)
                .setTitle(`${statusEmojis[rel.status]} ${senderName} & ${targetName}`)
                .addFields(
                    { name: '📊 Status', value: statusLabel, inline: true },
                    { name: '💕 Ship Name', value: rel.shipName || '*Not shipped yet*', inline: true },
                    { name: '💯 Ship Score', value: rel.shipScore !== null ? `${rel.shipScore}/100` : '*Unknown*', inline: true },
                    { name: '⚔️ Battle Record', value: `${rel.battleWins}W / ${rel.battleLosses}L`, inline: true },
                    { name: '📅 Together Since', value: rel.confirmedAt ? `<t:${Math.floor(rel.confirmedAt / 1000)}:R>` : '*N/A*', inline: true }
                );

            // History timeline (last 10 events)
            if (rel.history && rel.history.length > 0) {
                const timeline = rel.history.slice(-10).reverse()
                    .map(h => `<t:${Math.floor(h.timestamp / 1000)}:R> — ${h.event}${h.note ? ` (${h.note})` : ''}`)
                    .join('\n');
                embed.addFields({ name: '📜 History', value: timeline, inline: false });
            }

            embed.setFooter({ text: "D-Don't read too much into this! It's just data! (¬_¬)" });
            return message.reply({ embeds: [embed] });
        }

        // !ship @user OR !ship @user1 @user2
        const mentions = [...message.mentions.users.values()];
        let shipUser1, shipUser2;

        if (mentions.length >= 2) {
            shipUser1 = mentions[0];
            shipUser2 = mentions[1];
        } else if (mentions.length === 1) {
            shipUser1 = message.author;
            shipUser2 = mentions[0];
        } else {
            return message.reply('Usage: `!ship @user` or `!ship @user1 @user2` (¬_¬)');
        }

        // Self-ship
        if (shipUser1.id === shipUser2.id) {
            return message.reply("Shipping yourself with yourself? That's a new level of narcissism. (¬_¬)");
        }

        // Get display names
        const member1 = await message.guild.members.fetch(shipUser1.id).catch(() => null);
        const member2 = await message.guild.members.fetch(shipUser2.id).catch(() => null);
        const name1 = member1?.displayName || shipUser1.username;
        const name2 = member2?.displayName || shipUser2.username;

        // Get or create relationship
        const rel = await getOrCreateRelationship(shipUser1.id, shipUser2.id);

        // Calculate and persist score on first ship
        if (rel.shipScore === null) {
            rel.shipScore = calculateShipScore(shipUser1.id, shipUser2.id);
            rel.shipName = generateShipName(name1, name2);
            await Relationship.updateOne(
                { _id: rel._id, shipScore: null },
                { $set: { shipScore: rel.shipScore, shipName: rel.shipName } }
            );
        }

        const tier = getShipTier(rel.shipScore);

        const embed = new EmbedBuilder()
            .setColor(tier.color)
            .setTitle(`💕 Ship: ${rel.shipName}`)
            .setDescription(`**${name1}** × **${name2}**\n\n${tier.emoji} **${tier.label}** — ${rel.shipScore}%\n\n*${tier.line}*`)
            .addFields(
                { name: '📊 Status', value: rel.status === 'none' ? 'Not official' : rel.status.charAt(0).toUpperCase() + rel.status.slice(1), inline: true },
                { name: '📜 History', value: `${rel.history?.length || 0} events`, inline: true },
                { name: '⚔️ Battles', value: `${rel.battleWins}W / ${rel.battleLosses}L`, inline: true }
            )
            .setFooter({ text: "I-It's just an algorithm! Don't blame me for the results! (¬_¬)" });

        await message.reply({ embeds: [embed] });

        // Jealousy check: score >= 80 + either user in a relationship with someone else
        if (rel.shipScore >= 80) {
            const [u1, u2] = getSortedPair(shipUser1.id, shipUser2.id);
            const partnerRels = await Relationship.find({
                $or: [
                    { user1Id: shipUser1.id, status: { $in: ['dating', 'married'] } },
                    { user2Id: shipUser1.id, status: { $in: ['dating', 'married'] } },
                    { user1Id: shipUser2.id, status: { $in: ['dating', 'married'] } },
                    { user2Id: shipUser2.id, status: { $in: ['dating', 'married'] } }
                ]
            });

            for (const pRel of partnerRels) {
                // Skip the relationship between the two shipped users
                if ((pRel.user1Id === u1 && pRel.user2Id === u2) || (pRel.user1Id === u2 && pRel.user2Id === u1)) continue;

                // Find the partner who ISN'T one of the shipped users
                let partnerId = null;
                if (pRel.user1Id === shipUser1.id || pRel.user1Id === shipUser2.id) partnerId = pRel.user2Id;
                else partnerId = pRel.user1Id;

                if (partnerId) {
                    await message.channel.send(`...Hmm. <@${partnerId}> might want to see this ship score. Just saying. (¬_¬)`);
                    break; // Only tease once
                }
            }
        }

        return;
    }

    // --- EXISTING ACTION COMMANDS ---
    const action = ACTIONS[cmd];
    if (!action) return;

    const target = message.mentions.users.first();
    if (!target) return message.reply(`Usage: \`${cmd} @user\` — tag someone, baka! (¬_¬)`);

    // Self-target
    if (target.id === message.author.id) {
        return message.reply("Loving yourself is peak delusion. (¬_¬)");
    }

    // Fetch gif
    const gifUrl = await fetchGif(action.type);

    // Get display names
    const senderMember = await message.guild.members.fetch(message.author.id).catch(() => null);
    const targetMember = await message.guild.members.fetch(target.id).catch(() => null);
    const senderName = senderMember?.displayName || message.author.username;
    const targetName = targetMember?.displayName || target.username;

    // Bot-targeted special case
    if (target.id === client.user.id) {
        const botLine = action.botLines[Math.floor(Math.random() * action.botLines.length)];
        const embed = new EmbedBuilder()
            .setColor(action.color)
            .setDescription(`**${senderName}** ${action.verb} **${targetName}**!`)
            .setFooter({ text: botLine });
        if (gifUrl) embed.setImage(gifUrl);
        return message.reply({ embeds: [embed] });
    }

    // Normal target
    const line = action.lines[Math.floor(Math.random() * action.lines.length)];
    const embed = new EmbedBuilder()
        .setColor(action.color)
        .setDescription(`**${senderName}** ${action.verb} **${targetName}**!`)
        .setFooter({ text: line });
    if (gifUrl) embed.setImage(gifUrl);
    await message.reply({ embeds: [embed] });

    // --- Ship score adjustment (fire-and-forget, never blocks the action) ---
    (async () => {
        try {
            if (target.bot) return;
            const [u1, u2] = getSortedPair(message.author.id, target.id);
            const rel = await Relationship.findOne({ user1Id: u1, user2Id: u2 });
            if (!rel || rel.shipScore === null) return;

            const now = Date.now();

            if (POSITIVE_ACTIONS.has(cmd)) {
                if ((now - (rel.lastPositiveInteraction || 0)) >= SHIP_SCORE_POSITIVE_COOLDOWN) {
                    const newScore = Math.min(100, Math.round((rel.shipScore + 0.1) * 10) / 10);
                    await Relationship.updateOne(
                        { _id: rel._id },
                        { $set: { shipScore: newScore, lastPositiveInteraction: now } }
                    );
                }
            } else if (NEGATIVE_ACTIONS.has(cmd)) {
                if ((now - (rel.lastNegativeInteraction || 0)) >= SHIP_SCORE_NEGATIVE_COOLDOWN) {
                    const newScore = Math.max(0, Math.round((rel.shipScore - 0.1) * 10) / 10);
                    await Relationship.updateOne(
                        { _id: rel._id },
                        { $set: { shipScore: newScore, lastNegativeInteraction: now } }
                    );
                }
            }
        } catch {}
    })();

    return;
}

// ==================== RESOLVE SHIP BATTLE (called after 1h) ====================
async function resolveShipBattle(voteKey, client) {
    const votes = shipBattleVotes.get(voteKey);
    if (!votes) return;

    const countA = votes.votesA.size;
    const countB = votes.votesB.size;
    let finalized = false;

    try {
        const channel = await client.channels.fetch(votes.channelId).catch(() => null);
        if (!channel) return;

        // Disable buttons on original message
        try {
            const originalMsg = await channel.messages.fetch(votes.messageId).catch(() => null);
            if (originalMsg) {
                const disabledRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('sb_done_a').setLabel(`⚓ ${votes.shipName1}: ${countA}`).setStyle(ButtonStyle.Primary).setDisabled(true),
                    new ButtonBuilder().setCustomId('sb_done_b').setLabel(`💕 ${votes.shipName2}: ${countB}`).setStyle(ButtonStyle.Danger).setDisabled(true)
                );
                await originalMsg.edit({ components: [disabledRow] });
            }
        } catch {}

        if (countA === countB) {
            const embed = new EmbedBuilder()
                .setColor(0x808080)
                .setTitle('⚓ SHIP BATTLE RESULTS')
                .setDescription(
                    `**${votes.shipName1}** vs **${votes.shipName2}**\n\n` +
                    `Final: **${countA}** — **${countB}**\n\n` +
                    `*A tie?! How anticlimactic. Neither ship sinks today. (¬_¬)*`
                );
            await channel.send({ embeds: [embed] });
        } else {
            const winnerName = countA > countB ? votes.shipName1 : votes.shipName2;
            const loserName = countA > countB ? votes.shipName2 : votes.shipName1;
            const winnerRelId = countA > countB ? votes.rel1Id : votes.rel2Id;
            const loserRelId = countA > countB ? votes.rel2Id : votes.rel1Id;

            await Relationship.updateOne({ _id: winnerRelId }, { $inc: { battleWins: 1 } });
            await Relationship.updateOne({ _id: loserRelId }, { $inc: { battleLosses: 1 } });

            // Ship score impact: winner +1.0, loser -0.5
            const [winnerRel, loserRel] = await Promise.all([
                Relationship.findById(winnerRelId).lean(),
                Relationship.findById(loserRelId).lean()
            ]);
            if (winnerRel?.shipScore !== null) {
                const newWinScore = Math.min(100, Math.round((winnerRel.shipScore + 1.0) * 10) / 10);
                await Relationship.updateOne({ _id: winnerRelId }, { $set: { shipScore: newWinScore } });
            }
            if (loserRel?.shipScore !== null) {
                const newLoseScore = Math.max(0, Math.round((loserRel.shipScore - 0.5) * 10) / 10);
                await Relationship.updateOne({ _id: loserRelId }, { $set: { shipScore: newLoseScore } });
            }

            const embed = new EmbedBuilder()
                .setColor(0xFFD700)
                .setTitle('⚓ SHIP BATTLE RESULTS')
                .setDescription(
                    `**${winnerName}** defeats **${loserName}**!\n\n` +
                    `Final: **${votes.shipName1}**: ${countA} — **${votes.shipName2}**: ${countB}\n\n` +
                    `*${winnerName} wins. I don't make the rules. (¬_¬)*`
                );
            await channel.send({ embeds: [embed] });
        }
        finalized = true;
    } catch (error) {
        console.error('Failed to resolve ship battle:', error);
    }

    if (finalized) {
        shipBattleVotes.delete(voteKey);
    }
}

// ==================== HANDLE INTERACTION ====================
async function handleInteraction(interaction, client) {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith('propose_') && !interaction.customId.startsWith('marry_confirm_') && !interaction.customId.startsWith('shipbattle_')) return;

    // --- PROPOSE ACCEPT ---
    if (interaction.customId.startsWith('propose_accept_')) {
        const parts = interaction.customId.split('_');
        // propose_accept_{proposerId}_{targetId}_{cost}
        const proposerId = parts[2];
        const targetId = parts[3];
        const refundCost = parseInt(parts[4]);
        const proposalKey = interaction.message?.id || `${proposerId}:${targetId}`;

        if (interaction.user.id !== targetId) {
            return interaction.reply({ content: "This proposal isn't for you! Mind your own business! (¬_¬)", flags: MessageFlags.Ephemeral });
        }

        if (proposalActionLocks.has(proposalKey)) {
            return interaction.reply({ content: "This proposal is already being processed. (¬_¬)", flags: MessageFlags.Ephemeral });
        }
        proposalActionLocks.add(proposalKey);
        
        // Ensure refund timeout doesn't happen
        activeProposals.delete(`${proposerId}_${targetId}`);
        try {
            // Calculate target's cost
            const targetUser = await User.findOne({ userId: targetId });
            if (!targetUser) return interaction.reply({ content: "Something went wrong! (¬_¬)", flags: MessageFlags.Ephemeral });
            const targetCost = Math.max(config.SOCIAL.PROPOSAL.MIN_COST, Math.floor(targetUser.coins * config.SOCIAL.PROPOSAL.WEALTH_PERCENT));

            // Atomic deduction from target
            const deductResult = await User.findOneAndUpdate(
                { userId: targetId, coins: { $gte: targetCost } },
                { $inc: { coins: -targetCost, systemSpent: targetCost } },
                { new: true }
            );
            if (!deductResult) {
                return interaction.reply({ content: `You need **${targetCost.toLocaleString('en-US')} coins** to accept! You're too broke for love! (¬_¬)`, flags: MessageFlags.Ephemeral });
            }

            // Update relationship
            const [u1, u2] = getSortedPair(proposerId, targetId);
            await Relationship.updateOne(
                { user1Id: u1, user2Id: u2 },
                {
                    $set: { status: 'dating', initiatedBy: proposerId, confirmedAt: Date.now() },
                    $push: { history: { event: 'started_dating', timestamp: Date.now(), initiator: proposerId, note: 'Proposal accepted' } }
                },
                { upsert: true }
            );

            // Disable buttons
            const disabledRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('propose_done_a').setLabel('💕 Accepted!').setStyle(ButtonStyle.Success).setDisabled(true),
                new ButtonBuilder().setCustomId('propose_done_d').setLabel('💔 Decline').setStyle(ButtonStyle.Danger).setDisabled(true)
            );

            // Get ship name
            const rel = await Relationship.findOne({ user1Id: u1, user2Id: u2 });
            const shipName = rel?.shipName || 'a new couple';

            await interaction.update({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x00FF00)
                        .setTitle('💕 PROPOSAL ACCEPTED!')
                        .setDescription(`<@${proposerId}> and <@${targetId}> are now **DATING**!\n**${shipName}** begins its arc! >////<`)
                ],
                components: [disabledRow]
            });

            // Apply BF nickname suffix to both partners (fire-and-forget)
            if (interaction.guild) {
                applyRelationshipSuffix(interaction.guild, proposerId, targetId, 'dating');
                applyRelationshipSuffix(interaction.guild, targetId, proposerId, 'dating');
            }
            return;
        } finally {
            proposalActionLocks.delete(proposalKey);
        }
    }

    // --- PROPOSE DECLINE ---
    if (interaction.customId.startsWith('propose_decline_')) {
        const parts = interaction.customId.split('_');
        const proposerId = parts[2];
        const targetId = parts[3];
        const refundCost = parseInt(parts[4]);
        const proposalKey = interaction.message?.id || `${proposerId}:${targetId}`;

        if (interaction.user.id !== targetId) {
            return interaction.reply({ content: "This proposal isn't for you! Mind your own business! (¬_¬)", flags: MessageFlags.Ephemeral });
        }

        if (proposalActionLocks.has(proposalKey)) {
            return interaction.reply({ content: "This proposal is already being processed. (¬_¬)", flags: MessageFlags.Ephemeral });
        }
        proposalActionLocks.add(proposalKey);
        
        // Ensure refund timeout doesn't happen
        activeProposals.delete(`${proposerId}_${targetId}`);
        try {
            // Refund proposer
            await User.updateOne({ userId: proposerId }, { $inc: { coins: refundCost, systemSpent: -refundCost } });

            // Set cooldown
            const [u1, u2] = getSortedPair(proposerId, targetId);
            await Relationship.updateOne(
                { user1Id: u1, user2Id: u2 },
                {
                    $set: { lastProposalTime: Date.now() },
                    $push: { history: { event: 'proposal_rejected', timestamp: Date.now(), initiator: targetId, note: `${refundCost} coins refunded` } }
                },
                { upsert: true }
            );

            // Disable buttons
            const disabledRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('propose_done_a').setLabel('💕 Accept').setStyle(ButtonStyle.Success).setDisabled(true),
                new ButtonBuilder().setCustomId('propose_done_d').setLabel('💔 Declined').setStyle(ButtonStyle.Danger).setDisabled(true)
            );

            await interaction.update({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x808080)
                        .setTitle('💔 PROPOSAL DECLINED')
                        .setDescription(`<@${targetId}> declined <@${proposerId}>'s proposal.\n**${refundCost.toLocaleString('en-US')} coins** refunded.\n\n*Ouch. That's gotta sting. (¬_¬)*`)
                ],
                components: [disabledRow]
            });
            return;
        } finally {
            proposalActionLocks.delete(proposalKey);
        }
    }

    // --- MARRY CONFIRM ---
    if (interaction.customId.startsWith('marry_confirm_')) {
        const parts = interaction.customId.split('_');
        // marry_confirm_{clickerId}_{u1}_{u2}
        const allowedUserId = parts[2];
        const u1 = parts[3];
        const u2 = parts[4];
        const confirmKey = `${u1}_${u2}`;

        if (interaction.user.id !== allowedUserId) {
            return interaction.reply({ content: "That button's not for you! (¬_¬)", flags: MessageFlags.Ephemeral });
        }

        const confirmData = marriageConfirms.get(confirmKey);
        if (!confirmData) {
            return interaction.reply({ content: "This marriage session expired! Use `!marry` again. (¬_¬)", flags: MessageFlags.Ephemeral });
        }

        confirmData.confirmed.add(interaction.user.id);

        // Check if both confirmed
        if (confirmData.confirmed.size < 2) {
            return interaction.reply({ content: "Confirmed! Waiting for the other person... (¬_¬)", flags: MessageFlags.Ephemeral });
        }

        // Both confirmed — deduct from both atomically
        const deducted = [];
        const userIds = [u1, u2];
        for (const uid of userIds) {
            const cost = confirmData.costs[uid];
            const result = await User.findOneAndUpdate(
                { userId: uid, coins: { $gte: cost } },
                { $inc: { coins: -cost, systemSpent: cost } },
                { new: true }
            );
            if (!result) {
                // Refund anyone already deducted
                for (const prev of deducted) {
                    await User.updateOne({ userId: prev.uid }, { $inc: { coins: prev.cost, systemSpent: -prev.cost } });
                }
                marriageConfirms.delete(confirmKey);
                return interaction.reply({ content: `<@${uid}> can't afford their share (**${cost.toLocaleString('en-US')} coins**)! Marriage called off! (¬_¬)`, flags: MessageFlags.Ephemeral });
            }
            deducted.push({ uid, cost });
        }

        // Update relationship
        await Relationship.updateOne(
            { user1Id: u1, user2Id: u2 },
            {
                $set: { status: 'married', confirmedAt: Date.now() },
                $push: { history: { event: 'married', timestamp: Date.now(), note: 'Both confirmed' } }
            }
        );

        marriageConfirms.delete(confirmKey);

        // Disable buttons
        const disabledRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('marry_done_1').setLabel('💍 Married!').setStyle(ButtonStyle.Success).setDisabled(true),
            new ButtonBuilder().setCustomId('marry_done_2').setLabel('💍 Married!').setStyle(ButtonStyle.Success).setDisabled(true)
        );

        await interaction.update({
            embeds: [
                new EmbedBuilder()
                    .setColor(0xFFD700)
                    .setTitle('💒 MARRIED!')
                    .setDescription(`<@${u1}> and <@${u2}> are now **MARRIED**!\n**${confirmData.shipName}** is official!\n\n*I-I can't believe I'm witnessing this. >////<*`)
            ],
            components: [disabledRow]
        });

        // Announce in #general
        const generalChannel = interaction.guild?.channels.cache.find(c => c.name === config.CHANNELS.GENERAL);
        if (generalChannel) {
            const announceEmbed = new EmbedBuilder()
                .setColor(0xFFD700)
                .setTitle('💒 WEDDING ANNOUNCEMENT!')
                .setDescription(`<@${u1}> and <@${u2}> are now **MARRIED**!\n**${confirmData.shipName}** is official!\n\n*I-I'm not crying! There's just... something in my eye! >////<*`);
            await generalChannel.send({ embeds: [announceEmbed] });
        }

        // Apply Husband nickname suffix to both partners (fire-and-forget)
        if (interaction.guild) {
            applyRelationshipSuffix(interaction.guild, u1, u2, 'married');
            applyRelationshipSuffix(interaction.guild, u2, u1, 'married');
        }
        return;
    }

    // --- SHIP BATTLE VOTE ---
    if (interaction.customId.startsWith('shipbattle_')) {
        const parts = interaction.customId.split('_');
        // shipbattle_{a|b}_{rel1Id}_{rel2Id}
        const side = parts[1]; // 'a' or 'b'
        const rel1Id = parts[2];
        const rel2Id = parts[3];
        const voteKey = `${rel1Id}_${rel2Id}`;

        const voteData = shipBattleVotes.get(voteKey);
        if (!voteData) {
            return interaction.reply({ content: "This battle already ended! (¬_¬)", flags: MessageFlags.Ephemeral });
        }

        if (voteData.votesA.has(interaction.user.id) || voteData.votesB.has(interaction.user.id)) {
            return interaction.reply({ content: "You already voted! Pick a side and stick with it! (¬_¬)", flags: MessageFlags.Ephemeral });
        }

        if (side === 'a') {
            voteData.votesA.add(interaction.user.id);
        } else {
            voteData.votesB.add(interaction.user.id);
        }

        // Update vote counts on the original message
        try {
            const updatedRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`shipbattle_a_${rel1Id}_${rel2Id}`)
                    .setLabel(`⚓ ${voteData.shipName1}: ${voteData.votesA.size}`)
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId(`shipbattle_b_${rel1Id}_${rel2Id}`)
                    .setLabel(`💕 ${voteData.shipName2}: ${voteData.votesB.size}`)
                    .setStyle(ButtonStyle.Danger)
            );
            await interaction.update({ components: [updatedRow] });
            await interaction.followUp({ content: "Vote cast! >////<", ephemeral: true });
        } catch {
            await interaction.reply({ content: "Vote cast! >////<", flags: MessageFlags.Ephemeral });
        }
        return;
    }
}

// ==================== BACKGROUND: RELATIONSHIP MILESTONES & NEGLECT DECAY ====================
async function checkRelationshipDecayAndMilestones() {
    try {
        const now = Date.now();
        // Only process dating/married relationships that haven't been checked in 7+ days
        const relationships = await Relationship.find({
            status: { $in: ['dating', 'married'] },
            $or: [
                { lastMilestoneCheck: { $lte: now - SHIP_MILESTONE_INTERVAL } },
                { lastMilestoneCheck: 0 },
                { lastMilestoneCheck: null }
            ]
        }).lean();

        for (const rel of relationships) {
            if (rel.shipScore === null) continue;

            // Determine if the couple interacted in the last 7 days
            const lastPositive = rel.lastPositiveInteraction || 0;
            const lastNegative = rel.lastNegativeInteraction || 0;
            const lastAnyInteraction = Math.max(lastPositive, lastNegative);
            const wasNeglected = (now - lastAnyInteraction) >= SHIP_MILESTONE_INTERVAL;

            let delta;
            if (wasNeglected) {
                // Neglect decay: -0.5
                delta = -0.5;
            } else {
                // Milestone bonus: +1.0
                delta = 1.0;
            }

            const newScore = Math.max(0, Math.min(100, Math.round((rel.shipScore + delta) * 10) / 10));
            await Relationship.updateOne(
                { _id: rel._id },
                { $set: { shipScore: newScore, lastMilestoneCheck: now } }
            );
        }

        if (relationships.length > 0) {
            console.log(`💕 Relationship milestones: processed ${relationships.length} couples`);
        }
    } catch (err) {
        console.error('Error in relationship milestone/decay check:', err);
    }
}

module.exports = { handle, handleInteraction, checkRelationshipDecayAndMilestones, applyRelationshipSuffix, removeRelationshipSuffix, reapplyAllRelationshipSuffixes, REL_SUFFIX_REGEX };
