const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');
const Election = require('../models/Election');
const config = require('../config');

// ==================== CONSTANTS ====================
const CONFIG = {
    MOD_ROLE: config.ROLES.MOD,
    OWNER_ID: config.OWNER_ID,
    PURGE_MINS: config.ELECTION.PURGE_MINS,
    APPLY_MINS: config.ELECTION.APPLY_MINS,
    VOTE_MINS: config.ELECTION.VOTE_MINS,
    MIN_VOTES: config.ELECTION.MIN_VOTES || 1,
    MAX_CANDIDATES: config.ELECTION.MAX_CANDIDATES || 50,
    SPEECH_MAX_LENGTH: config.ELECTION.SPEECH_MAX_LENGTH || 200
};

const NUMBER_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

// ==================== HELPERS ====================
const errorEmbed = (msg) => new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle("❌ Error!")
    .setDescription(msg)
    .setFooter({ text: "Baka!" });

const successEmbed = (title, msg) => new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle(`✅ ${title}`)
    .setDescription(msg);

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Retry-safe poll ender — handles rate limits and already-ended polls
async function endPollSafely(poll, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await poll.end();
            return true;
        } catch (e) {
            if (e.message && e.message.includes('rate limited')) {
                const match = e.message.match(/Retry after ([\d.]+)/);
                const waitTime = match ? Math.ceil(parseFloat(match[1]) * 1000) : 5000;
                console.log(`Poll end rate limited. Waiting ${waitTime}ms before retry ${attempt}/${maxRetries}`);
                if (attempt < maxRetries) {
                    await wait(waitTime + 500);
                } else {
                    console.log("Max retries reached, continuing anyway");
                    return false;
                }
            } else if (e.message && e.message.includes('already expired')) {
                console.log("Poll already ended");
                return true;
            } else {
                console.log("Poll end error:", e.message);
                return false;
            }
        }
    }
    return false;
}

// Build speech display for poll embed (Format 1)
function buildSpeechDescription(candidates, endTimeSecs) {
    const useSpacious = candidates.length <= 5;

    let desc;
    if (useSpacious) {
        // Spacious blockquote format for ≤5 candidates
        desc = candidates.map((c, i) =>
            `━━━━━━━━━━━━━━━━━━━━━\n${NUMBER_EMOJIS[i]} **${c.displayName}**\n> ${c.speech || 'No speech'}`
        ).join('\n') + '\n━━━━━━━━━━━━━━━━━━━━━';
    } else {
        // Compact format for 6–10 candidates
        desc = candidates.map((c, i) =>
            `${NUMBER_EMOJIS[i]} **${c.displayName}** — "${c.speech || 'No speech'}"`
        ).join('\n\n');
    }

    desc += `\n\n⚠️ *Poll closes <t:${endTimeSecs}:R>!*\n*H-Hurry up and pick someone already!* (¬_¬)`;
    return desc;
}

// Safely fetch a message, returning null if missing
async function safeFetch(channel, messageId) {
    if (!messageId) return null;
    return channel.messages.fetch(messageId).catch(() => null);
}

// Safely delete a message, ignoring errors
async function safeDelete(channel, messageId) {
    if (!messageId) return;
    const msg = await safeFetch(channel, messageId);
    if (msg) await msg.delete().catch(() => {});
}

// Edit the anchor message; if it was deleted, re-send it
async function editAnchor(channel, election, embed) {
    const anchor = await safeFetch(channel, election.anchorMessageId);
    if (anchor) {
        await anchor.edit({ embeds: [embed] }).catch(() => {});
    } else {
        // Anchor was deleted — re-send and update DB
        const newAnchor = await channel.send({ embeds: [embed] });
        election.anchorMessageId = newAnchor.id;
        await Election.updateOne(
            { guildId: channel.guild.id },
            { $set: { anchorMessageId: newAnchor.id } }
        );
    }
}

// Extract winner from poll results for a bracket's candidate list.
// Uses the "N. Name" prefix in answer text, with fallback to position index.
function extractWinner(result, candidates) {
    const indexMatch = result.text?.match(/^(\d+)\./);
    if (indexMatch) {
        const idx = parseInt(indexMatch[1]) - 1;
        if (candidates[idx]) return candidates[idx];
    }
    // Fallback: use the answer's sorted position — find by display name substring
    const matchByName = candidates.find(c => result.text?.includes(c.displayName));
    if (matchByName) return matchByName;
    // Last resort: return first candidate
    return candidates[0] || null;
}

// Format vote results into a compact string
function formatVoteResults(results) {
    return results
        .filter(r => r.voteCount > 0)
        .map(r => `${r.text}: **${r.voteCount}**`)
        .join(' | ');
}

