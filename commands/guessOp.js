const { EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const Fuse = require('fuse.js');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const User = require('../models/User');
const { distributeIncome } = require('../utils/income');
const config = require('../config');

// Configure fluent-ffmpeg to use the static binary we installed
ffmpeg.setFfmpegPath(ffmpegStatic);

const difficultyTimes = config.TRIVIA.DURATIONS;

// Pool sizes scale with difficulty — harder = deeper into AniList popularity rankings
const POOL_SIZES = config.TRIVIA.POOL_SIZES;
const DIFF_EMOJI = config.TRIVIA.DIFF_EMOJI;

// Levenshtein distance for fuzzy word matching
function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}

let topAnimeCache = [];
let cachedPageCount = 0;
let cacheBackoffUntil = 0;   // Timestamp — skip fetches until this time (rate-limit cooldown)
let cacheBootstrapped = false; // Only fire the passive bootstrap once

function normalizeTitle(t) {
    if (!t) return "";
    return t.toLowerCase()
        .replace(/[^a-z0-9\s]/g, '') // Remove punctuation
        .replace(/\b(1st|2nd|3rd|4th|5th|6th|7th|8th|9th)\s+season\b/g, '') // remove "2nd season"
        .replace(/\bseason\s+\d+\b/g, '') // remove "season 2"
        .replace(/\bpart\s+\d+\b/g, '')   // remove "part 2"
        .replace(/\bcour\s+\d+\b/g, '')   // remove "cour 2"
        .replace(/\bthe\b/g, '')          // remove "the"
        .replace(/\s+/g, ' ')             // collapse multiple spaces
        .trim();
}

async function fetchTopAnime(targetCount = 500) {
    // Already have enough cached
    if (topAnimeCache.length >= targetCount) return topAnimeCache.slice(0, targetCount);

    // Rate-limit backoff — skip if we recently got a 429 or network error
    if (Date.now() < cacheBackoffUntil) {
        return topAnimeCache.length > 0 ? topAnimeCache : [];
    }

    try {
        const startPage = cachedPageCount + 1;
        const endPage = Math.ceil(targetCount / 50);
        console.log(`[Guess Trivia] Fetching AniList pages ${startPage}-${endPage} (target: ${targetCount})...`);

        for (let page = startPage; page <= endPage; page++) {
            const query = `query { Page(page: ${page}, perPage: 50) { media(sort: POPULARITY_DESC, type: ANIME, isAdult: false) { id title { romaji english } coverImage { large } } } }`;
            const res = await axios.post('https://graphql.anilist.co', { query });
            const media = res.data?.data?.Page?.media;
            if (!media || media.length === 0) break;
            topAnimeCache.push(...media);
            cachedPageCount = page;

            // Small delay between pages to avoid hitting AniList rate limits
            if (page < endPage) await new Promise(r => setTimeout(r, 800));
        }

        console.log(`[Guess Trivia] Cache now has ${topAnimeCache.length} anime (${cachedPageCount} pages).`);
        return topAnimeCache.slice(0, targetCount);
    } catch (err) {
        console.error("[Guess Trivia] Failed to fetch anime cache:", err.message);
        // Back off for 60s on any error (covers 429, network failures, etc.)
        cacheBackoffUntil = Date.now() + 60_000;
        return topAnimeCache.length > 0 ? topAnimeCache : [];
    }
}

async function fetchAnime(mode, difficulty = 'medium') {
    const poolSize = POOL_SIZES[difficulty] || 500;
    const pool = await fetchTopAnime(poolSize);
    if (pool.length === 0) return null;

    // Retry up to 5 times to find a random anime that matches our OP/ED requirement
    for (let i = 0; i < 5; i++) {
        const randomAnime = pool[Math.floor(Math.random() * pool.length)];
        const titleQuery = randomAnime.title.romaji || randomAnime.title.english;
        
        const url = `https://api.animethemes.moe/anime?q=${encodeURIComponent(titleQuery)}&filter[has]=resources&include=animethemes.animethemeentries.videos,animethemes.song`;
        try {
            const response = await axios.get(url);
            const data = response.data;
            if (!data.anime || data.anime.length === 0) continue;
            
            // Assume the top hit is the correct show
            const anime = data.anime[0];
            
            // Filter to requested mode (OP or ED)
            const themes = anime.animethemes.filter(t => t.type === mode);
            if (themes.length > 0) {
                return { anime, themes, anilist: randomAnime };
            }
        } catch (e) {
            console.error(`[Guess Trivia] API error for ${titleQuery}: ${e.message}`);
        }
    }
    return null; // Exhausted retries
}

