const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, AttachmentBuilder } = require('discord.js');
const Canvas = require('canvas');
const mangaCache = require('../utils/mangaCache');
const { distributeIncome } = require('../utils/income');
const User = require('../models/User');
const config = require('../config');
const stockEngine = require('../utils/stockEngine');
const fs = require('fs');
const path = require('path');

// --- CANVAS SETUP ---
// Fallback font handling
try {
    Canvas.registerFont(require('path').join(__dirname, '../node_modules/canvas/examples/fonts/Pfennig.ttf'), { family: 'Pfennig' });
} catch (e) {
    // Ignore if font missing, will use default
}

async function loadMangaImageSafe(manga) {
    const localPath = path.join(__dirname, '..', 'assets', 'manga', `${manga.id}.jpg`);
    if (fs.existsSync(localPath)) {
        try {
            return await Canvas.loadImage(localPath);
        } catch (e) {
            console.error(`Local image corrupt for ${manga.id}, falling back to MAL.`);
            return await Canvas.loadImage(manga.image);
        }
    }
    return await Canvas.loadImage(manga.image);
}

async function createGameCanvas(mangaA, mangaB, revealB = false) {
    const canvas = Canvas.createCanvas(800, 400);
    const ctx = canvas.getContext('2d');

    // 1. Backgrounds
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, 400, 400); // Left
    ctx.fillStyle = '#2b2b2b';
    ctx.fillRect(400, 0, 400, 400); // Right

    // 2. Helper Logic
    const drawItem = async (manga, offset, showScore) => {
        if (!manga) return;

        // Image
        try {
            const img = await loadMangaImageSafe(manga);
            // Draw image keeping aspect ratio, crop to fill 400x400
            const scale = Math.max(400 / img.width, 400 / img.height);
            const x = offset + (400 / 2) - (img.width * scale / 2);
            const y = (400 / 2) - (img.height * scale / 2);
            ctx.drawImage(img, x, y, img.width * scale, img.height * scale);
        } catch (e) {
            ctx.fillStyle = '#333333';
            ctx.fillRect(offset, 0, 400, 400);
        }

        // Overlay Gradient
        const gradient = ctx.createLinearGradient(offset, 250, offset, 400);
        gradient.addColorStop(0, 'rgba(0,0,0,0)');
        gradient.addColorStop(0.8, 'rgba(0,0,0,0.9)');
        ctx.fillStyle = gradient;
        ctx.fillRect(offset, 0, 400, 400);

        // Text
        ctx.textAlign = 'center';
        ctx.fillStyle = '#ffffff';
        
        // Title (Truncate)
        // Title (Word Wrap)
        let title = manga.title || "Unknown";
        ctx.font = 'bold 24px sans-serif';
        const maxWidth = 360;
        const lineHeight = 28;
        const words = title.split(' ');
        let lines = [];
        let currentLine = words[0];

        for (let i = 1; i < words.length; i++) {
            const width = ctx.measureText(currentLine + " " + words[i]).width;
            if (width < maxWidth) {
                currentLine += " " + words[i];
            } else {
                lines.push(currentLine);
                currentLine = words[i];
            }
        }
        lines.push(currentLine);

        // Adjust Y position if multi-line
        // Base Y is 320. If 2 lines, start at 306. If 3 lines, start at 292.
        const startY = 320 - ((lines.length - 1) * (lineHeight / 2));

        lines.forEach((line, index) => {
            ctx.fillText(line, offset + 200, startY + (index * lineHeight));
        });

        // Score
        ctx.font = 'bold 50px sans-serif';
        if (showScore) {
             ctx.fillStyle = '#00ff00';
             if (offset > 0) { // Right side logic for color
                  // If right side (offset 400), color depends on comparison? 
                  // For now, let's just make it Green if revealed.
                  // Or we can pass comparison result to function. 
                  // Simpler: Just Green.
             }
             ctx.fillText(manga.score, offset + 200, 370);
        } else {
             ctx.fillStyle = '#ffcc00';
             ctx.fillText('?', offset + 200, 370);
        }
    };

    await drawItem(mangaA, 0, true); // Left: Always show score
    await drawItem(mangaB, 400, revealB); // Right: Show score if revealB is true

    // 3. VS Circle
    ctx.beginPath();
    ctx.arc(400, 200, 40, 0, Math.PI * 2);
    ctx.fillStyle = '#ffcc00';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.stroke();
    
    ctx.font = 'bold 30px sans-serif';
    ctx.fillStyle = '#000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('VS', 400, 200);

    return canvas.toBuffer();
}