// ==================== EXPORTS ====================
module.exports = {
    // ==================== COMMAND HANDLER ====================
    handle: async (message, client) => {
        const cmd = message.content.toLowerCase().split(/\s+/)[0];

        if (message.author.id !== CONFIG.OWNER_ID) {
            return message.reply({ embeds: [errorEmbed("H-Hah? Only the owner can control elections! Know your place, you worthless trash! (¬_¬)")] });
        }

        if (!message.guild || !message.channel.isTextBased()) {
            return message.reply({ embeds: [errorEmbed("Elections can only be run in a server text channel, you dolt!")] });
        }

        let election = await Election.findOne({ guildId: message.guild.id }) || new Election({ guildId: message.guild.id });

        // --- !STARTELECTION ---
        if (cmd === '!startelection') {
            if (election.active) return message.reply({ embeds: [errorEmbed("An election is already running, you impatient idiot! >////<")] });
            await startPurge(message.channel, election);
        }

        // --- !CANCELELECTION or !ENDELECTION ---
        else if (cmd === '!cancelelection' || cmd === '!endelection') {
            if (!election.active) return message.reply({ embeds: [errorEmbed("There's nothing to cancel! Are you hallucinating? (¬_¬)")] });
            // Force-clear processing lock in case it's stuck
            if (election.processing) {
                await Election.updateOne({ guildId: message.guild.id }, { $set: { processing: false } });
            }
            // Use the election's stored channel for cleanup
            const elChannel = await client.channels.fetch(election.channelId).catch(() => null) || message.channel;
            await cancel(elChannel, election, "Cancelled by the owner. H-How boring! (¬_¬)");
            if (elChannel.id !== message.channel.id) {
                await message.reply({ embeds: [successEmbed("Done", "Election cancelled! Check the election channel. (¬_¬)")] });
            }
        }

        // --- !ELECTIONSTATUS ---
        else if (cmd === '!electionstatus') {
            if (!election.active) return message.reply({ embeds: [errorEmbed("No election running. It's peaceful... for now. (¬_¬)")] });
            const stepNames = ["Idle", "The Purge", "Applications", "Final Vote"];

            let statusDesc = `**Current Phase:** ${stepNames[election.step] || 'Unknown'}\n**Candidates:** ${election.candidates.length}`;
            if (election.endTime > 0) {
                statusDesc += `\n**Ends:** <t:${Math.floor(election.endTime / 1000)}:R>`;
            }

            if (election.step === 3 && election.tournamentRound > 0) {
                statusDesc += `\n**Tournament Round:** ${election.tournamentRound}`;
                if (election.tournamentBrackets && election.tournamentBrackets.length > 0) {
                    statusDesc += `\n**Brackets this round:** ${election.tournamentBrackets.length}`;
                }
            }

            const embed = new EmbedBuilder()
                .setColor(0xFF69B4)
                .setTitle("🗳️ Election Status")
                .setDescription(statusDesc)
                .setFooter({ text: "D-Don't mess this up, bakas!" })
                .setThumbnail(message.guild.iconURL());

            return message.reply({ embeds: [embed] });
        }

        // --- !ELECTIONCANDIDATES ---
        else if (cmd === '!electioncandidates') {
            if (election.candidates.length === 0) {
                return message.reply({ embeds: [errorEmbed("No candidates in the database! Pathetic! (¬_¬)")] });
            }

            const BATCH_SIZE = 10;
            for (let i = 0; i < election.candidates.length; i += BATCH_SIZE) {
                const batch = election.candidates.slice(i, i + BATCH_SIZE);
                const embed = new EmbedBuilder()
                    .setTitle(`📋 All Candidates (${i + 1}-${Math.min(i + BATCH_SIZE, election.candidates.length)} of ${election.candidates.length})`)
                    .setColor("Blue");

                batch.forEach((c, j) => {
                    embed.addFields({
                        name: `${i + j + 1}. ${c.displayName} (ID: ${c.userId})`,
                        value: `"${c.speech?.substring(0, 200) || 'No speech'}"`
                    });
                });

                await message.channel.send({ embeds: [embed] });
            }
            return;
        }

        // --- DEBUG: FORCE NEXT STEP ---
        else if (cmd === '!endpoll' || cmd === '!endapplications') {
            if (!election.active) return message.reply({ embeds: [errorEmbed("No election active! Are you seeing things? (¬_¬)")] });

            const lockedElection = await Election.findOneAndUpdate(
                {
                    guildId: message.guild.id,
                    active: true,
                    processing: { $ne: true }
                },
                { $set: { processing: true } },
                { new: true }
            );

            if (!lockedElection) {
                return message.reply({ embeds: [errorEmbed("Already processing a step! Wait for it to finish, impatient fool! >////<")] });
            }

            // FIX: Use the election's stored channel, NOT message.channel
            const elChannel = await client.channels.fetch(lockedElection.channelId).catch(() => null);
            if (!elChannel) {
                await Election.updateOne({ guildId: lockedElection.guildId }, { $set: { processing: false } });
                return message.reply({ embeds: [errorEmbed("Can't find the election channel! Was it deleted?! (¬_¬)")] });
            }

            await message.reply({ embeds: [new EmbedBuilder().setColor(0xFEE75C).setDescription("⏩ **Skipping time!** R-Rushing the process... don't blame me if it breaks! (>////<)")] });

            try {
                if (lockedElection.step === 1) await checkPurge(elChannel, lockedElection);
                else if (lockedElection.step === 2) await checkApplications(elChannel, lockedElection);
                else if (lockedElection.step === 3) await checkAllBrackets(elChannel, lockedElection);
            } catch (err) {
                console.error("Error during forced step advance:", err);
                await Election.updateOne({ guildId: lockedElection.guildId }, { $set: { processing: false } });
                return message.channel.send({ embeds: [errorEmbed(`S-Something broke and it's NOT my fault! >///< ${err.message}`)] });
            }
        }
    },

    // ==================== INTERACTION HANDLER ====================
    handleInteraction: async (interaction, client) => {
        if (!interaction.guild) return;
        const election = await Election.findOne({ guildId: interaction.guild.id });
        if (!election || !election.active) return;

        // --- APPLY BUTTON ---
        if (interaction.isButton() && interaction.customId === 'apply_mod') {
            if (election.step !== 2) return interaction.reply({ embeds: [errorEmbed("Applications are closed, slowpoke! >////<")], ephemeral: true });

            if (election.candidates.some(c => c.userId === interaction.user.id)) {
                return interaction.reply({ embeds: [errorEmbed("You already applied! Desperate much? (¬_¬)")], ephemeral: true });
            }

            const modal = new ModalBuilder().setCustomId('mod_speech_modal').setTitle('Beg for Power');
            const input = new TextInputBuilder()
                .setCustomId('speech')
                .setLabel('Why should we pick you? (200 chars max)')
                .setStyle(TextInputStyle.Paragraph)
                .setMaxLength(CONFIG.SPEECH_MAX_LENGTH)
                .setPlaceholder('I promise not to be a tyrant...');
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            await interaction.showModal(modal);
        }

        // --- MODAL SUBMIT ---
        if (interaction.isModalSubmit() && interaction.customId === 'mod_speech_modal') {
            const speech = interaction.fields.getTextInputValue('speech');

            // Enforce speech length cap (backup check — modal already has maxLength)
            if (speech.length > CONFIG.SPEECH_MAX_LENGTH) {
                return interaction.reply({
                    embeds: [errorEmbed(`Your speech is **${speech.length}** characters?! Keep it under **${CONFIG.SPEECH_MAX_LENGTH}**, you rambling idiot! T-Trim it down! (¬_¬)`)],
                    ephemeral: true
                });
            }

            // Enforce hard cap on candidate count
            const currentElection = await Election.findOne({ guildId: interaction.guild.id });
            if (currentElection && currentElection.candidates.length >= CONFIG.MAX_CANDIDATES) {
                return interaction.reply({ embeds: [errorEmbed("Applications are full! Too many candidates already! (¬_¬)")], ephemeral: true });
            }

            // Atomic push — prevents race conditions and duplicate entries
            const result = await Election.findOneAndUpdate(
                {
                    guildId: interaction.guild.id,
                    step: 2,
                    "candidates.userId": { $ne: interaction.user.id }
                },
                {
                    $push: {
                        candidates: {
                            userId: interaction.user.id,
                            displayName: interaction.member.displayName,
                            speech: speech
                        }
                    }
                }
            );

            if (!result) {
                const check = await Election.findOne({ guildId: interaction.guild.id });
                if (!check || check.step !== 2) {
                    return interaction.reply({ embeds: [errorEmbed("Too late! Applications have closed! (¬_¬)")], ephemeral: true });
                }
                return interaction.reply({ embeds: [errorEmbed("You already applied! Stop spamming, baka! (¬_¬)")], ephemeral: true });
            }

            await interaction.reply({ embeds: [successEmbed("Application Received", "D-Don't get your hopes up! I just accepted the form, that's all! (¬_¬)")], ephemeral: true });
        }
    },

    // ==================== TIMER CHECKER ====================
    checkTimers: async (client) => {
        const now = Date.now();
        const stepsToCheck = [1, 2, 3];

        for (const stepNum of stepsToCheck) {
            const el = await Election.findOneAndUpdate(
                {
                    active: true,
                    step: stepNum,
                    endTime: { $gt: 0, $lt: now },
                    processing: { $ne: true }
                },
                { $set: { processing: true } },
                { new: true }
            );

            if (!el) continue;

            try {
                const channel = await client.channels.fetch(el.channelId);
                if (!channel) {
                    await Election.updateOne({ guildId: el.guildId }, { $set: { processing: false } });
                    continue;
                }

                if (el.step === 1) await checkPurge(channel, el);
                else if (el.step === 2) await checkApplications(channel, el);
                else if (el.step === 3) await checkAllBrackets(channel, el);

            } catch (e) {
                console.error(`Election Timer Error (Guild: ${el.guildId}):`, e);
                await Election.updateOne({ guildId: el.guildId }, { $set: { processing: false } });
            }
        }
    }
};