async function trimAudio(audioUrl, duration, retryWithoutSeek = false) {
    const response = await axios({
        url: audioUrl,
        responseType: 'stream'
    });

    return new Promise((resolve, reject) => {
        const cleanupStream = () => {
            if (response.data && typeof response.data.destroy === 'function') {
                response.data.destroy();
            }
        };

        const pt = new PassThrough();
        const chunks = [];
        pt.on('data', c => chunks.push(c));
        pt.on('end', () => {
            cleanupStream();
            resolve(Buffer.concat(chunks));
        });
        pt.on('error', (err) => {
            cleanupStream();
            reject(err);
        });

        const cmd = ffmpeg(response.data);
        if (!retryWithoutSeek) {
            cmd.seekOutput(15);
        }
        
        cmd.duration(duration)
            .noVideo()
            .format('mp3')
            .on('end', cleanupStream)
            .on('error', (err) => {
                cleanupStream();
                if (!retryWithoutSeek) {
                    console.error("[Guess OP] FFmpeg Error (15s offset):", err.message, "| Retrying without seek");
                    resolve(trimAudio(audioUrl, duration, true));
                } else {
                    console.error("[Guess OP] FFmpeg Error (Fallback):", err.message);
                    reject(err);
                }
            })
            .pipe(pt, { end: true });
    });
}

const opQueue = [];
const edQueue = [];
let isFillingQueues = false;

async function prepareTrack(mode, difficulty) {
    const result = await fetchAnime(mode, difficulty);
    if (!result) return null;
    
    const { anime, themes, anilist } = result;
    const selectedTheme = themes[Math.floor(Math.random() * themes.length)];
    const entry = selectedTheme.animethemeentries?.[0];
    const video = entry?.videos?.[0];
    
    if (!video) return null;
    
    const videoUrl = video.link || `https://animethemes.moe/video/${video.basename}`;
    const duration = difficultyTimes[difficulty];
    
    try {
        const audioBuffer = await trimAudio(videoUrl, duration);
        return { anime, selectedTheme, anilist, videoUrl, audioBuffer };
    } catch(e) {
        return null;
    }
}

async function fillQueues() {
    if (isFillingQueues) return;
    isFillingQueues = true;
    
    try {
        await fetchTopAnime();
        
        // Loop Bailouts (Max 5 consecutive failures before yielding)
        let opFails = 0;
        while (opQueue.length < 3 && opFails < 5) {
            console.log(`[Guess Trivia] Pre-fetching OP buffer... (${opQueue.length}/3)`);
            const track = await prepareTrack('OP', 'medium');
            if (track) { opQueue.push(track); opFails = 0; }
            else opFails++;
        }
        
        let edFails = 0;
        while (edQueue.length < 3 && edFails < 5) {
            console.log(`[Guess Trivia] Pre-fetching ED buffer... (${edQueue.length}/3)`);
            const track = await prepareTrack('ED', 'medium');
            if (track) { edQueue.push(track); edFails = 0; }
            else edFails++;
        }
    } catch(e) {
        console.error("[Guess Trivia] Background queue fill error:", e);
    }
    
    isFillingQueues = false;
}