/**
 * Main Handler
 */
async function handle(message, client) {


    if (!mangaCache.isReady()) {
        return message.reply("G-Give me a minute! I'm still reading the manga list... (Cache initializing) >///<");
    }

    const userId = message.author.id;
    let streak = 0;
    let gameActive = true;
    let skipsUsed = 0;
    let speedBonus = 0;
    let clutches = 0;
    let lastEditTime = Date.now();

    // --- PRE-CALCULATE WEALTH ---
    const userDoc = await User.findOne({ userId }) || new User({ userId });
    const userWealth = Math.max(0, userDoc.coins || 0); 
    const logWealth = userWealth > 0 ? Math.log10(userWealth) : 0;
    const wealthMult = 1 + (logWealth / 1.8);

    // --- SNAPSHOT AMULETS (display only — actual consumption is atomic at game end) ---
    const amuletSnapshot = userDoc.equippedAmuletCount || 0;
    const amuletPreviewMult = amuletSnapshot > 0 ? (1 + Math.sqrt(amuletSnapshot) * config.HL_AMULET_RATE) : 1.0;

    const getCurrentPot = (currentStreak) => {
        if (currentStreak === 0) return 0;
        const tier = config.HIGHER_LOWER.POT_MULTIPLIERS.find(t => currentStreak >= t.minStreak) 
            || config.HIGHER_LOWER.POT_MULTIPLIERS[config.HIGHER_LOWER.POT_MULTIPLIERS.length - 1];
        return Math.floor(tier.mult * currentStreak * wealthMult);
    };

    // --- INITIAL PAIR ---
    let [mangaA, mangaB] = mangaCache.getMangaPair();
    if (!mangaA || !mangaB) {
        return message.reply("Something went wrong fetching manga... B-Baka dev! (API Error)");
    }

    // --- UI HELPERS ---
    const getEmbed = (currentStreak) => {
         const comboText = speedBonus > 0 ? `  |  ⚡ Speed: **+${speedBonus}%**` : '';
         const clutchText = clutches > 0 ? `  |  🎯 Clutches: **${clutches}**` : '';
         const amuletText = amuletSnapshot > 0 ? `  |  🪙 **${amuletSnapshot}x** Amulets (${amuletPreviewMult.toFixed(2)}x)` : '';
         
         return new EmbedBuilder()
            .setColor(0x2b2d31)
            .setTitle(`📖  Manga Higher or Lower`)
            .setDescription(`Streak: **${currentStreak}**${comboText}${clutchText}${amuletText}\n\nThe manga **"${mangaB.title}"** has a...\n**HIGHER** 🔼 or **LOWER** 🔽 score than **${mangaA.score}**?`)
            .setImage('attachment://vs.png')
            .setFooter({ text: "Data provided by Jikan (MyAnimeList)" });
    };

    const getComponents = (disabled = false, currentStreak = 0) => {
        let skipLabel = 'Skip ⏭️ (Free)';
        if (skipsUsed > 0) {
            const skipCost = Math.floor(getCurrentPot(currentStreak) * config.HIGHER_LOWER.SKIP_COST_PERCENT);
            skipLabel = `Skip ⏭️ (-${skipCost})`;
        }
        return [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('higher').setLabel('Higher ▲').setStyle(ButtonStyle.Success).setDisabled(disabled),
                new ButtonBuilder().setCustomId('lower').setLabel('Lower ▼').setStyle(ButtonStyle.Danger).setDisabled(disabled),
                new ButtonBuilder().setCustomId('skip').setLabel(skipLabel).setStyle(ButtonStyle.Primary).setDisabled(disabled),
                new ButtonBuilder().setCustomId('quit').setLabel('Quit').setStyle(ButtonStyle.Secondary).setDisabled(disabled)
            )
        ];
    };

    // --- SEND INITIAL MESSAGE ---
    let attachment = new AttachmentBuilder(await createGameCanvas(mangaA, mangaB, false), { name: 'vs.png' });
    const gameMsg = await message.channel.send({
        embeds: [getEmbed(0)],
        components: getComponents(),
        files: [attachment]
    });
    lastEditTime = Date.now();

    // --- COLLECTOR ---
    const collector = gameMsg.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: config.HIGHER_LOWER.TIMERS.find(t => t.minStreak === 0).timeMs
    });

    let processing = false; // concurrency lock

    collector.on('collect', async (i) => {
        // 1. Verify User
        if (i.user.id !== userId) {
            return i.reply({ content: "This isn't your game, idiot! Start your own! (¬_¬)", ephemeral: true });
        }

        // 2. Concurrency Lock & Active Check
        if (processing || !gameActive) {
            // Check if interaction needs response to prevent "Interaction Failed"
            if (!i.replied && !i.deferred) await i.deferUpdate();
            return;
        }
        processing = true;
        
        const choice = i.customId;

        // --- SPEED TRACKING (measured from last message render, not last click) ---
        const actionTime = Date.now();
        const timeTaken = actionTime - lastEditTime;
        // Tiered speed: Lightning <3s (+4%), Quick 3-5s (+2%), Steady 5-8s (+1%), Slow >8s (reset)
        let speedTier = 0; // 0 = slow (resets combo)
        for (const tier of config.HIGHER_LOWER.SPEED_TIERS) {
            if (timeTaken <= tier.maxTimeMs) {
                speedTier = tier.bonus;
                break;
            }
        }

        // --- QUIT ---
        if (choice === 'quit') {
            gameActive = false;
            collector.stop('quit');
            if (!i.replied && !i.deferred) await i.deferUpdate();
            return;
        }

        // --- SKIP CHECK ---
        let skipCost = 0;
        if (choice === 'skip') {
            skipCost = skipsUsed === 0 ? 0 : Math.floor(getCurrentPot(streak) * config.HIGHER_LOWER.SKIP_COST_PERCENT);
            if (skipCost > 0) {
                const freshUser = await User.findOne({ userId });
                if (!freshUser || freshUser.coins < skipCost) {
                    processing = false;
                    return i.reply({ content: `You need **${skipCost} coins** in your wallet to skip! (¬_¬)`, ephemeral: true });
                }
            }
        }

        // --- DEFER UPDATE IMMEDIATELY ---
        // This prevents the "Interaction Failed" error if canvas generation takes >3s
        try {
            await i.deferUpdate();
        } catch (e) {
            // Interaction might have been acknowledged already or expired, stop here
            processing = false;
            return;
        }

        // --- SKIP DEDUCTION & REROLL ---
        if (choice === 'skip') {
            if (speedTier === 0) speedBonus = 0; // Waiting too long to skip breaks the combo
            
            if (skipCost > 0) {
                const result = await User.findOneAndUpdate(
                    { userId: userId, coins: { $gte: skipCost } },
                    { $inc: { coins: -skipCost, systemSpent: skipCost } },
                    { new: true }
                );
                if (!result) {
                    processing = false;
                    return i.followUp({ content: `You don't have enough coins anymore! (¬_¬)`, ephemeral: true });
                }
            }
            skipsUsed++;
            
            // Reroll MangaB
            const pair = mangaCache.getMangaPair(mangaA); 
            mangaB = pair[1];

            const newBuffer = await createGameCanvas(mangaA, mangaB, false);
            attachment = new AttachmentBuilder(newBuffer, { name: 'vs.png' });

            await gameMsg.edit({
                embeds: [getEmbed(streak)],
                components: getComponents(false, streak),
                files: [attachment]
            }).catch(() => {});
            lastEditTime = Date.now();

            processing = false; 
            const timerTier = config.HIGHER_LOWER.TIMERS.find(t => streak >= t.minStreak) || config.HIGHER_LOWER.TIMERS[config.HIGHER_LOWER.TIMERS.length - 1];
            let newTime = timerTier.timeMs;
            collector.resetTimer({ time: newTime });
            return;
        }

        // --- LOGIC ---
        let isCorrect = false;
        // Equal scores count as correct to be nice? Or handled strictly?
        // User asked for "Higher or Lower". Strict interpretation usually means >= or <=.
        if (choice === 'higher' && mangaB.score >= mangaA.score) isCorrect = true;
        if (choice === 'lower' && mangaB.score <= mangaA.score) isCorrect = true;

        if (isCorrect) {
            streak++;
            if (speedTier > 0) speedBonus += speedTier;
            else speedBonus = 0;

            // Clutch Detection (Score difference <= 0.05)
            if (Math.abs(mangaA.score - mangaB.score) <= 0.05) {
                clutches++;
            }

            // Prepare Next Round
            mangaA = mangaB; // Winner stays
            const pair = mangaCache.getMangaPair(mangaA); 
            mangaB = pair[1];

            // Re-render
            const newBuffer = await createGameCanvas(mangaA, mangaB, false);
            attachment = new AttachmentBuilder(newBuffer, { name: 'vs.png' });

            await gameMsg.edit({
                embeds: [getEmbed(streak)],
                components: getComponents(false, streak),
                files: [attachment]
            }).catch(() => {});
            lastEditTime = Date.now();

            processing = false; // Unlock
            
            // Dynamic Timer
            const timerTier = config.HIGHER_LOWER.TIMERS.find(t => streak >= t.minStreak) || config.HIGHER_LOWER.TIMERS[config.HIGHER_LOWER.TIMERS.length - 1];
            let newTime = timerTier.timeMs;
            
            collector.resetTimer({ time: newTime }); // Reset idle timer

        } else {
            // WRONG
            gameActive = false;
            collector.stop('wrong');
        }
    });

    collector.on('end', async (collected, reason) => {
        gameActive = false; // Ensure dead
        
        // --- GAME OVER SCREEN ---
        // Generate Reveal Image
        const revealBuffer = await createGameCanvas(mangaA, mangaB, true);
        const revealAttachment = new AttachmentBuilder(revealBuffer, { name: 'vs-reveal.png' });
        
        let endTitle = "💥 WRONG!";
        let endDesc = `**${mangaB.title}** had a score of **${mangaB.score}**!`;
        
        if (reason === 'time') {
            endTitle = "⏰ TIMEOUT!";
            endDesc = "You fell asleep, baka!";
        } else if (reason === 'quit') {
            endTitle = "🛑 QUIT!";
            endDesc = "You gave up.";
        } else {
             endDesc += `\n(You guessed: ${(collected.last()?.customId || "unknown").toUpperCase()})`;
        }

        // --- AMULET CONSUMPTION (atomic, always — regardless of streak) ---
        let consumedAmulets = 0;
        let hlAmuletMult = 1.0;
        if (amuletSnapshot > 0) {
            const preConsume = await User.findOneAndUpdate(
                { userId, equippedAmuletCount: { $gt: 0 } },
                { $set: { equippedAmuletCount: 0 } },
                { new: false }
            );
            consumedAmulets = preConsume?.equippedAmuletCount || 0;
            if (consumedAmulets > 0) {
                hlAmuletMult = 1 + Math.sqrt(consumedAmulets) * config.HL_AMULET_RATE;
            }
        }

        const endEmbed = new EmbedBuilder()
            .setColor(0xff0000)
            .setTitle(endTitle)
            .setDescription(`${endDesc}\n\nFinal Streak: **${streak}**${consumedAmulets > 0 ? `\n🪙 **${consumedAmulets}x Amulets consumed!**` : ''}`)
            .setImage('attachment://vs-reveal.png');

        // --- REWARDS & HIGHSCORE ---
        if (streak > 0) {
            try {
                const user = await User.findOne({ userId: userId }) || new User({ userId });
                
                // 1. UPDATE HIGHSCORE
                if (streak > (user.highScore || 0)) {
                    await User.findOneAndUpdate(
                        { userId: userId },
                        { $max: { highScore: streak } },
                        { new: true, upsert: true }
                    );
                    endEmbed.setFooter({ text: `🎉 NEW PERSONAL BEST: ${streak}!` });
                }

                // 2. CALCULATE REWARD
                const basePot = getCurrentPot(streak);
                
                // Risk System (Quit vs Lose)
                const riskMultiplier = (reason === 'quit') ? 1.0 : 0.25;
                
                // Speed Bonus (accumulated from tiered speed system)
                const speedMultiplier = 1 + (speedBonus * 0.01);

                // Clutch Bonus (10% per clutch)
                const clutchMultiplier = 1 + (clutches * 0.10);
                
                // Amulet Multiplier (applied last, after all other bonuses)
                const totalReward = Math.floor(basePot * riskMultiplier * speedMultiplier * clutchMultiplier * hlAmuletMult);

                // 3. DISTRIBUTE
                
                const log = await distributeIncome(userId, totalReward);

                // TsunStocks: bump stock price on HL win
                stockEngine.onMinigameWin(userId).catch(() => {});

                // --- SEND GAME OVER SCREEN (After Footer Applied) ---
                await gameMsg.edit({
                    embeds: [endEmbed],
                    components: getComponents(true, streak),
                    files: [revealAttachment]
                }).catch(() => {});

                // Tsundere Commentary
                let comment = "";
                if (streak < 3) comment = "Only that much? Pathetic. (¬_¬)";
                else if (streak < 10) comment = "Not bad... for you. I suppose. <(￣ ﹌ ￣)>";
                else comment = "W-Wow... you're actually kinda amazing at this... I-I mean, don't get cocky! >///<";

                // Create Clean Result Embed
                const resultTier = config.HIGHER_LOWER.RESULT_BASE_MULTIPLIERS.find(t => streak >= t.minStreak) 
                    || config.HIGHER_LOWER.RESULT_BASE_MULTIPLIERS[config.HIGHER_LOWER.RESULT_BASE_MULTIPLIERS.length - 1];
                let baseMultiplier = resultTier.mult;

                const isSecured = reason === 'quit';
                const riskText = isSecured ? "✅ You quit early and secured 100% of the bag!" : "💀 You got greedy and lost 75% of your payout!";
                
                const resultEmbed = new EmbedBuilder()
                    .setColor(isSecured ? 0xFFD700 : 0xFF4500)
                    .setAuthor({ name: `Results: ${message.author.username}`, iconURL: message.author.displayAvatarURL() })
                    .setDescription(`*${comment}*\n\n**${riskText}**`)
                    .addFields(
                        { name: 'Streak', value: `${streak} (Base ${baseMultiplier})`, inline: true },
                        { name: 'Bag Mult', value: `x${wealthMult.toFixed(2)}`, inline: true },
                        { name: 'Speed Bonus', value: `+${speedBonus}%`, inline: true }
                    );

                if (clutches > 0) {
                    resultEmbed.addFields({ name: 'Clutch Bonus', value: `+${clutches * 10}%`, inline: true });
                }

                if (consumedAmulets > 0) {
                    resultEmbed.addFields({ name: '🪙 Amulet Boost', value: `${consumedAmulets}x → ${hlAmuletMult.toFixed(2)}x`, inline: true });
                }

                resultEmbed.addFields({ name: 'Total Payout', value: `**${totalReward.toLocaleString('en-US')}** coins`, inline: false })
                    .setFooter({ text: consumedAmulets > 0 ? `${consumedAmulets} amulets consumed. Funds deposited to wallet.` : "Funds deposited to wallet." });

                // If tax/slavery applied, show in footer or sub-description
                if (log) {
                     resultEmbed.addFields({ name: 'Deductions', value: log.replace(/\n/g, ' '), inline: false });
                }

                const freshUserBalance = await User.findOne({ userId });
                if (freshUserBalance) {
                    resultEmbed.addFields({ name: '💳 Balance', value: `**${freshUserBalance.coins.toLocaleString('en-US')}** — n-not that I'm keeping track! (¬_¬)`, inline: false });
                }

                const playAgainRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`hl_playagain_${message.author.id}`)
                        .setLabel('Play Again')
                        .setStyle(ButtonStyle.Primary)
                );

                await message.channel.send({ embeds: [resultEmbed], components: [playAgainRow] });

            } catch (err) {
                console.error("Reward distribution error:", err);
                message.channel.send("Tsk. I tried to give you money but something broke. Blame the dev.");
            }
        } else {
            // Send Game Over Edit
            await gameMsg.edit({
                embeds: [endEmbed],
                components: getComponents(true, streak),
                files: [revealAttachment]
            }).catch(() => {});

            // 0 Streak
            if (reason !== 'time') {
                 const amuletLossText = consumedAmulets > 0
                     ? `\n🪙 **${consumedAmulets}x Amulets burned for NOTHING!** Pathetic! >///<`
                     : '';
                 const playAgainRow = new ActionRowBuilder().addComponents(
                     new ButtonBuilder()
                         .setCustomId(`hl_playagain_${message.author.id}`)
                         .setLabel('Play Again')
                         .setStyle(ButtonStyle.Primary)
                 );
                 await message.channel.send({ content: `**0 Streak.** You get nothing! Good day sir! (¬_¬)${amuletLossText}`, components: [playAgainRow] });
            }
        }
    });
}