// ==================== PHASE 1: THE PURGE ====================

async function startPurge(channel, election) {
    const guild = channel.guild;
    const modRole = guild.roles.cache.find(r => r.name === CONFIG.MOD_ROLE);
    if (!modRole) return channel.send({ embeds: [errorEmbed(`Role '${CONFIG.MOD_ROLE}' not found! Fix your config, baka!`)] });

    await guild.members.fetch();
    const mods = guild.members.cache.filter(m =>
        m.roles.cache.has(modRole.id) &&
        !m.user.bot &&
        m.id !== CONFIG.OWNER_ID &&
        m.manageable
    );

    if (mods.size === 0) return channel.send({ embeds: [errorEmbed("No eligible mods to overthrow! Everyone's untouchable! (¬_¬)")] });

    const modArray = [...mods.values()].slice(0, 10);
    const endTime = Date.now() + (CONFIG.PURGE_MINS * 60000);
    const endTimeSecs = Math.floor(endTime / 1000);

    // Send the anchor message
    const anchorEmbed = new EmbedBuilder()
        .setColor(0xFF69B4)
        .setTitle("🗳️ ELECTION IN PROGRESS")
        .setDescription(
            `🔥 **Phase 1: The Purge**\n` +
            `The people will decide which mod gets the boot!\n` +
            `Vote in the poll below ⬇️\n\n` +
            `⏳ Voting closes <t:${endTimeSecs}:R>\n\n` +
            `*Choose violence or choose peace... I-I don't care either way!* (¬_¬)`
        )
        .setFooter({ text: "D-Don't mess this up, bakas!" });

    const anchorMsg = await channel.send({ embeds: [anchorEmbed] });

    // Build mod candidates for DB
    const modCandidates = modArray.map((m, i) => ({
        index: i + 1,
        userId: m.id,
        displayName: m.displayName
    }));

    // Warn if more than 10 mods
    if (mods.size > 10) {
        await channel.send({
            embeds: [new EmbedBuilder().setColor(0xFEE75C).setDescription(`⚠️ There are **${mods.size}** mods but only the first 10 are shown! D-Deal with it! (¬_¬)`)]
        });
    }

    // Build the purge poll embed
    const pollEmbed = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle("👢 THE PURGE")
        .setDescription(
            modArray.map((m, i) => `${NUMBER_EMOJIS[i]} **${m.displayName}**`).join('\n') +
            `\n\n⚠️ *Poll closes <t:${endTimeSecs}:R>!*\n` +
            `*No hard feelings... actually, yes hard feelings.* (¬_¬)`
        );

    const pollOptions = modArray.map((m, i) => ({ text: `${i + 1}. ${m.displayName}`.slice(0, 55) }));

    const pollMsg = await channel.send({
        embeds: [pollEmbed],
        poll: {
            question: { text: "Who should be removed?" },
            answers: pollOptions,
            duration: 1, // Discord minimum = 1 hour, bot will end early
            allowMultiselect: false
        }
    });

    // Save to DB
    await Election.updateOne(
        { guildId: guild.id },
        {
            $set: {
                active: true,
                channelId: channel.id,
                step: 1,
                anchorMessageId: anchorMsg.id,
                messageId: pollMsg.id,
                endTime: endTime,
                processing: false,
                modCandidates: modCandidates,
                candidates: [],
                tournamentRound: 0,
                tournamentBrackets: [],
                purgeResultText: null
            }
        },
        { upsert: true }
    );
}