async function getLeaderboard(message, type) {
    const isOp = type === 'op';
    const field = isOp ? 'opHighestStreak' : 'edHighestStreak';
    const currentField = isOp ? 'opGuessStreak' : 'edGuessStreak';
    
    message.channel.sendTyping();
    const topPlayers = await User.find({ [field]: { $gt: 0 } })
        .sort({ [field]: -1 })
        .limit(10);

    if (topPlayers.length === 0) {
        return message.reply(`No one has any anime ${isOp ? 'opening' : 'ending'} streaks yet.`);
    }

    const desc = await Promise.all(topPlayers.map(async (u, i) => {
        let name = "Unknown";
        try {
            const member = await message.guild.members.fetch(u.userId);
            name = member.displayName;
        } catch (e) {
            try {
                const globalUser = await message.client.users.fetch(u.userId);
                name = globalUser.username;
            } catch (e2) {}
        }

        const rank = i === 0 ? '🥇' : (i === 1 ? '🥈' : (i === 2 ? '🥉' : `\`${i + 1}.\``));
        return `${rank} **${name}** — Max Streak: **${u[field]}** (Current: ${u[currentField]})`;
    }));

    const embed = new EmbedBuilder()
        .setColor(0x2B2D31)
        .setTitle(`🏆 Anime ${isOp ? 'Opening' : 'Ending'} Trivia Leaderboard`)
        .setDescription(desc.join('\n'));

    return message.reply({ embeds: [embed] });
}

// Track active game globally to prevent overlap
let isPlaying = false;

