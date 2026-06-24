const {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
    AttachmentBuilder, ComponentType, ModalBuilder, TextInputBuilder,
    TextInputStyle, MessageFlags
} = require('discord.js');
const Canvas = require('canvas');
const User = require('../models/User');
const { uploadImage } = require('../utils/cloudinary');
const { distributeIncome } = require('../utils/income');
const { getDisplayName, createCleaningMap, getAmuletMultiplier } = require('../utils/helpers');
const config = require('../config');
const stockEngine = require('../utils/stockEngine');
const GACHA_TITLES = require('../config/gachaTitles');
const Relationship = require('../models/Relationship');

// Inline helper for sorted pair (avoid cross-module dependency)
function getSortedPair(id1, id2) { return id1 < id2 ? [id1, id2] : [id2, id1]; }
console.log('[BATTLE.JS] Title color system loaded - Gacha titles:', Object.keys(GACHA_TITLES));

// Shop titles (not in gacha - displayed in green)
// These are stored as Title Case in the database
const SHOP_TITLES = config.ITEMS.SHOP_TITLES;

// Helper to normalize title for comparison
const normalizeTitle = (title) => title?.toLowerCase().trim();

// Get title color based on rarity
function getTitleColor(title) {
    if (!title) return '#FFD700'; // Default gold

    const normalized = normalizeTitle(title);

    // Shop titles = Green (case-insensitive check)
    if (SHOP_TITLES.some(t => normalizeTitle(t) === normalized)) return '#00FF00';

    // Gacha titles by rarity (case-insensitive check)
    if (GACHA_TITLES.MYTHIC.some(t => normalizeTitle(t) === normalized)) return '#FF0000';     // 🔴 Mythic = Red
    if (GACHA_TITLES.ULTRA_RARE.some(t => normalizeTitle(t) === normalized)) return '#9B30FF'; // 🟣 Ultra = Purple
    if (GACHA_TITLES.LEGENDARY.some(t => normalizeTitle(t) === normalized)) return '#FFD700'; // 🟡 Legendary = Gold/Yellow
    if (GACHA_TITLES.RARE.some(t => normalizeTitle(t) === normalized)) return '#00BFFF';       // 🔵 Rare = Blue
    if (GACHA_TITLES.COMMON.some(t => normalizeTitle(t) === normalized)) return '#FFFFFF';     // ⚪ Common = White

    return '#00FF00'; // Unknown titles default to green (shop/custom)
}
const AsyncLock = require('async-lock');
const lock = new AsyncLock();

// ==================== STATE MANAGEMENT ====================
const activeBattles = new Set();
const activeGuessGames = new Set();
const activeBets = new Map();
const currentFighters = new Map();
// FIX: Use self-cleaning Map to prevent memory leaks (1 hour max age, cleanup every 30 mins)
const cooldowns = createCleaningMap(3600000, 1800000);

module.exports = {
    resetCooldowns: (userId) => {
        for (const [key, val] of cooldowns) {
            if (key.includes(userId)) cooldowns.delete(key);
        }
        return true;
    },

    // Export startGuessGame so index.js can auto-trigger it in #general
    startGuessGame,

    handle: async (message, client) => {
        const cmd = message.content.toLowerCase().split(' ')[0];
        const args = message.content.split(' ');

        if (cmd === '!guess') return startGuessGame(message);

        if (cmd.startsWith('!duel')) {
            if (args[1] === 'stats') {
                const target = message.mentions.users.first();
                if (!target) return message.reply("Tag someone to view their stats! Usage: `!duels stats @user` (¬_¬)");
                return showSelfStats(message, target);
            }

            if (message.attachments.size > 0) return handleImageUpload(message);

            const guildId = message.guild.id;

            if (args[1] === 'random') {
                return lock.acquire(guildId, () => startRandomDuel(message, client));
            }

            if (message.mentions.users.size > 0) {
                const target = message.mentions.users.first();
                return lock.acquire(guildId, () => startDuel(message, message.author, target));
            }

            return showSelfStats(message);
        }
    },

    handleInteraction: async (interaction, client) => {
        // Skip DM interactions
        if (!interaction.guild) return;
        // Only handle bet-related interactions
        if (!interaction.customId?.startsWith('bet_')) return;

        const guildId = interaction.guild.id;

        // --- 1. BETTING MENU ---
        if (interaction.customId === 'bet_menu_open') {
            if (!activeBattles.has(guildId)) {
                return interaction.reply({ content: "The battle is over! Go home! (¬_¬)", flags: MessageFlags.Ephemeral });
            }

            const fighters = currentFighters.get(guildId);
            if (!fighters) return interaction.reply({ content: "Error finding fighters.", flags: MessageFlags.Ephemeral });

            if (fighters.includes(interaction.user.id)) {
                return interaction.reply({ content: "Y-You can't bet on your own match! Match fixing is illegal, you cheater! (ﾟДﾟ)", flags: MessageFlags.Ephemeral });
            }

            const p1 = await client.users.fetch(fighters[0]);
            const p2 = await client.users.fetch(fighters[1]);

            const m1 = await interaction.guild.members.fetch(p1.id).catch(() => null);
            const m2 = await interaction.guild.members.fetch(p2.id).catch(() => null);
            const name1 = m1 ? m1.displayName : p1.username;
            const name2 = m2 ? m2.displayName : p2.username;

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`bet_select_${fighters[0]}`).setLabel(`Bet on ${name1}`).setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`bet_select_${fighters[1]}`).setLabel(`Bet on ${name2}`).setStyle(ButtonStyle.Danger)
            );

            return interaction.reply({ content: "💰 **Who are you betting on?**\n*Choose wisely...*", components: [row], flags: MessageFlags.Ephemeral });
        }

        // --- 2. SELECT FIGHTER -> OPEN MODAL ---
        if (interaction.customId.startsWith('bet_select_')) {
            const targetId = interaction.customId.split('_')[2];

            const modal = new ModalBuilder().setCustomId(`bet_confirm_${targetId}`).setTitle('How much?');
            const amountInput = new TextInputBuilder().setCustomId('amount').setLabel('Coins to Bet').setStyle(TextInputStyle.Short).setPlaceholder('e.g. 100').setRequired(true).setMaxLength(6);

            modal.addComponents(new ActionRowBuilder().addComponents(amountInput));
            return interaction.showModal(modal);
        }

        // --- 3. CONFIRM BET ---
        if (interaction.isModalSubmit() && interaction.customId.startsWith('bet_confirm_')) {
            const targetId = interaction.customId.split('_')[2];

            if (!activeBattles.has(guildId)) return interaction.reply({ content: "Battle ended while you were typing! Too slow! >///<", flags: MessageFlags.Ephemeral });

            // FIX: Prevent multiple bets from the same user
            const existingBets = activeBets.get(guildId) || [];
            const userAlreadyBet = existingBets.some(bet => bet.userId === interaction.user.id);
            if (userAlreadyBet) {
                return interaction.reply({ content: "You've already placed a bet on this battle! No changing your mind!", flags: MessageFlags.Ephemeral });
            }

            const amount = parseInt(interaction.fields.getTextInputValue('amount'));
            if (isNaN(amount) || amount < 10) return interaction.reply({ content: "Minimum bet is **10 coins**, you cheap bastard! Try again!", flags: MessageFlags.Ephemeral });

            const user = await User.findOne({ userId: interaction.user.id });
            if (!user) return interaction.reply({ content: "Database error! Try again, idiot!", flags: MessageFlags.Ephemeral });
            if (user.coins < amount) return interaction.reply({ content: `You're too broke! You only have ${user.coins} coins!`, flags: MessageFlags.Ephemeral });

            // Atomic bet deduction (prevents double-spend from concurrent bet clicks)
            console.log(`BET: User ${interaction.user.id} betting ${amount} coins on ${targetId}`);
            const betDeduct = await User.findOneAndUpdate(
                { userId: interaction.user.id, coins: { $gte: amount } },
                { $inc: { coins: -amount, systemSpent: amount } },
                { new: true }
            );
            if (!betDeduct) return interaction.reply({ content: `You're too broke! You only have ${user.coins} coins!`, flags: MessageFlags.Ephemeral });
            console.log(`BET: User ${interaction.user.id} now has ${betDeduct.coins} coins`);

            const bets = activeBets.get(guildId) || [];
            bets.push({ userId: interaction.user.id, amount, targetId });
            activeBets.set(guildId, bets);
            console.log(`BET: Total bets in this battle: ${bets.length}`);

            return interaction.reply({ content: `💸 **Bet Placed!**\n${amount} coins on <@${targetId}>.\n\n*Good luck...*`, flags: MessageFlags.Ephemeral });
        }
    }
};