async function checkPurge(channel, election) {
    // Fetch and end the poll
    const msg = await safeFetch(channel, election.messageId);
    if (!msg) return await cancel(channel, election, "Poll message vanished! S-Someone deleted it?! Election cancelled! (¬_¬)");
    if (!msg.poll) return await cancel(channel, election, "Poll data is missing! Something broke and it's NOT my fault! >////<");

    await endPollSafely(msg.poll);
    await wait(2500); // Wait for Discord to finalize vote counts

    // Re-fetch for accurate results
    const freshMsg = await safeFetch(channel, election.messageId);
    if (!freshMsg || !freshMsg.poll) return await cancel(channel, election, "Poll disappeared after ending! W-What?! (>////<)");

    const results = [...freshMsg.poll.answers.values()].sort((a, b) => b.voteCount - a.voteCount);
    const winner = results[0];
    const totalVotes = results.reduce((sum, r) => sum + r.voteCount, 0);

    if (totalVotes < CONFIG.MIN_VOTES) {
        return await cancel(channel, election, `Not enough votes! Only **${totalVotes}** voted (need at least **${CONFIG.MIN_VOTES}**). P-Pathetic! You all are useless! (¬_¬)`);
    }

    if (!winner || winner.voteCount === 0) {
        return await cancel(channel, election, "No votes cast?! You guys are absolutely useless! Election cancelled! (¬_¬)");
    }

    // Handle ties with random tiebreaker (instead of cancelling)
    let chosenWinner = winner;
    const tiedCandidates = results.filter(r => r.voteCount === winner.voteCount);
    if (tiedCandidates.length > 1) {
        chosenWinner = tiedCandidates[Math.floor(Math.random() * tiedCandidates.length)];
    }

    // Delete the poll message
    await safeDelete(channel, election.messageId);

    // Find and remove the mod
    await channel.guild.members.fetch();
    let removedMember = null;

    if (election.modCandidates && election.modCandidates.length > 0) {
        const modCandidate = extractWinner(chosenWinner, election.modCandidates);
        if (modCandidate) {
            removedMember = channel.guild.members.cache.get(modCandidate.userId);
        }
    }

    const modRole = channel.guild.roles.cache.find(r => r.name === CONFIG.MOD_ROLE);

    // Build results text for anchor
    const resultsText = formatVoteResults(results);

    let purgeResultText;
    if (removedMember && modRole) {
        try {
            await removedMember.roles.remove(modRole);
            purgeResultText = `👢 **${removedMember.displayName}** has been DETHRONED!` +
                (tiedCandidates.length > 1 ? ` *(Tie broken by coin flip!)*` : '') +
                `\n📊 ${resultsText}`;
        } catch (roleError) {
            console.error("Failed to remove role:", roleError.message);
            purgeResultText = `⚠️ Couldn't remove the role! B-Blame the permissions, not me! (>////<)\n📊 ${resultsText}`;
        }
    } else {
        purgeResultText = `👢 **${chosenWinner.text}** was voted out!` +
            (tiedCandidates.length > 1 ? ` *(Tie broken by coin flip!)*` : '') +
            `\n📊 ${resultsText}` +
            (!removedMember ? `\n⚠️ Couldn't find them in the server. Lucky escape! (¬_¬)` : '') +
            (!modRole ? `\n⚠️ Mod role not found! Check your config! (¬_¬)` : '');
    }

    // Store purge result for final anchor summary
    await Election.updateOne(
        { guildId: channel.guild.id },
        { $set: { purgeResultText: purgeResultText } }
    );
    election.purgeResultText = purgeResultText;

    // Move to applications
    await startApplications(channel, election, purgeResultText);
}