module.exports = {
    handle: async (message, client) => {
        // Run cache bootstrapper once on first invocation — not on every message
        if (!cacheBootstrapped) {
            cacheBootstrapped = true;
            fetchTopAnime().then(() => fillQueues()).catch(() => {});
        }

        const args = message.content.split(' ');
        const cmd = args[0].toLowerCase();
        
        // !leaderboard op | ed
        if (cmd === '!leaderboard' || cmd === '!lb') {
            const type = args[1]?.toLowerCase();
            if (type === 'op' || type === 'ed') {
                return await getLeaderboard(message, type);
            }
        }

        if (cmd === '!guess') {
            const type = args[1]?.toLowerCase();
            if (!type || !['opening', 'openings', 'ending', 'endings'].includes(type)) {
                return message.reply("Usage: `!guess opening [difficulty]` or `!guess ending [difficulty]`\nDifficulties: `easy, medium, hard, insane`");
            }
            let mode = null;
            if (type === 'opening' || type === 'openings') mode = 'OP';
            if (type === 'ending' || type === 'endings') mode = 'ED';
            
            if (mode) {
                if (isPlaying) {
                    return message.reply("A trivia game is already running! Wait for it to finish! (¬_¬)");
                }

                let difficulty = 'medium';
                
                // Extract diff from arguments
                if (args[2] && difficultyTimes[args[2].toLowerCase()]) {
                    difficulty = args[2].toLowerCase();
                }

                const duration = difficultyTimes[difficulty];
                isPlaying = true;

                // Safety net: force-reset isPlaying after 3 minutes no matter what
                // This covers cases where the collector silently dies or an error escapes the catch
                const isPlayingResetTimer = setTimeout(() => {
                    if (isPlaying) {
                        console.warn('[Guess Trivia] isPlaying safety reset triggered — collector may have died silently.');
                        isPlaying = false;
                    }
                }, 180000);

                const modeName = mode === 'OP' ? 'Opening' : 'Ending';
                let track = null;
                
                // Pop from queue if medium difficulty
                if (difficulty === 'medium') {
                    if (mode === 'OP' && opQueue.length > 0) track = opQueue.shift();
                    if (mode === 'ED' && edQueue.length > 0) track = edQueue.shift();
                }
                
                // Trigger background refill
                fillQueues().catch(() => {});

                let loadingMsg;

                try {

                    if (!track) {
                    const startEmbed = new EmbedBuilder()
                        .setColor('#8aadf4')
                        .setTitle(`🎵 Fetching Anime ${modeName}...`)
                        .setDescription(`Hold on a second, idiot! I'm downloading the track...\n\n**Difficulty:** ${difficulty.toUpperCase()} (${duration}s)`);
                    loadingMsg = await message.reply({ embeds: [startEmbed] });
                    
                    track = await prepareTrack(mode, difficulty);
                    
                    if (!track) {
                        isPlaying = false;
                        clearTimeout(isPlayingResetTimer);
                        return loadingMsg.edit({ embeds: [], content: `Failed to find a matching anime ${modeName} after multiple retries. Please try again!` });
                    }
                } else {
                    // Send an instant start message if we had it loaded
                    loadingMsg = await message.reply({ content: "*Loading pre-fetched track...*" });
                }

                const { anime, selectedTheme, anilist, videoUrl, audioBuffer } = track;
                const attachment = new AttachmentBuilder(audioBuffer, { name: 'track.mp3' });
                
                const modeColor = mode === 'OP' ? '#4a9eff' : '#ff6b9d';
                const endTimeMs = Date.now() + 20000;
                const diffIcon = DIFF_EMOJI[difficulty] || '🟡';

                const buildGameEmbed = (remaining, playerCount) => {
                    return new EmbedBuilder()
                        .setColor(modeColor)
                        .setTitle(`🎧 Guess the ${modeName}!`)
                        .setDescription(`Listen to the clip and type the **Anime Name** or **Song Title**!`)
                        .addFields(
                            { name: 'Difficulty', value: `${diffIcon} **${difficulty.toUpperCase()}** (${duration}s clip)`, inline: true },
                            { name: 'Time Left', value: `⏱️ **${remaining}s**`, inline: true },
                            { name: 'Players', value: `👥 **${playerCount}**`, inline: true }
                        )
                        .setFooter({ text: 'D-Don\'t mess this up, baka! (¬_¬)' });
                };

                await loadingMsg.edit({ 
                    content: "", 
                    embeds: [buildGameEmbed(20, 0)],
                    files: [attachment] 
                });

                    // Pre-process fuse dataset 
                    const names = new Set();
                    if (anime.name) names.add(normalizeTitle(anime.name));
                    if (anime.synonyms) {
                        for (const syn of anime.synonyms) {
                            if (syn.text) names.add(normalizeTitle(syn.text));
                        }
                    }
                    if (anilist && anilist.title) {
                        if (anilist.title.english) names.add(normalizeTitle(anilist.title.english));
                        if (anilist.title.romaji) names.add(normalizeTitle(anilist.title.romaji));
                    }
                    if (selectedTheme.song && selectedTheme.song.title) {
                        names.add(normalizeTitle(selectedTheme.song.title));
                    }
                    
                    const fuseDataset = Array.from(names).filter(n => n.length > 0).map(n => ({ title: n }));
                    
                    const fuse = new Fuse(fuseDataset, {
                        keys: ['title'],
                        includeScore: true,
                        ignoreLocation: true,
                        threshold: 0.4 // Max similarity distance of 40%
                    });

                    const filter = m => !m.author.bot;
                    const collector = message.channel.createMessageCollector({ filter, time: 20000 });
                    const participants = new Set();
                    let participantCount = 0;
                    let winner = null;

                    console.log(`[Guess Trivia] 20s message collector started in ${message.channel.name}`);

                    // 1-second participant counter + countdown
                    const countdownInterval = setInterval(async () => {
                        if (winner) return; // Stop updating once winner found
                        const remaining = Math.max(0, Math.ceil((endTimeMs - Date.now()) / 1000));
                        if (remaining <= 0) { clearInterval(countdownInterval); return; }
                        try {
                            await loadingMsg.edit({ embeds: [buildGameEmbed(remaining, participantCount)] });
                        } catch (e) { /* rate limited or message deleted, skip this tick */ }
                    }, 1000);

                    collector.on('collect', async m => {
                        // Ignore commands entirely
                        if (m.content.startsWith('!')) return;

                        // Race-condition guard: if someone already won, stop processing
                        if (winner) return;

                        const guess = normalizeTitle(m.content);

                        // BUG FIX: Track ALL non-command message senders as participants
                        // so their streak resets if they don't win (prevents streak camping)
                        if (guess.length > 0) {
                            participants.add(m.author.id);
                            participantCount = participants.size;
                        }

                        let matched = false;

                        // Phase 1: Explicit Exact Match Bypass (For 1 or 2 letter titles like "K" or "86")
                        if (guess.length > 0) {
                            for (const name of fuseDataset) {
                                if (name.title === guess) {
                                    matched = true;
                                    break;
                                }
                            }
                        }

                        // Phase 2: Fuzzy Word Matching (Ignored if already matched, or if guess is too short)
                        if (!matched && guess.length >= 3) {
                            const guessWords = guess.split(/\s+/).filter(w => w.length >= 3);
                            if (guessWords.length > 0) {
                                for (const name of fuseDataset) {
                                    const answerWords = name.title.split(/\s+/).filter(w => w.length >= 2);
                                    
                                    // Dynamic Length Restriction
                                    const maxAllowedWords = (answerWords.length * 2) + 3;
                                    if (guessWords.length > maxAllowedWords) continue;
                            
                            // Check if at least one guess word matches an answer word
                            const hasWordMatch = guessWords.some(gw => 
                                answerWords.some(aw => {
                                    // Exact word match
                                    if (gw === aw) return true;
                                    // Allow slight misspelling (Levenshtein distance <= 2, but only for words 6+ chars)
                                    if (gw.length >= 6 && aw.length >= 6) {
                                        return levenshtein(gw, aw) <= 2;
                                    }
                                    // For words 4-5 chars, allow only 1 edit
                                    if (gw.length >= 4 && aw.length >= 4) {
                                        return levenshtein(gw, aw) <= 1;
                                    }
                                    return false;
                                })
                            );
                            
                            if (hasWordMatch) {
                                matched = true;
                                break;
                            }
                                }
                            }
                        }
                        
                        // Don't react to very short non-matching inputs (likely casual chat)
                        if (!matched && guess.length < 3) return;

                        if (matched) {
                            winner = m.author.id;
                            collector.stop('correct');
                            try { await m.react('✅'); } catch (e) { }
                        } else {
                            try { await m.react('❌'); } catch (e) { }
                        }
                    });
                    
                    collector.on('end', async () => {
                        isPlaying = false;
                        clearTimeout(isPlayingResetTimer);
                        clearInterval(countdownInterval);
                        console.log(`[Guess Trivia] Collector ended. Winner ID: ${winner || 'None'}`);

                        if (winner) participants.delete(winner);
                        
                        const streakField = mode === 'OP' ? 'opGuessStreak' : 'edGuessStreak';
                        const highestField = mode === 'OP' ? 'opHighestStreak' : 'edHighestStreak';

                        for (const pid of participants) {
                            try {
                                await User.updateOne({ userId: pid }, { $set: { [streakField]: 0 } });
                            } catch (e) { console.error(e); }
                        }

                        if (winner) {
                            let userRecord = await User.findOne({ userId: winner });
                            if (!userRecord) userRecord = new User({ userId: winner });

                            // Calculate Coin Reward based on CURRENT stats before increment
                            const currentCoins = userRecord.coins || 0;
                            
                            // Find the first matching reward tier
                            const rewardTier = config.TRIVIA.REWARDS.find(r => currentCoins >= r.threshold) 
                                || config.TRIVIA.REWARDS[config.TRIVIA.REWARDS.length - 1];
                            let baseReward = rewardTier.reward;

                            // Diminishing returns on insane for rich players (softened)
                            if (difficulty === 'insane') {
                                const dimRet = config.TRIVIA.INSANE_DIMINISHING_RETURNS.find(r => currentCoins >= r.threshold);
                                if (dimRet) baseReward = Math.floor(baseReward * dimRet.mult);
                            }

                            const diffMult = config.TRIVIA.DIFF_MULTS[difficulty] || 1.5;

                            // Streak multiplier — capped at 2.0x (was 3.0x)
                            const newStreak = (userRecord[streakField] || 0) + 1;
                            const streakTier = config.TRIVIA.STREAK_MULTS.find(s => newStreak >= s.minStreak)
                                || config.TRIVIA.STREAK_MULTS[config.TRIVIA.STREAK_MULTS.length - 1];
                            const streakMult = streakTier.mult;

                            const totalReward = Math.floor(baseReward * diffMult * streakMult);
                            
                            // Atomic Updates
                            const updatedUser = await User.findOneAndUpdate(
                                { userId: winner },
                                { 
                                    $inc: { 
                                        [streakField]: 1
                                    } 
                                },
                                { new: true, upsert: true }
                            );
                            
                            // High score atomic pass
                            await User.findOneAndUpdate(
                                { userId: winner },
                                { $max: { [highestField]: updatedUser[streakField] } }
                            );

                            // Distribute Income (applies Prestige, Slave Tax, Loan Repayments)
                            const incomeLog = await distributeIncome(winner, totalReward);

                            const winQuotes = [
                                "H-Hmph! You actually got it right... don't let it go to your head! (¬_¬)",
                                "B-Baka! It's just luck that you knew that one! >///<",
                                "Not bad for a degenerate... here's your prize, I guess.",
                                "W-Whatever! I knew the answer way before you did anyway! (￣^￣)"
                            ];
                            const streakBonusText = streakMult > 1 ? ` (${streakMult}x streak bonus!)` : '';
                            const winEmbed = new EmbedBuilder()
                                .setColor('#a6da95')
                                .setTitle(`🎉 Correct!`)
                                .setDescription(`${winQuotes[Math.floor(Math.random() * winQuotes.length)]}\n\n<@${winner}> guessed it!\n\n**Anime:** \`${anime.name}\`\n**Song:** \`${selectedTheme.song?.title || 'Unknown'}\`\n**Streak:** \`${updatedUser[streakField]}\` 🔥\n**Base Prize:** \`+${totalReward.toLocaleString('en-US')} coins\`${streakBonusText}${incomeLog ? '\n' + incomeLog : ''}`);
                            
                            const freshWinner = await User.findOne({ userId: winner });
                            if (freshWinner) {
                                winEmbed.setFooter({ text: `💳 Balance: ${freshWinner.coins.toLocaleString('en-US')} — d-don't blow it all, baka!` });
                            }

                            if (anilist?.coverImage?.large) {
                                winEmbed.setThumbnail(anilist.coverImage.large);
                            }
                            
                            const btnRow = new ActionRowBuilder().addComponents(
                                new ButtonBuilder()
                                    .setLabel(`Watch Full ${mode === 'OP' ? 'Opening' : 'Ending'}`)
                                    .setStyle(ButtonStyle.Link)
                                    .setURL(videoUrl)
                            );

                            return message.channel.send({ embeds: [winEmbed], components: [btnRow] });
                        } else {
                            const loseQuotes = [
                                "Time's up! You're all hopeless idiots! (¬_¬)",
                                "Hah! Not even one correct guess? And you call yourselves weebs? (￣^￣)",
                                "How disappointing... It was so obvious! You're all terrible at this! >///<"
                            ];
                            const loseEmbed = new EmbedBuilder()
                                .setColor('#ed8796')
                                .setTitle(`⏰ Time's Up!`)
                                .setDescription(`${loseQuotes[Math.floor(Math.random() * loseQuotes.length)]}\n\n**Anime:** \`${anime.name}\`\n**Song:** \`${selectedTheme.song?.title || 'Unknown'}\`\n`);
                            
                            if (anilist?.coverImage?.large) {
                                loseEmbed.setThumbnail(anilist.coverImage.large);
                            }
                            
                            const btnRow = new ActionRowBuilder().addComponents(
                                new ButtonBuilder()
                                    .setLabel(`Watch Full ${mode === 'OP' ? 'Opening' : 'Ending'}`)
                                    .setStyle(ButtonStyle.Link)
                                    .setURL(videoUrl)
                            );
                            return message.channel.send({ embeds: [loseEmbed], components: [btnRow] });
                        }
                    });

                } catch (err) {
                    console.error("[Guess Trivia] Logic Error:", err);
                    isPlaying = false;
                    clearTimeout(isPlayingResetTimer);
                    loadingMsg?.edit("An unknown error occurred while fetching the trivia data.").catch(() => {});
                }
            }
        }
    }
};