// Helper to optimize Cloudinary URLs
function getOptimizedUrl(url, width = 600, height = 600) {
    if (!url || !url.includes('cloudinary.com')) return url;
    
    // Check if it already has transformations (part between /upload/ and /v<version>/)
    // We want to inject ours after /upload/
    const uploadIndex = url.indexOf('/upload/');
    if (uploadIndex === -1) return url;

    const prefix = url.substring(0, uploadIndex + 8); // .../upload/
    const suffix = url.substring(uploadIndex + 8); // rest of url

    // q_auto: automated quality (good compression)
    // f_auto: automated format (usually webp/avif)
    // c_limit: resize maintaining aspect ratio, don't upscale
    // w_600,h_600: max dimensions
    return `${prefix}w_${width},h_${height},c_limit,q_auto,f_auto/${suffix}`;
}

async function loadImageBuffer(url) {
    try {
        const optimizedUrl = getOptimizedUrl(url);
        // console.log(`[DEBUG] Loading Image: ${optimizedUrl}`); 
        const response = await fetch(optimizedUrl);
        if (!response.ok) throw new Error(`Failed to fetch image: ${response.statusText}`);
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    } catch (e) {
        console.error(`[IMAGE LOAD ERROR] Failed to load ${url}:`, e);
        throw e;
    }
}

// ==================== MAIN FUNCTIONS ====================

async function handleImageUpload(message) {
    const attachment = message.attachments.first();
    if (!attachment?.contentType?.startsWith('image/')) return message.reply("T-That's not an image, idiot! Upload a 3x3 grid! (ﾟДﾟ)");

    const loadingEmbed = new EmbedBuilder().setColor(0x0099FF).setDescription("☁️ **Uploading your grid...** Don't be impatient!");
    const loadingMsg = await message.reply({ embeds: [loadingEmbed] });

    try {
        const secureUrl = await uploadImage(attachment.url, message.author.id);

        await User.findOneAndUpdate(
            { userId: message.author.id },
            { $set: { gridUrl: secureUrl } },
            { upsert: true, new: true }
        );

        const successEmbed = new EmbedBuilder().setColor(0x57F287).setDescription("✅ **Grid Updated!**\nNow go fight someone instead of staring at it!");
        loadingMsg.edit({ embeds: [successEmbed] });
    } catch (err) {
        loadingMsg.edit({ content: "It failed! I-It's not my fault, okay?! Cloudinary is being stupid! >///<", embeds: [] });
        console.error(err);
    }
}