// ==================== PHASE 2: APPLICATIONS ====================

async function startApplications(channel, election, purgeResultText) {
    const endTime = Date.now() + (CONFIG.APPLY_MINS * 60000);
    const endTimeSecs = Math.floor(endTime / 1000);

    // Update anchor with purge results + application info
    const anchorEmbed = new EmbedBuilder()
        .setColor(0xFF69B4)
        .setTitle("🗳️ ELECTION IN PROGRESS")
        .setDescription(
            `${purgeResultText}\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `📝 **Phase 2: Applications**\n` +
            `The throne is empty! Click the button below to beg for power!\n` +
            `Applications close <t:${endTimeSecs}:R>\n\n` +
            `*I bet none of you are even qualified...* (¬_¬)`
        )
        .setFooter({ text: "D-Don't mess this up, bakas!" });

    await editAnchor(channel, election, anchorEmbed);

    // Send apply button
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('apply_mod').setLabel('Apply for Mod').setStyle(ButtonStyle.Success).setEmoji('👑')
    );

    const applyMsg = await channel.send({
        embeds: [new EmbedBuilder()
            .setColor(0x5865F2)
            .setDescription(`👑 **Click below to submit your speech!**\n⚠️ Max **${CONFIG.SPEECH_MAX_LENGTH}** characters! Applications close <t:${endTimeSecs}:R>\n\n*Make it good, or I'll laugh at you.* (¬_¬)`)
        ],
        components: [row]
    });

    // Save to DB
    await Election.updateOne(
        { guildId: channel.guild.id },
        {
            $set: {
                step: 2,
                messageId: applyMsg.id,
                endTime: endTime,
                processing: false,
                candidates: []
            }
        }
    );
}

async function checkApplications(channel, election) {
    // Delete the apply button message
    await safeDelete(channel, election.messageId);

    // Re-fetch election for latest candidate list AND anchorMessageId
    const freshElection = await Election.findOne({ guildId: channel.guild.id });
    if (!freshElection) return;
    election.candidates = freshElection.candidates;
    election.anchorMessageId = freshElection.anchorMessageId;
    election.purgeResultText = freshElection.purgeResultText;

    const candidateCount = election.candidates.length;

    // 0 candidates — cancel
    if (candidateCount === 0) {
        return await cancel(channel, election, "Nobody applied?! N-Not a single person?! Election cancelled, you cowards! (¬_¬)");
    }

    // 1 candidate — auto-win
    if (candidateCount === 1) {
        const winner = election.candidates[0];
        let winnerName = winner.displayName;
        let winnerAvatar = null;
        let roleGranted = false;

        try {
            const member = await channel.guild.members.fetch(winner.userId);
            const modRole = channel.guild.roles.cache.find(r => r.name === CONFIG.MOD_ROLE);
            winnerName = member.displayName;
            winnerAvatar = member.user.displayAvatarURL();

            if (modRole) {
                await member.roles.add(modRole);
                roleGranted = true;
            }
        } catch (err) {
            console.error("Auto-win role grant failed:", err.message);
        }

        // ALWAYS announce the winner, regardless of role success
        const anchorEmbed = new EmbedBuilder()
            .setColor(0xFFD700)
            .setTitle("🎉 ELECTION COMPLETE")
            .setDescription(
                (election.purgeResultText ? `${election.purgeResultText}\n\n━━━━━━━━━━━━━━━━━━━━━\n` : '') +
                `Only **one** person applied?! H-How pathetic!\n\n` +
                `👑 **${winnerName}** wins by default!\n` +
                `📜 Speech: "${winner.speech || 'No speech'}"\n` +
                (roleGranted ? `✅ Mod role granted!` : `⚠️ Could not grant mod role! Check permissions!`) +
                `\n\n*L-Lazy democracy! They didn't even have to compete!* (¬_¬)`
            )
            .setFooter({ text: "I-It's not like I'm happy for them... baka! (>////<)" });

        if (winnerAvatar) anchorEmbed.setThumbnail(winnerAvatar);
        await editAnchor(channel, election, anchorEmbed);

        await resetElection(channel.guild.id);
        return;
    }

    // 2+ candidates — start voting
    // Index candidates (extract plain objects from Mongoose subdocs)
    election.candidates = election.candidates.map((c, i) => ({
        userId: c.userId,
        displayName: c.displayName,
        speech: c.speech,
        index: i + 1
    }));

    // Update candidates with indexes
    await Election.updateOne(
        { guildId: channel.guild.id },
        { $set: { candidates: election.candidates } }
    );

    await startVote(channel, election);
}

// ==================== PHASE 3: FINAL VOTE / TOURNAMENT ====================

async function startVote(channel, election) {
    election.step = 3;
    election.tournamentRound = 1;

    const candidateCount = election.candidates.length;

    if (candidateCount <= 10) {
        // Single final poll — no tournament needed
        await sendFinalPoll(channel, election, election.candidates);
    } else {
        // Tournament — simultaneous brackets
        await startTournamentRound(channel, election);
    }
}