const activePlayAgains = new Set();

/**
 * Interaction Handler for Play Again
 */
async function handleInteraction(interaction, client) {
    if (!interaction.isButton()) return;
    
    if (interaction.customId.startsWith('hl_playagain_')) {
        const parts = interaction.customId.split('_');
        if (parts.length !== 3) return;
        const targetId = parts[2];

        if (interaction.user.id !== targetId) {
            return interaction.reply({ content: "This isn't your game, baka! Use `!hl` yourself! (¬_¬)", ephemeral: true });
        }

        // Concurrency lock to prevent double-click exploits
        const msgId = interaction.message.id;
        if (activePlayAgains.has(msgId)) return;
        activePlayAgains.add(msgId);
        
        // Plug memory leak: delete from set after 10 seconds (button is already disabled anyway)
        setTimeout(() => activePlayAgains.delete(msgId), 10000);

        await interaction.deferUpdate();

        // Disable button
        const message = interaction.message;
        const components = message.components;
        if (components.length > 0) {
            const row = components[0];
            const newRow = new ActionRowBuilder();
            row.components.forEach(c => {
                newRow.addComponents(ButtonBuilder.from(c).setDisabled(true));
            });
            await message.edit({ components: [newRow] }).catch(() => {});
        }

        // Create mock message and route back to handle()
        const mockMessage = {
            author: interaction.user,
            channel: interaction.channel,
            guild: interaction.guild,
            reply: (content) => interaction.channel.send(content)
        };
        
        return handle(mockMessage, client);
    }
}

module.exports = {
    handle,
    handleInteraction
};