async function startDuel(message, p1User, p2User) {
    if (p1User.id === p2User.id || p2User.bot) return message.reply("Fighting yourself? What a pathetic loser! I-It's not like I care about your mental health or anything! >///<");
    if (activeBattles.has(message.guild.id)) return message.reply("Oi! Wait your fucking turn! A battle is already happening, you impatient bastard! ┐(￣ヘ￣;)┌");

    const p1Data = await User.findOne({ userId: p1User.id }) || new User({ userId: p1User.id });
    const p2Data = await User.findOne({ userId: p2User.id }) || new User({ userId: p2User.id });

    if (!p1Data.gridUrl) return message.reply("You haven't uploaded a grid yet! Do `!duel` with an image attached, you lazy piece of shit!");
    if (!p2Data.gridUrl) return message.reply(`**${p2User.username}** has no grid! Tell that worthless bum to get their act together!`);

    const cdKey = [p1User.id, p2User.id].sort().join('_');
    if (cooldowns.has(cdKey)) {
        const diff = Date.now() - cooldowns.get(cdKey);
        const CD_TIME = 3600000;
        if (diff < CD_TIME) {
            return message.reply(`Give them a break, you heartless monster! Wait <t:${Math.floor((cooldowns.get(cdKey) + CD_TIME) / 1000)}:R> before bullying them again! (¬_¬)`);
        }
    }

    const p1Member = await message.guild.members.fetch(p1User.id).catch(() => null);
    const p2Member = await message.guild.members.fetch(p2User.id).catch(() => null);
    const p1Name = p1Member ? p1Member.displayName : p1User.username;
    const p2Name = p2Member ? p2Member.displayName : p2User.username;

    activeBattles.add(message.guild.id);
    activeBets.set(message.guild.id, []);
    currentFighters.set(message.guild.id, [p1User.id, p2User.id]);
    cooldowns.set(cdKey, Date.now());

    const loadingEmbed = new EmbedBuilder().setColor(0x9900FF).setDescription("*Tch... fine. Preparing the arena. Don't make me regret this! (¬_¬)*");
    const loadingMsg = await message.channel.send({ embeds: [loadingEmbed] });

    try {
        const canvas = Canvas.createCanvas(1200, 600);
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, 1200, 600);

        const [p1Buffer, p2Buffer] = await Promise.all([
            loadImageBuffer(p1Data.gridUrl),
            loadImageBuffer(p2Data.gridUrl)
        ]);
        const img1 = await Canvas.loadImage(p1Buffer);
        const img2 = await Canvas.loadImage(p2Buffer);

        ctx.drawImage(img1, 25, 25, 550, 550);
        if (p1Data.frameColor) { ctx.strokeStyle = p1Data.frameColor; ctx.lineWidth = 15; ctx.strokeRect(25, 25, 550, 550); }

        ctx.drawImage(img2, 625, 25, 550, 550);
        if (p2Data.frameColor) { ctx.strokeStyle = p2Data.frameColor; ctx.lineWidth = 15; ctx.strokeRect(625, 25, 550, 550); }

        ctx.fillStyle = '#FF0000'; ctx.font = 'bold 80px sans-serif'; ctx.textAlign = 'center';
        ctx.shadowColor = 'black'; ctx.shadowBlur = 10;
        ctx.fillText('VS', 600, 320);

        ctx.shadowBlur = 0;

        // Enhanced title rendering with rarity-based colors
        ctx.font = 'bold italic 34px sans-serif';
        ctx.lineWidth = 5;
        ctx.textAlign = 'center';

        console.log(`[DUEL DEBUG] Rendering titles - P1: "${p1Data.equippedTitle || 'NONE'}", P2: "${p2Data.equippedTitle || 'NONE'}"`);

        if (p1Data.equippedTitle) {
            const p1TitleColor = getTitleColor(p1Data.equippedTitle);
            console.log(`[DUEL DEBUG] P1 Title: "${p1Data.equippedTitle}" -> Color: ${p1TitleColor}`);
            // Outer glow effect
            ctx.shadowColor = p1TitleColor;
            ctx.shadowBlur = 15;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;
            // Black outline for readability
            ctx.strokeStyle = '#000000';
            ctx.strokeText(p1Data.equippedTitle, 300, 560);
            // Colored fill
            ctx.fillStyle = p1TitleColor;
            ctx.fillText(p1Data.equippedTitle, 300, 560);
        }

        if (p2Data.equippedTitle) {
            const p2TitleColor = getTitleColor(p2Data.equippedTitle);
            console.log(`[DUEL DEBUG] P2 Title: "${p2Data.equippedTitle}" -> Color: ${p2TitleColor}`);
            // Outer glow effect
            ctx.shadowColor = p2TitleColor;
            ctx.shadowBlur = 15;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;
            // Black outline for readability
            ctx.strokeStyle = '#000000';
            ctx.strokeText(p2Data.equippedTitle, 900, 560);
            // Colored fill
            ctx.fillStyle = p2TitleColor;
            ctx.fillText(p2Data.equippedTitle, 900, 560);
        }

        ctx.shadowColor = "transparent"; ctx.shadowBlur = 0;

        const attachment = new AttachmentBuilder(canvas.toBuffer(), { name: 'battle.png' });
        const btnName1 = p1Name.slice(0, 75);
        const btnName2 = p2Name.slice(0, 75);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('vote_p1').setLabel(`Vote ${btnName1}`).setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('vote_p2').setLabel(`Vote ${btnName2}`).setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('bet_menu_open').setLabel('💸 Gamble').setStyle(ButtonStyle.Secondary)
        );

        const battleEmbed = new EmbedBuilder()
            .setColor(0x9900FF)
            .setTitle(`⚔️ TASTE BATTLE!`)
            .setDescription(`**${p1Name}** vs **${p2Name}**\n\nVote for the better taste! You have **60s**!`)
            .addFields(
                { name: `${p1Name}`, value: `⭐ **Elo:** ${p1Data.elo}\n\n🏆 **W/L:** ${p1Data.wins} / ${p1Data.losses}`, inline: true },
                { name: `VS`, value: `⚡`, inline: true },
                { name: `${p2Name}`, value: `⭐ **Elo:** ${p2Data.elo}\n\n🏆 **W/L:** ${p2Data.wins} / ${p2Data.losses}`, inline: true }
            )
            .setImage('attachment://battle.png');

        let statusEffects = [];
        if (p1Data.equippedShield) statusEffects.push(`🛡️ **${p1Name}** has a Shield!`);
        if (p2Data.equippedShield) statusEffects.push(`🛡️ **${p2Name}** has a Shield!`);

        // Amulet stacking display (using imported getAmuletMultiplier from helpers)
        if (p1Data.equippedAmuletCount > 0) {
            const mult = getAmuletMultiplier(p1Data.equippedAmuletCount);
            statusEffects.push(`🪙 **${p1Name}** has ${p1Data.equippedAmuletCount}x Amulets (${mult.toFixed(2)}x)`);
        }
        if (p2Data.equippedAmuletCount > 0) {
            const mult = getAmuletMultiplier(p2Data.equippedAmuletCount);
            statusEffects.push(`🪙 **${p2Name}** has ${p2Data.equippedAmuletCount}x Amulets (${mult.toFixed(2)}x)`);
        }

        if (p1Data.trashTasteExpiry > Date.now()) statusEffects.push(`📉 **${p1Name}** is Cursed!`);
        if (p2Data.trashTasteExpiry > Date.now()) statusEffects.push(`📉 **${p2Name}** is Cursed!`);
        if (statusEffects.length > 0) battleEmbed.addFields({ name: "Status Effects", value: statusEffects.join('\n'), inline: false });

        await loadingMsg.delete();
        const battleMsg = await message.channel.send({ embeds: [battleEmbed], files: [attachment], components: [row] });

        const collector = battleMsg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60000 });
        const votes = { p1: new Set(), p2: new Set() };

        collector.on('collect', async i => {
            if (i.customId === 'bet_menu_open') return;
            try {
                await i.deferReply({ flags: MessageFlags.Ephemeral });
                if (i.user.id === p1User.id || i.user.id === p2User.id) return i.editReply("No voting on yourself, baka!");
                if (votes.p1.has(i.user.id) || votes.p2.has(i.user.id)) return i.editReply("Already voted!");

                if (i.customId === 'vote_p1') votes.p1.add(i.user.id);
                if (i.customId === 'vote_p2') votes.p2.add(i.user.id);
                await i.editReply("Vote counted.");
            } catch (e) { }
        });

        collector.on('end', async () => {
            const guildId = message.guild.id;
            if (!activeBattles.has(guildId)) return;

            const currentBets = activeBets.get(guildId) || [];

            activeBattles.delete(guildId);
            currentFighters.delete(guildId);
            activeBets.delete(guildId);

            const v1 = votes.p1.size;
            const v2 = votes.p2.size;
            const totalVotes = v1 + v2;

            console.log(`Duel ended: ${p1Name} vs ${p2Name} (${v1}-${v2})`);

            let lowActivity = false;
            let resultDetails = "";
            let winnerId = null;

            // --- MINIMUM VOTE REQUIREMENT (Prevention of Alt Farming) ---
            if (totalVotes < 2) {
                lowActivity = true;
                
                // Refund Bets
                if (currentBets.length > 0) {
                    await Promise.all(currentBets.map(async (bet) => {
                        await User.findOneAndUpdate({ userId: bet.userId }, { $inc: { coins: bet.amount, systemSpent: -bet.amount } }).exec();
                    }));
                    resultDetails += "\n💸 **Bets Refunded!** Why did you bet on this dead match? Baka!\n";
                    // Clear bets so they aren't processed again
                    currentBets.length = 0; 
                }
                
                // We do NOT return here anymore. We let the embed generate.
            }
            let p1Change = 0, p2Change = 0;
            
            const K = 32;
            const exp1 = 1 / (1 + Math.pow(10, (p2Data.elo - p1Data.elo) / 400));
            const exp2 = 1 / (1 + Math.pow(10, (p1Data.elo - p2Data.elo) / 400));

            const p1Shield = p1Data.equippedShield;
            const p2Shield = p2Data.equippedShield;
            const p1Curse = p1Data.trashTasteExpiry > Date.now();
            const p2Curse = p2Data.trashTasteExpiry > Date.now();

            if (v1 > v2) {
                winnerId = p1User.id;
                p1Change = Math.round(K * (1 - exp1));
                if (p1Curse) { p1Change = Math.floor(p1Change / 2); resultDetails += `📉 **Curse!** ${p1Name} gained half Elo. What a weakling!\n`; }

                if (p2Shield) {
                    p2Change = 0;
                    p2Data.equippedShield = false;
                    resultDetails += `🛡️ **Shield!** ${p2Name} lost 0 Elo. Coward!\n`;
                } else {
                    p2Change = Math.round(K * (0 - exp2));
                    if (p2Curse) { p2Change *= 2; resultDetails += `📉 **Curse!** ${p2Name} lost DOUBLE Elo. Serves you right, loser!\n`; }
                }
                p1Data.wins++; p2Data.losses++;

            } else if (v2 > v1) {
                winnerId = p2User.id;
                p2Change = Math.round(K * (1 - exp2));
                if (p2Curse) { p2Change = Math.floor(p2Change / 2); resultDetails += `📉 **Curse!** ${p2Name} gained half Elo. Pathetic!\n`; }

                if (p1Shield) {
                    p1Change = 0;
                    p1Data.equippedShield = false;
                    resultDetails += `🛡️ **Shield!** ${p1Name} lost 0 Elo. Hiding behind items, huh?!\n`;
                } else {
                    p1Change = Math.round(K * (0 - exp1));
                    if (p1Curse) { p1Change *= 2; resultDetails += `📉 **Curse!** ${p1Name} lost DOUBLE Elo. What a joke!\n`; }
                }
                p2Data.wins++; p1Data.losses++;

            } else {
                p1Change = Math.round(K * (0.5 - exp1));
                p2Change = Math.round(K * (0.5 - exp2));
            }

            if (lowActivity) {
                p1Change = 0;
                p2Change = 0;
                resultDetails += `💤 **Hmph!** Only ${totalVotes} vote(s)? I'm not giving Elo for this dead match! (¬_¬)\n`;
            }

            // ==================== PHASE 5: ELO MEAT SHIELD ====================
            // Logic: If a user loses (Change < 0), check if they have slaves.
            // If they do, the slaves take 50% of the damage.

            // Check P1 Loss
            if (p1Change < 0) {
                const slaves = await User.find({ slaveOwner: p1User.id });
                if (slaves.length > 0) {
                    const totalLoss = Math.abs(p1Change);
                    const ownerAbsorb = Math.floor(totalLoss / 2);
                    const slaveAbsorb = totalLoss - ownerAbsorb; // The other half
                    const damagePerSlave = Math.ceil(slaveAbsorb / slaves.length);

                    // Update Owner (P1)
                    p1Change = -ownerAbsorb; // Reduce the negative change

                    // Update Slaves
                    await Promise.all(slaves.map(async (slave) => {
                        const newElo = Math.max(0, slave.elo - damagePerSlave); // Don't drop below 0
                        await User.updateOne({ userId: slave.userId }, { $set: { elo: newElo } });
                    }));

                    resultDetails += `🛡️ **Meat Shield!** ${slaves.length} slaves absorbed ${slaveAbsorb} damage for ${p1Name}!\n`;
                }
            }

            // Check P2 Loss
            if (p2Change < 0) {
                const slaves = await User.find({ slaveOwner: p2User.id });
                if (slaves.length > 0) {
                    const totalLoss = Math.abs(p2Change);
                    const ownerAbsorb = Math.floor(totalLoss / 2);
                    const slaveAbsorb = totalLoss - ownerAbsorb;
                    const damagePerSlave = Math.ceil(slaveAbsorb / slaves.length);

                    // Update Owner (P2)
                    p2Change = -ownerAbsorb;

                    // Update Slaves
                    await Promise.all(slaves.map(async (slave) => {
                        const newElo = Math.max(0, slave.elo - damagePerSlave);
                        await User.updateOne({ userId: slave.userId }, { $set: { elo: newElo } });
                    }));

                    resultDetails += `🛡️ **Meat Shield!** ${slaves.length} slaves absorbed ${slaveAbsorb} damage for ${p2Name}!\n`;
                }
            }
            // ==================== END PHASE 5 ====================

            if (winnerId && !lowActivity) {
                const winnerData = (winnerId === p1User.id) ? p1Data : p2Data;
                const loserElo = (winnerId === p1User.id) ? p2Data.elo : p1Data.elo;
                let reward = 0;
                let amuletCount = 0;
                let amuletMult = 1.0;

                // Wealth-based base reward + Elo bonus (additive, not a floor)
                const winnerBalance = winnerData.coins;
                let baseReward;
                if (winnerBalance >= 1000000) baseReward = 30000;
                else if (winnerBalance >= 500000) baseReward = 20000;
                else if (winnerBalance >= 100000) baseReward = 15000;
                else if (winnerBalance >= 50000) baseReward = 10000;
                else if (winnerBalance >= 10000) baseReward = 1000;
                else baseReward = 250;

                reward = baseReward + Math.floor(80 + (loserElo / 5));

                // Amulet stacking multiplier - APPLIED AFTER minimum
                if (winnerData.equippedAmuletCount > 0) {
                    amuletCount = winnerData.equippedAmuletCount;
                    amuletMult = getAmuletMultiplier(amuletCount);
                    reward = Math.floor(reward * amuletMult);
                    resultDetails += `✨ **${amuletCount}x Amulets!** Winner got ${amuletMult.toFixed(2)}x Coins!\n`;
                }

                // ATOMIC UPDATE: Distribute income and reset amulets in one operation
                const log = await distributeIncome(winnerId, reward);

                // Then atomically reset amulets (prevents race condition)
                if (amuletCount > 0) {
                    await User.findOneAndUpdate(
                        { userId: winnerId },
                        { $set: { equippedAmuletCount: 0 } }
                    );
                    winnerData.equippedAmuletCount = 0;
                }

                resultDetails += `💰 **Winner Reward:** +${reward} Coins${log}\n`;
            } else if (winnerId && lowActivity) {
                resultDetails += `💤 **Boring!** Only ${totalVotes} vote(s)? You don't deserve any coins for this! Go find some friends! >///< \n`;
            }

            let bettingText = "";
            let totalBetOnP1 = 0;
            let totalBetOnP2 = 0;

            currentBets.forEach(bet => {
                if (bet.targetId === p1User.id) totalBetOnP1 += bet.amount;
                else if (bet.targetId === p2User.id) totalBetOnP2 += bet.amount;
            });

            if (winnerId && currentBets.length > 0) {
                console.log(`BATTLE END: Processing ${currentBets.length} bets for winner ${winnerId}`);
                let poolP1 = 0, poolP2 = 0;
                currentBets.forEach(b => b.targetId === p1User.id ? poolP1 += b.amount : poolP2 += b.amount);
                const winnerPool = (winnerId === p1User.id) ? poolP1 : poolP2;
                const totalPool = poolP1 + poolP2;

                if (winnerPool === 0) {
                    // CASE: Bets exist, but NO ONE bet on the winner. Refund everyone.
                    // SAFETY CHECK: Direct update used to prevent Prestige Bonus exploit.
                    console.log(`BATTLE END: No one bet on winner, refunding all bets`);
                    bettingText = "💸 **No winners!** Refunds for everyone... try using your brain next time! (¬_¬)";

                    await Promise.all(currentBets.map(async (bet) => {
                        await User.findOneAndUpdate({ userId: bet.userId }, { $inc: { coins: bet.amount, systemSpent: -bet.amount } }).exec();
                    }));
                } else {
                    const loserPool = totalPool - winnerPool;

                    if (loserPool === 0) {
                        // CASE: One-sided pool — all bets on the winner, no opposing money.
                        // Profit would be 0 for everyone, so refund stakes instead of confusing "won 0" messages.
                        console.log(`BATTLE END: One-sided bets, refunding all stakes`);
                        bettingText = "💸 **One-sided bets!** No one bet against the winner — stakes returned, no profit possible! (¬_¬)";

                        await Promise.all(currentBets.map(async (bet) => {
                            await User.findOneAndUpdate({ userId: bet.userId }, { $inc: { coins: bet.amount, systemSpent: -bet.amount } }).exec();
                        }));
                    } else {
                        // CASE: Payout Winners (normal two-sided pool)
                        console.log(`BATTLE END: Processing payouts for ${winnerPool} coins on winner`);
                        const winnerBetLines = await Promise.all(
                            currentBets
                                .filter(bet => bet.targetId === winnerId)
                                .map(async (bet) => {
                                    const share = bet.amount / winnerPool;
                                    const payout = Math.floor(share * totalPool);
                                    const displayName = await getDisplayName(bet.userId, message.guild);

                                    // Return winner's original stake and reverse systemSpent
                                    await User.findOneAndUpdate({ userId: bet.userId }, { $inc: { coins: bet.amount, systemSpent: -bet.amount } });
                                    // WINNERS get the Prestige Bonus (distributeIncome) on PROFIT ONLY
                                    const profit = payout - bet.amount;
                                    const log = await distributeIncome(bet.userId, profit);
                                    return `**${displayName}** bet **${bet.amount}** → won **${profit}** coins!${log}`;
                                })
                        );
                        bettingText += winnerBetLines.join('\n') + '\n';
                    }
                }
            } else if (!winnerId && currentBets.length > 0) {
                // CASE: Tie. Refund everyone.
                // SAFETY CHECK: Direct update used to prevent Prestige Bonus exploit.
                console.log(`BATTLE END: Tie, refunding ${currentBets.length} bets`);
                bettingText = "💸 **It's a Tie!** Bets refunded. Boring... (¬_¬)";

                await Promise.all(currentBets.map(async (bet) => {
                    await User.findOneAndUpdate({ userId: bet.userId }, { $inc: { coins: bet.amount, systemSpent: -bet.amount } }).exec();
                }));
            }

            if (currentBets.length > 0) {
                bettingText += `\n💰 **Betting Summary:**\n`;
                bettingText += `**${p1Name}:** ${totalBetOnP1} coins bet\n`;
                bettingText += `**${p2Name}:** ${totalBetOnP2} coins bet\n`;
                bettingText += `**Total Pool:** ${totalBetOnP1 + totalBetOnP2} coins`;
            }


            // --- 🎯 BOUNTY SYSTEM CHECK (FIXED) ---
            if (winnerId) {
                const winnerDB = (winnerId === p1User.id) ? p1Data : p2Data;
                const loserDB = (winnerId === p1User.id) ? p2Data : p1Data;
                const winnerNameStr = (winnerId === p1User.id) ? p1Name : p2Name;
                const loserNameStr = (winnerId === p1User.id) ? p2Name : p1Name;

                if (loserDB.bounty > 0 && !lowActivity) {
                    const bountyReward = loserDB.bounty;

                    // FIX 2: Use distributeIncome to handle Taxes & Loans
                    // This returns a 'log' string showing deductions (e.g. "Slave Tax: -400")
                    const log = await distributeIncome(winnerId, bountyReward);

                    loserDB.bounty = 0; // Clear the total bounty from loser
                    loserDB.activeBounties = []; // FIX: Also clear the individual bounty tracker array
                    // Note: distributeIncome already adds the money to the winnerDB, 
                    // so we do NOT need "winnerDB.coins += ...".
                    // However, we must reload the winnerDB to save the battle Elo stats correctly later,
                    // or just acknowledge that distributeIncome saved it. 
                    // To be safe, we refresh the RAM copy of coins:
                    const freshWinner = await User.findOne({ userId: winnerId });
                    winnerDB.coins = freshWinner.coins;

                    // FIX 1: Improved Notification
                    const bountyEmbed = new EmbedBuilder()
                        .setColor(0xFFD700) // Gold
                        .setTitle(`🎯 BOUNTY CLAIMED: ${winnerNameStr}`)
                        .setDescription(
                            `**${winnerNameStr}** hunted down **${loserNameStr}**!\n` +
                            `💀 **The Contract is Closed.**\n\n` +
                            `💰 **Bounty:** ${bountyReward.toLocaleString('en-US')} Coins\n` +
                            `${log}` // Shows the Tax/Loan deductions clearly
                        )

                    message.channel.send({ embeds: [bountyEmbed] });
                }
            }
            // -----------------------------

            // ==================== RIVALS ELO BONUS ====================
            if (winnerId && !lowActivity) {
                const [sId1, sId2] = getSortedPair(p1User.id, p2User.id);
                const rivalRel = await Relationship.findOne({ user1Id: sId1, user2Id: sId2, status: 'enemies' });
                if (rivalRel) {
                    if (winnerId === p1User.id) {
                        p1Change = Math.floor(p1Change * 1.5);
                    } else {
                        p2Change = Math.floor(p2Change * 1.5);
                    }
                    resultDetails += `⚔️ **Rivals Bonus:** +50% ELO! The hatred fuels them! (¬_¬)\n`;
                }
            }
            // ==================== END RIVALS ====================

            const p1Atomic = { $inc: { elo: p1Change } };
            const p2Atomic = { $inc: { elo: p2Change } };

            if (v1 > v2) {
                p1Atomic.$inc.wins = 1;
                p2Atomic.$inc.losses = 1;
                // Duel streak: winner +1, loser reset (skip on low-activity matches)
                if (!lowActivity) {
                    p1Atomic.$inc.currentDuelStreak = 1;
                    if (!p2Atomic.$set) p2Atomic.$set = {};
                    p2Atomic.$set.currentDuelStreak = 0;
                }
            } else if (v2 > v1) {
                p2Atomic.$inc.wins = 1;
                p1Atomic.$inc.losses = 1;
                if (!lowActivity) {
                    p2Atomic.$inc.currentDuelStreak = 1;
                    if (!p1Atomic.$set) p1Atomic.$set = {};
                    p1Atomic.$set.currentDuelStreak = 0;
                }
            }

            if (p1Shield && !p1Data.equippedShield) {
                if (!p1Atomic.$set) p1Atomic.$set = {};
                p1Atomic.$set.equippedShield = false;
            }
            if (p2Shield && !p2Data.equippedShield) {
                if (!p2Atomic.$set) p2Atomic.$set = {};
                p2Atomic.$set.equippedShield = false;
            }

            // Persist bounty clearing for the loser (was only in-memory before)
            if (winnerId) {
                const loserAtomic = (winnerId === p1User.id) ? p2Atomic : p1Atomic;
                const loserDB = (winnerId === p1User.id) ? p2Data : p1Data;
                if (loserDB.bounty === 0) {
                    if (!loserAtomic.$set) loserAtomic.$set = {};
                    loserAtomic.$set.bounty = 0;
                    loserAtomic.$set.activeBounties = [];
                }
            }

            // Pre-read winner's data for streak announcement and nugget milestone check
            let winnerOldStreak = 0;
            let winnerOldWins = 0;
            let winnerOldMilestone = 0;
            if (winnerId) {
                const winnerDoc = await User.findOne({ userId: winnerId }).select('currentDuelStreak wins nuggetDuelMilestone').lean();
                winnerOldStreak = winnerDoc?.currentDuelStreak || 0;
                winnerOldWins = winnerDoc?.wins || 0;
                winnerOldMilestone = winnerDoc?.nuggetDuelMilestone || 0;
            }

            p1Data.elo += p1Change; p2Data.elo += p2Change;
            await User.updateOne({ userId: p1User.id }, p1Atomic);
            await User.updateOne({ userId: p2User.id }, p2Atomic);

            // TsunStocks: update stock prices on duel result
            if (winnerId && !lowActivity) {
                const loserId = (winnerId === p1User.id) ? p2User.id : p1User.id;
                stockEngine.onDuelResult(winnerId, loserId).catch(() => {});
            }

            // Nugget duel milestone (every 5 wins = +1 nugget)
            if (winnerId && !lowActivity) {
                const newWins = winnerOldWins + 1;
                if (newWins >= winnerOldMilestone + 5) {
                    await User.updateOne(
                        { userId: winnerId },
                        { $inc: { nuggets: 1, nuggetDuelMilestone: 5 } }
                    );
                    resultDetails += `💎 **+1 Nugget** milestone! (Win #${newWins})\n`;
                }
            }

            // Duel streak announcement (every 5 consecutive wins, skip low-activity)
            if (winnerId && !lowActivity) {
                const winnerNewStreak = winnerOldStreak + 1;
                if (winnerNewStreak >= 5 && winnerNewStreak % 5 === 0) {
                    const generalChannel = message.guild.channels.cache.find(c => c.name === config.CHANNELS.GENERAL);
                    if (generalChannel) {
                        const streakEmbed = new EmbedBuilder()
                            .setColor(0xFF4500)
                            .setTitle('⚔️ DUEL STREAK')
                            .setDescription(`<@${winnerId}> just won their **${winnerNewStreak}th** consecutive duel! Someone stop them before I'm forced to acknowledge their skill. (¬_¬)`);
                        generalChannel.send({ embeds: [streakEmbed] }).catch(() => {});
                    }
                }
            }

            updateLeaderRole(message.guild, message.channel);

            const resultEmbed = new EmbedBuilder()
                .setColor(0xFFD700)
                .setTitle(winnerId ? `🏆 Winner: ${winnerId === p1User.id ? p1Name : p2Name}` : "🤝 Draw!")
                .setDescription(`**Final Score:** ${v1} - ${v2}\n\n${resultDetails}`)
                .addFields(
                    { name: `${p1Name}`, value: `${p1Data.elo} (${p1Change >= 0 ? '+' : ''}${p1Change})`, inline: true },
                    { name: `${p2Name}`, value: `${p2Data.elo} (${p2Change >= 0 ? '+' : ''}${p2Change})`, inline: true }
                )
                .setImage('attachment://battle.png');

            if (bettingText) resultEmbed.addFields({ name: "🎰 Betting Payouts", value: bettingText, inline: false });

            battleMsg.edit({ components: [] });
            message.channel.send({ embeds: [resultEmbed], files: [attachment] });
        });

    } catch (err) {
        console.error(err);
        activeBattles.delete(message.guild.id);
        message.channel.send("Something broke! Ugh! ┐(￣ヘ￣;)┌");
    }
}