async function sendFinalPoll(channel, election, candidates, previousRoundSummary = '') {
    const endTime = Date.now() + (CONFIG.VOTE_MINS * 60000);
    const endTimeSecs = Math.floor(endTime / 1000);
    const isFinalRound = election.tournamentRound > 1;

    // Update anchor
    let anchorDesc = '';
    if (election.purgeResultText) {
        anchorDesc += `${election.purgeResultText}\n\n━━━━━━━━━━━━━━━━━━━━━\n`;
    }
    if (previousRoundSummary) {
        anchorDesc += `${previousRoundSummary}\n━━━━━━━━━━━━━━━━━━━━━\n`;
    }
    anchorDesc += `📜 **${candidates.length} candidate(s)** are competing!\n` +
        (isFinalRound ? `🏆 **FINAL ROUND** — Tournament Round ${election.tournamentRound}\n` : '') +
        `🗳️ **Phase 3: Final Vote** — Poll below ⬇️\n` +
        `⏳ Voting closes <t:${endTimeSecs}:R>\n\n` +
        `*T-This is getting exciting... n-not that I care!* (¬_¬)`;

    const anchorEmbed = new EmbedBuilder()
        .setColor(0xFF69B4)
        .setTitle("🗳️ ELECTION IN PROGRESS")
        .setDescription(anchorDesc)
        .setFooter({ text: "D-Don't mess this up, bakas!" });

    await editAnchor(channel, election, anchorEmbed);

    // Build speech embed + poll on same message
    const speechDesc = buildSpeechDescription(candidates, endTimeSecs);
    const speechEmbed = new EmbedBuilder()
        .setColor(0xFFD700)
        .setTitle(isFinalRound ? "👑 FINAL ROUND — Candidate Speeches" : "📜 CANDIDATE SPEECHES");

    // Safety check: truncate if description is too long
    if (speechDesc.length > 4096) {
        const compactDesc = candidates.map((c, i) =>
            `${NUMBER_EMOJIS[i]} **${c.displayName}**`
        ).join('\n') + `\n\n⚠️ *Poll closes <t:${endTimeSecs}:R>!*\n*Too many speeches to show! Just vote already!* (¬_¬)`;
        speechEmbed.setDescription(compactDesc);
    } else {
        speechEmbed.setDescription(speechDesc);
    }

    const pollOptions = candidates.map((c, i) => ({ text: `${i + 1}. ${c.displayName}`.slice(0, 55) }));

    const pollMsg = await channel.send({
        embeds: [speechEmbed],
        poll: {
            question: { text: "Pick your new overlord:" },
            answers: pollOptions,
            duration: 1,
            allowMultiselect: false
        }
    });

    // Store as a single bracket for uniform processing
    election.tournamentBrackets = [{
        bracketIndex: 0,
        messageId: pollMsg.id,
        candidates: candidates.map(c => ({ userId: c.userId, displayName: c.displayName, index: c.index }))
    }];

    await Election.updateOne(
        { guildId: channel.guild.id },
        {
            $set: {
                step: 3,
                messageId: pollMsg.id,
                tournamentRound: election.tournamentRound,
                tournamentBrackets: election.tournamentBrackets,
                endTime: endTime,
                processing: false
            }
        }
    );
}

async function startTournamentRound(channel, election, previousRoundSummary = '') {
    const candidates = election.candidates;
    const totalCandidates = candidates.length;

    // If 10 or fewer, send a single final poll
    if (totalCandidates <= 10) {
        await sendFinalPoll(channel, election, candidates, previousRoundSummary);
        return;
    }

    // Shuffle candidates (Fisher-Yates)
    const shuffled = [...candidates];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    // Distribute into minimum required brackets (round-robin)
    const numBrackets = Math.ceil(totalCandidates / 10);
    const brackets = Array.from({ length: numBrackets }, () => []);
    for (let i = 0; i < totalCandidates; i++) {
        brackets[i % numBrackets].push(shuffled[i]);
    }

    const endTime = Date.now() + (CONFIG.VOTE_MINS * 60000);
    const endTimeSecs = Math.floor(endTime / 1000);

    // Build auto-advance summary for anchor
    const autoAdvanceNames = [];

    // Send ALL bracket polls simultaneously
    const tournamentBrackets = [];

    for (let b = 0; b < brackets.length; b++) {
        const bracket = brackets[b];

        // Handle solo bracket (auto-win) — no separate message, just track it
        if (bracket.length === 1) {
            autoAdvanceNames.push(bracket[0].displayName);
            tournamentBrackets.push({
                bracketIndex: b,
                messageId: null,
                winnerUserId: bracket[0].userId,
                candidates: bracket.map(c => ({ userId: c.userId, displayName: c.displayName, index: c.index }))
            });
            continue;
        }

        // Build speech embed for this bracket
        const bracketCandidates = bracket.map((c, i) => ({ userId: c.userId, displayName: c.displayName, speech: c.speech, index: i + 1 }));
        const speechDesc = buildSpeechDescription(bracketCandidates, endTimeSecs);

        const speechEmbed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(`📊 Bracket ${b + 1} of ${numBrackets}`);

        if (speechDesc.length > 4096) {
            const compactDesc = bracketCandidates.map((c, i) =>
                `${NUMBER_EMOJIS[i]} **${c.displayName}**`
            ).join('\n') + `\n\n⚠️ *Poll closes <t:${endTimeSecs}:R>!*`;
            speechEmbed.setDescription(compactDesc);
        } else {
            speechEmbed.setDescription(speechDesc);
        }

        const pollOptions = bracketCandidates.map((c, i) => ({ text: `${i + 1}. ${c.displayName}`.slice(0, 55) }));

        const pollMsg = await channel.send({
            embeds: [speechEmbed],
            poll: {
                question: { text: `Bracket ${b + 1}: Who advances?` },
                answers: pollOptions,
                duration: 1,
                allowMultiselect: false
            }
        });

        tournamentBrackets.push({
            bracketIndex: b,
            messageId: pollMsg.id,
            candidates: bracketCandidates.map(c => ({ userId: c.userId, displayName: c.displayName, index: c.index }))
        });
    }

    // Update anchor with tournament info (including auto-advances)
    let anchorDesc = '';
    if (election.purgeResultText) {
        anchorDesc += `${election.purgeResultText}\n\n━━━━━━━━━━━━━━━━━━━━━\n`;
    }
    if (previousRoundSummary) {
        anchorDesc += `${previousRoundSummary}\n━━━━━━━━━━━━━━━━━━━━━\n`;
    }
    anchorDesc += `🏆 **Tournament Round ${election.tournamentRound}**\n` +
        `**${totalCandidates} candidates** split into **${numBrackets} brackets**!\n` +
        `All bracket polls are live below ⬇️\n` +
        `⏳ Voting closes <t:${endTimeSecs}:R>`;

    if (autoAdvanceNames.length > 0) {
        anchorDesc += `\n\n🎯 *Auto-advanced (no opponents):* ${autoAdvanceNames.join(', ')}`;
    }

    anchorDesc += `\n\n*H-Here we go! Don't get impatient, baka!* (>////<)`;

    const anchorEmbed = new EmbedBuilder()
        .setColor(0xFF69B4)
        .setTitle("🗳️ ELECTION IN PROGRESS")
        .setDescription(anchorDesc)
        .setFooter({ text: "D-Don't mess this up, bakas!" });

    await editAnchor(channel, election, anchorEmbed);

    await Election.updateOne(
        { guildId: channel.guild.id },
        {
            $set: {
                step: 3,
                messageId: null,
                tournamentRound: election.tournamentRound,
                tournamentBrackets: tournamentBrackets,
                endTime: endTime,
                processing: false
            }
        }
    );
}

// ==================== CHECK ALL BRACKETS (SIMULTANEOUS) ====================

async function checkAllBrackets(channel, election) {
    const brackets = election.tournamentBrackets || [];

    if (brackets.length === 0) {
        return await cancel(channel, election, "No tournament brackets found! H-How?! Something is seriously broken! (>////<)");
    }

    // End ALL bracket polls (with 1s delay between for rate limits)
    for (const bracket of brackets) {
        if (bracket.winnerUserId) continue; // Already has a winner (auto-win)
        if (!bracket.messageId) continue;

        const msg = await safeFetch(channel, bracket.messageId);
        if (!msg || !msg.poll) {
            return await cancel(channel, election, `Bracket ${bracket.bracketIndex + 1} poll vanished! S-Someone deleted it?! Election cancelled! (¬_¬)`);
        }

        await endPollSafely(msg.poll);
        await wait(1000); // Rate limit protection between polls
    }

    // Wait for results to finalize
    await wait(2500);

    // Extract winners from each bracket
    const bracketSummaries = [];
    for (const bracket of brackets) {
        if (bracket.winnerUserId) {
            // Already processed (auto-win or auto-advance)
            const winner = bracket.candidates.find(c => c.userId === bracket.winnerUserId);
            if (winner) {
                bracketSummaries.push(`Bracket ${bracket.bracketIndex + 1}: **${winner.displayName}** (auto-advance)`);
            }
            continue;
        }
        if (!bracket.messageId) continue;

        // Re-fetch for accurate results
        const freshMsg = await safeFetch(channel, bracket.messageId);
        if (!freshMsg || !freshMsg.poll) {
            return await cancel(channel, election, `Bracket ${bracket.bracketIndex + 1} poll vanished during finalization! Election cancelled! (¬_¬)`);
        }

        const results = [...freshMsg.poll.answers.values()].sort((a, b) => b.voteCount - a.voteCount);
        const topResult = results[0];

        if (!topResult || topResult.voteCount === 0) {
            // No votes — no winner from this bracket
            bracketSummaries.push(`Bracket ${bracket.bracketIndex + 1}: ⚠️ No votes cast — eliminated`);
            continue;
        }

        // Check for ties
        const tied = results.filter(r => r.voteCount === topResult.voteCount);
        let winnerCandidate = null;
        let tieInfo = '';

        if (tied.length > 1) {
            // Random tiebreaker
            const randomWinner = tied[Math.floor(Math.random() * tied.length)];
            winnerCandidate = extractWinner(randomWinner, bracket.candidates);
            tieInfo = ' *(tie, coin flip!)*';
        } else {
            winnerCandidate = extractWinner(topResult, bracket.candidates);
        }

        if (winnerCandidate) {
            bracket.winnerUserId = winnerCandidate.userId;
            const voteStr = formatVoteResults(results);
            bracketSummaries.push(`Bracket ${bracket.bracketIndex + 1}: **${winnerCandidate.displayName}**${tieInfo} — ${voteStr}`);
        }
    }

    // Delete all poll messages
    for (const bracket of brackets) {
        if (bracket.messageId) {
            await safeDelete(channel, bracket.messageId);
        }
    }

    // Save bracket results to DB
    await Election.updateOne(
        { guildId: channel.guild.id },
        { $set: { tournamentBrackets: brackets } }
    );

    // Process results
    await processRoundResults(channel, election, brackets, bracketSummaries);
}

// ==================== PROCESS ROUND RESULTS ====================