// MAL Client ID from centralized config
const MAL_CLIENT_ID = config.MAL_CLIENT_ID;

async function startGuessGame(message) {
    if (activeGuessGames.has(message.channel.id)) return message.reply("One guessing game at a time!");
    activeGuessGames.add(message.channel.id);

    const loading = await message.channel.send("Searching for a mystery manga... 🔍");

    try {
        const randomRank = Math.floor(Math.random() * 3000);

        const response = await fetch(`https://api.myanimelist.net/v2/manga/ranking?ranking_type=all&limit=1&offset=${randomRank}&fields=mean,main_picture`, {
            headers: { 'X-MAL-CLIENT-ID': MAL_CLIENT_ID }
        });

        if (!response.ok) throw new Error(`MAL API Error: ${response.statusText}`);

        const data = await response.json();

        if (!data.data || !data.data.length) {
            activeGuessGames.delete(message.channel.id);
            return loading.edit("Error finding manga.");
        }

        const mangaNode = data.data[0].node;
        const title = mangaNode.title;
        const coverUrl = mangaNode.main_picture ? mangaNode.main_picture.large || mangaNode.main_picture.medium : null;
        const rating = mangaNode.mean || 0;

        await loading.delete();

        const embed = new EmbedBuilder()
            .setColor(0xFFA500)
            .setTitle("Guess the MAL Score: ???")
            .setDescription(`Type your guess (0-10) below! **15 Seconds!**`)
            .setImage(coverUrl);

        await message.channel.send({ embeds: [embed] });

        const collector = message.channel.createMessageCollector({
            filter: m => !m.author.bot && !isNaN(parseFloat(m.content)),
            time: 15000
        });
        const guesses = new Map();
        const timedOutUsers = new Set(); // Track users we've already warned about timeout

        collector.on('collect', async m => {
            if (guesses.has(m.author.id)) return;

            // Check if user is timed out from !guess due to win streak
            const guesser = await User.findOne({ userId: m.author.id });
            if (guesser && guesser.guessTimeoutExpiry && guesser.guessTimeoutExpiry > Date.now()) {
                if (!timedOutUsers.has(m.author.id)) {
                    timedOutUsers.add(m.author.id);
                    const remainingMs = guesser.guessTimeoutExpiry - Date.now();
                    const hours = Math.floor(remainingMs / 3600000);
                    const mins = Math.floor((remainingMs % 3600000) / 60000);
                    m.reply(`🚫 You're on a **${hours}h ${mins}m** cooldown for winning too many times in a row! Come back later, lucky streak! (¬_¬)`).catch(() => { });
                }
                return;
            }

            const val = parseFloat(m.content);
            if (val >= 0 && val <= 10) {
                const duplicate = [...guesses.values()].some(g => g.val === val);
                if (duplicate) {
                    return m.reply("B-Baka! Someone already guessed **" + val + "**! Pick another number, you copycat! >///< ").catch(() => { });
                }
                guesses.set(m.author.id, { user: m.author, val });
                m.react('✅').catch(() => { });
            }
        });

        collector.on('end', async () => {
            activeGuessGames.delete(message.channel.id);

            if (guesses.size === 0) {
                return message.channel.send(`Time's up! It was **${title}** (Score: **${rating}**). No one played!`);
            }

            const sorted = [...guesses.values()].sort((a, b) => Math.abs(a.val - rating) - Math.abs(b.val - rating));
            const winner = sorted[0];
            const diff = Math.abs(winner.val - rating).toFixed(2);

            let rewardMsg = "";
            if (guesses.size >= 2) {
                // Fetch winner's current balance to determine reward tier
                const winnerUser = await User.findOne({ userId: winner.user.id });
                const balance = winnerUser ? winnerUser.coins : 0;

                // Wealth-based reward tiers using config.GUESS_REWARDS
                let reward = 100;
                for (const tier of config.GUESS_REWARDS) {
                    if (balance < tier.threshold) {
                        reward = tier.reward;
                        break;
                    }
                }

                let exactBonusText = "";
                if (parseFloat(diff) === 0) {
                    reward = Math.floor(reward * 1.5);
                    exactBonusText = " (🎯 **EXACT MATCH 1.5x!**)";
                }

                const log = await distributeIncome(winner.user.id, reward);
                const freshWinnerUser = await User.findOne({ userId: winner.user.id });
                const displayName = await getDisplayName(winner.user.id, message.guild);
                rewardMsg = `\n💰 **+${reward.toLocaleString('en-US')} Coins**${exactBonusText} for ${displayName}!${log}\n💳 **Balance:** ${freshWinnerUser?.coins?.toLocaleString('en-US') || '???'} — I'm watching your wallet, idiot. (¬_¬)`;
            }

            const winnerDisplayName = await getDisplayName(winner.user.id, message.guild);

            // ==================== WIN STREAK TRACKING ====================
            // Only track if more than 1 player participated (competitive game)
            let streakMsg = "";
            if (guesses.size >= 2) {
                // Get all participant IDs
                const participantIds = [...guesses.keys()];

                // Reset ALL participants' streaks first (losers get reset)
                await User.updateMany(
                    { userId: { $in: participantIds, $ne: winner.user.id } },
                    { $set: { guessWinStreak: 0 } }
                );

                // Increment winner's streak
                const winnerDB = await User.findOneAndUpdate(
                    { userId: winner.user.id },
                    { $inc: { guessWinStreak: 1 } },
                    { new: true, upsert: true }
                );

                const newStreak = winnerDB.guessWinStreak || 1;

                // Check if streak >= 8 - apply 8-hour timeout
                if (newStreak >= 8) {
                    const TIMEOUT_DURATION = 8 * 60 * 60 * 1000; // 8 hours in ms
                    await User.findOneAndUpdate(
                        { userId: winner.user.id },
                        {
                            $set: {
                                guessTimeoutExpiry: Date.now() + TIMEOUT_DURATION,
                                guessWinStreak: 0 // Reset streak after timeout
                            }
                        }
                    );
                    streakMsg = `\n\n🔥 **${newStreak} WIN STREAK!** ${winnerDisplayName} is TOO GOOD! They're now on an **8-hour cooldown** from !guess! Give others a chance, you tryhard! >///< `;
                } else if (newStreak >= 5) {
                    // Warning at 5-7 wins
                    streakMsg = `\n\n🔥 **${newStreak} Win Streak!** ${8 - newStreak} more and you're on timeout! (¬_¬)`;
                } else if (newStreak >= 3) {
                    streakMsg = `\n\n✨ **${newStreak} Win Streak!**`;
                }
            }

            const resEmbed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle(`The Manga was: ${title}`)
                .setDescription(`**Actual MAL Score: ${rating}**\n\n🏆 **${winnerDisplayName}** won!\nGuessed: **${winner.val}** (Off by ${diff})${guesses.size < 2 ? '\n*(Solo game — no reward! Play with at least 2 people for coins!)*' : ''}${rewardMsg}${streakMsg}`)
                .setThumbnail(coverUrl);

            message.channel.send({ embeds: [resEmbed] });
        });

    } catch (e) {
        console.error(e);
        activeGuessGames.delete(message.channel.id);
        loading.edit("API Error! Check console for details.");
    }
}

async function startRandomDuel(message, client) {
    const userId = message.author.id;
    const excludedUserIds = new Set([userId]);

    for (const [cdKey, entry] of cooldowns) {
        // createCleaningMap stores { value, timestamp } internally
        // direct iteration returns raw entries so we must read .value
        const timestamp = entry?.value ?? entry;
        const diff = Date.now() - timestamp;
        const CD_TIME = 3600000;
        if (diff < CD_TIME) {
            const [id1, id2] = cdKey.split('_');
            if (id1 === userId) excludedUserIds.add(id2);
            else if (id2 === userId) excludedUserIds.add(id1);
        }
    }

    const excludedIds = Array.from(excludedUserIds);

    const randomUsers = await User.aggregate([
        {
            $match: {
                gridUrl: { $ne: null },
                userId: { $nin: excludedIds }
            }
        },
        { $sample: { size: 1 } }
    ]);

    if (randomUsers.length === 0) {
        if (excludedIds.length > 1) {
            return message.reply("You've battled everyone recently! Give them a break and try again later! (¬_¬)");
        } else {
            return message.reply("No one else has a grid! You're alone! (¬_¬)");
        }
    }

    try {
        const targetUser = await client.users.fetch(randomUsers[0].userId);
        return startDuel(message, message.author, targetUser);
    } catch (e) {
        return message.reply("Found an opponent but they vanished. Spooky.");
    }
}