async function processRoundResults(channel, election, brackets, bracketSummaries) {
    // Re-fetch to get latest anchorMessageId and purgeResultText
    const freshElection = await Election.findOne({ guildId: channel.guild.id });
    if (freshElection) {
        election.anchorMessageId = freshElection.anchorMessageId;
        election.purgeResultText = freshElection.purgeResultText;
    }

    // Collect all winners
    const winners = [];
    for (const bracket of brackets) {
        if (bracket.winnerUserId) {
            const candidate = bracket.candidates.find(c => c.userId === bracket.winnerUserId);
            if (candidate) winners.push(candidate);
        }
    }

    // No winners at all
    if (winners.length === 0) {
        return await cancel(channel, election, "No winners from any bracket! W-What a disaster! This election was doomed from the start! (¬_¬)");
    }

    // SINGLE WINNER — crown them!
    if (winners.length === 1) {
        const finalWinner = winners[0];
        let winnerName = finalWinner.displayName;
        let winnerAvatar = null;
        let roleGranted = false;

        try {
            const member = await channel.guild.members.fetch(finalWinner.userId);
            const modRole = channel.guild.roles.cache.find(r => r.name === CONFIG.MOD_ROLE);
            winnerName = member.displayName;
            winnerAvatar = member.user.displayAvatarURL();

            if (modRole) {
                await member.roles.add(modRole);
                roleGranted = true;
            }
        } catch (err) {
            console.error("Failed to add mod role:", err.message);
        }

        // Find their speech from the original candidates
        const fullCandidate = election.candidates.find(c => c.userId === finalWinner.userId);

        // Build comprehensive final anchor with full results
        let finalDesc = '';

        // Include purge results
        if (election.purgeResultText) {
            finalDesc += `${election.purgeResultText}\n\n━━━━━━━━━━━━━━━━━━━━━\n`;
        }

        // Include vote results
        if (bracketSummaries && bracketSummaries.length > 0) {
            finalDesc += `📊 **Vote Results:**\n${bracketSummaries.join('\n')}\n\n━━━━━━━━━━━━━━━━━━━━━\n`;
        }

        finalDesc += `👑 **${winnerName}** has claimed victory!\n`;
        if (fullCandidate?.speech) finalDesc += `📜 Speech: "${fullCandidate.speech}"\n`;
        finalDesc += roleGranted ? `✅ Mod role granted!` : `⚠️ Could not grant mod role! Check permissions!`;
        finalDesc += `\n\n*I-It's not like I'm happy for them or anything... baka!* (>////<)`;

        const anchorEmbed = new EmbedBuilder()
            .setColor(0xFFD700)
            .setTitle("🎉🎉 ELECTION COMPLETE 🎉🎉")
            .setDescription(finalDesc)
            .setFooter({ text: "I-It's not like I cared about who won or anything... (>////<)" });

        if (winnerAvatar) anchorEmbed.setThumbnail(winnerAvatar);

        // ALWAYS edit anchor — this is the announcement
        await editAnchor(channel, election, anchorEmbed);

        await resetElection(channel.guild.id);
        return;
    }

    // MULTIPLE WINNERS — advance to next round
    // Build previous round summary to pass to the next round
    let previousRoundSummary = `🔄 **Round ${election.tournamentRound} Complete!**\n`;
    if (bracketSummaries && bracketSummaries.length > 0) {
        previousRoundSummary += `📊 **Results:**\n${bracketSummaries.join('\n')}\n\n`;
    }
    previousRoundSummary += `**${winners.length} candidates** advance to Round ${(election.tournamentRound || 1) + 1}:\n`;
    previousRoundSummary += winners.map(w => `• **${w.displayName}**`).join('\n');

    // Prepare next round
    const nextCandidates = winners.map((w, i) => ({
        userId: w.userId,
        displayName: w.displayName,
        speech: election.candidates.find(c => c.userId === w.userId)?.speech || 'Advanced from previous round',
        index: i + 1
    }));

    election.candidates = nextCandidates;
    election.tournamentRound = (election.tournamentRound || 1) + 1;
    election.tournamentBrackets = [];

    await Election.updateOne(
        { guildId: channel.guild.id },
        {
            $set: {
                candidates: nextCandidates,
                tournamentRound: election.tournamentRound,
                tournamentBrackets: []
            }
        }
    );

    // Start next round with the summary
    await startTournamentRound(channel, election, previousRoundSummary);
}

// ==================== CANCEL / RESET ====================

async function cancel(channel, election, reason) {
    const embed = new EmbedBuilder()
        .setColor(0x95A5A6)
        .setTitle("❌ Election Ended")
        .setDescription(reason)
        .setFooter({ text: "Well, that was a waste of time. (¬_¬)" });

    // Edit anchor to show cancellation
    await editAnchor(channel, election, embed);

    // Clean up any remaining poll/button messages
    if (election.messageId) await safeDelete(channel, election.messageId);

    // Clean up bracket poll messages
    if (election.tournamentBrackets) {
        for (const bracket of election.tournamentBrackets) {
            if (bracket.messageId) await safeDelete(channel, bracket.messageId);
        }
    }

    await resetElection(channel.guild.id);
}

async function resetElection(guildId) {
    await Election.updateOne(
        { guildId },
        {
            $set: {
                active: false,
                step: 0,
                candidates: [],
                modCandidates: [],
                tournamentRound: 0,
                tournamentBrackets: [],
                processing: false,
                messageId: null,
                endTime: 0,
                purgeResultText: null
            }
        }
    );
}