async function showSelfStats(message, targetUser = null) {
    const target = targetUser || message.author;
    const user = await User.findOne({ userId: target.id });
    if (!user || !user.gridUrl) return message.reply(`${targetUser ? target.username + " has" : "You have"} no profile! ${targetUser ? "They need" : "Upload an image with `!duel`"} first!`);

    try {
        const buffer = await loadImageBuffer(user.gridUrl);
        const canvas = Canvas.createCanvas(580, 630);
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = '#1a1a1a'; ctx.fillRect(0, 0, 580, 630);
        const img = await Canvas.loadImage(buffer);
        ctx.drawImage(img, 15, 15, 550, 550);

        if (user.frameColor) {
            ctx.strokeStyle = user.frameColor;
            ctx.lineWidth = 15;
            ctx.strokeRect(15, 15, 550, 550);
        }

        if (user.equippedTitle) {
            const titleColor = getTitleColor(user.equippedTitle);
            ctx.textAlign = 'center';
            ctx.font = 'bold italic 28px sans-serif';
            ctx.lineWidth = 4;
            // Glow effect
            ctx.shadowColor = titleColor;
            ctx.shadowBlur = 12;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;
            // Black outline
            ctx.strokeStyle = '#000000';
            ctx.strokeText(user.equippedTitle, 290, 610);
            // Colored fill
            ctx.fillStyle = titleColor;
            ctx.fillText(user.equippedTitle, 290, 610);
            // Reset shadow
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
        }

        const attachment = new AttachmentBuilder(canvas.toBuffer(), { name: 'stats.png' });

        const displayName = await getDisplayName(target.id, message.guild);
        const embed = new EmbedBuilder()
            .setColor(user.frameColor || '#0099ff')
            .setTitle(`${displayName}'s Stats`)
            .addFields(
                { name: '⭐ Elo', value: user.elo.toLocaleString('en-US'), inline: true },
                { name: '🏆 W/L', value: `${user.wins} / ${user.losses}`, inline: true },
                { name: '💳 Coins', value: user.coins.toLocaleString('en-US'), inline: true }
            )
            .setImage('attachment://stats.png');

        message.reply({ embeds: [embed], files: [attachment] });
    } catch (e) {
        console.error(e);
        message.reply("Stats image failed to load... tch, what a pain.");
    }
}

async function updateLeaderRole(guild, channel) {
    try {
        const topUser = await User.findOne({ wins: { $gt: 0 } }).sort({ elo: -1 });
        if (!topUser) return;

        const role = guild.roles.cache.find(r => r.name === config.ROLES.DUEL_LORD);
        if (!role) return;

        const currentLord = role.members.first();
        if (currentLord && currentLord.id === topUser.userId) return;

        if (currentLord) await currentLord.roles.remove(role);

        const newLord = await guild.members.fetch(topUser.userId).catch(() => null);
        if (newLord) {
            await newLord.roles.add(role);

            if (channel) {
                const embed = new EmbedBuilder()
                    .setColor(0xFFD700)
                    .setTitle("👑 A NEW KING IS CROWNED!")
                    .setDescription(`**${newLord.displayName}** has taken the throne as **Duel Lord**!\n\nAll hail the new ruler of Taste!`)
                    .setThumbnail(newLord.user.displayAvatarURL());
                channel.send({ embeds: [embed] });
            }
        }

    } catch (e) { console.error("Role Error:", e); }
}

