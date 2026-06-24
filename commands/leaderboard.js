const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, StringSelectMenuBuilder } = require('discord.js');
const User = require('../models/User');
const BuzzwordCount = require('../models/BuzzwordCount');
const config = require('../config');
const { getDisplayName } = require('../utils/helpers');

module.exports = {
    handle: async (message, client) => {
        const args = message.content.split(' ');
        const type = args[1]?.toLowerCase();
        const subtype = args[2]?.toLowerCase();

        if (type === 'slave' || type === 'carrot') {
            return message.reply("For carrot leaderboard use `!slave top`!");
        }

        const getShortName = async (userId) => {
            try {
                const member = await message.guild.members.fetch(userId);
                return member.displayName.slice(0, 12);
            } catch (e) {
                try {
                    const user = await client.users.fetch(userId);
                    return user.username.slice(0, 12);
                } catch (e2) {
                    return "Unknown";
                }
            }
        };

        // --- CHATS (Daily) ---
        if (type === 'chats' && subtype !== 'alltime') {
            const topChatters = await User.find({ 'stats.daily.messages': { $gt: 0 } }).sort({ 'stats.daily.messages': -1 }).limit(10).lean();
            if (topChatters.length === 0) return message.reply("No one has messaged today yet. Tch... this place is dead.");

            const chatLines = await Promise.all(topChatters.map(async (u, i) => {
                const name = await getShortName(u.userId);
                const rank = i === 0 ? '🥇' : (i === 1 ? '🥈' : (i === 2 ? '🥉' : `\`${String(i + 1).padStart(2)}\``));
                return `${rank} **${name}** — ${u.stats.daily.messages.toLocaleString('en-US')}`;
            }));

            const topReceived = await User.find({ 'stats.daily.reactionsReceived': { $gt: 0 } }).sort({ 'stats.daily.reactionsReceived': -1 }).limit(5).lean();
            const receivedLines = await Promise.all(topReceived.map(async (u, i) => {
                const name = await getShortName(u.userId);
                return `\`${i + 1}\` ${name} — ${u.stats.daily.reactionsReceived || 0}`;
            }));

            const topGiven = await User.find({ 'stats.daily.reactionsGiven': { $gt: 0 } }).sort({ 'stats.daily.reactionsGiven': -1 }).limit(5).lean();
            const givenLines = await Promise.all(topGiven.map(async (u, i) => {
                const name = await getShortName(u.userId);
                return `\`${i + 1}\` ${name} — ${u.stats.daily.reactionsGiven || 0}`;
            }));

            const embed = new EmbedBuilder()
                .setColor(0x2B2D31)
                .setTitle("Today's Leaderboard")
                .setThumbnail(client.user.displayAvatarURL())
                .setDescription(`**Top Chatters**\n${chatLines.join('\n')}`)
                .addFields(
                    { name: 'Most Emojis Received', value: receivedLines.join('\n') || 'None', inline: true },
                    { name: 'Most Emojis Reacted', value: givenLines.join('\n') || 'None', inline: true }
                )
                .setFooter({ text: 'Use !lb chats alltime for all-time stats' })
                .setTimestamp();

            return message.reply({ embeds: [embed] });
        }

        // --- CHATS (All-Time) ---
        if (type === 'chats' && subtype === 'alltime') {
            const loading = await message.reply("🔍 **Fetching the hall of fame...** Don't be impatient, you energetic goldfish! (¬_¬)");
            try {

            const PER_PAGE = 10;
            const totalUsers = await User.countDocuments({ 'stats.allTime.messages': { $gt: 0 } });
            if (totalUsers === 0) return loading.edit("No stats recorded yet!");

            const totalPages = Math.ceil(totalUsers / PER_PAGE);
            let currentPage = 0;

            // Fetch reactions and channels once (they don't change per page)
            const topReceived = await User.find({ 'stats.allTime.reactionsReceived': { $gt: 0 } }).sort({ 'stats.allTime.reactionsReceived': -1 }).limit(5).lean();
            const receivedLines = await Promise.all(topReceived.map(async (u, i) => {
                const name = await getShortName(u.userId);
                return `\`${i + 1}\` ${name} — ${u.stats.allTime.reactionsReceived || 0}`;
            }));

            const topGiven = await User.find({ 'stats.allTime.reactionsGiven': { $gt: 0 } }).sort({ 'stats.allTime.reactionsGiven': -1 }).limit(5).lean();
            const givenLines = await Promise.all(topGiven.map(async (u, i) => {
                const name = await getShortName(u.userId);
                return `\`${i + 1}\` ${name} — ${u.stats.allTime.reactionsGiven || 0}`;
            }));

            const topChannelsQuery = await User.aggregate([
                { $match: { 'stats.allTime.channels': { $exists: true, $type: 'object' } } },
                { $project: { channelsArray: { $objectToArray: "$stats.allTime.channels" } } },
                { $unwind: "$channelsArray" },
                { $group: { _id: "$channelsArray.k", totalMessages: { $sum: "$channelsArray.v" } } },
                { $sort: { totalMessages: -1 } },
                { $limit: 5 }
            ]);

            const sortedChannels = topChannelsQuery.map(doc => [doc._id, doc.totalMessages]);
            const chanLines = sortedChannels.map(([id, count], i) => {
                const chan = message.guild.channels.cache.get(id);
                return `\`${i + 1}\` #${chan?.name || "deleted"} — ${count.toLocaleString('en-US')}`;
            }).join('\n') || "No data";

            // Lazy page fetcher — queries DB with skip/limit, resolves only 10 names
            const fetchPage = async (page) => {
                const users = await User.find({ 'stats.allTime.messages': { $gt: 0 } })
                    .sort({ 'stats.allTime.messages': -1 })
                    .skip(page * PER_PAGE)
                    .limit(PER_PAGE)
                    .lean();

                const chatLines = await Promise.all(users.map(async (u, i) => {
                    const globalRank = (page * PER_PAGE) + i;
                    const name = await getShortName(u.userId);
                    const rank = globalRank === 0 ? '🥇' : (globalRank === 1 ? '🥈' : (globalRank === 2 ? '🥉' : `\`${String(globalRank + 1).padStart(2)}\``));
                    return `${rank} **${name}** — ${u.stats.allTime.messages.toLocaleString('en-US')}`;
                }));

                if (chatLines.length === 0) {
                    return new EmbedBuilder()
                        .setColor(0x2B2D31)
                        .setTitle('All-Time Leaderboard')
                        .setDescription('No more results... how did you even get here? (¬_¬)')
                        .setTimestamp();
                }

                return new EmbedBuilder()
                    .setColor(0x2B2D31)
                    .setTitle('All-Time Leaderboard')
                    .setThumbnail(client.user.displayAvatarURL())
                    .setDescription(`**Top Chatters**\n${chatLines.join('\n')}`)
                    .addFields(
                        { name: 'Most Emojis Received', value: receivedLines.join('\n') || 'None', inline: true },
                        { name: 'Most Emojis Reacted', value: givenLines.join('\n') || 'None', inline: true },
                        { name: 'Top Channels', value: chanLines, inline: false }
                    )
                    .setFooter({ text: `Page ${page + 1} / ${totalPages}  •  Stats since tracking began` })
                    .setTimestamp();
            };

            const buildButtons = (page) => {
                return new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('lb_alltime_prev')
                        .setEmoji('◀')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(page === 0 || totalPages <= 1),
                    new ButtonBuilder()
                        .setCustomId('lb_alltime_next')
                        .setEmoji('▶')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(page >= totalPages - 1 || totalPages <= 1)
                );
            };

            const firstEmbed = await fetchPage(0);
            const msg = await loading.edit({ content: null, embeds: [firstEmbed], components: [buildButtons(0)] });

            const nextMessages = [
                "Fine, next page... (¬_¬)",
                "Already? You just got here, idiot... (¬_¬)",
                "So needy... hold on! (¬_¬)",
                "Page turning isn't free, you know! (¬_¬)"
            ];
            const prevMessages = [
                "Going back? Make up your mind! (¬_¬)",
                "Changed your mind already? Typical. (¬_¬)",
                "Can't even scroll in one direction... (¬_¬)"
            ];

            let fetching = false;

            const collector = msg.createMessageComponentCollector({
                componentType: ComponentType.Button,
                time: 120_000
            });

            collector.on('collect', async (i) => {
                if (fetching) return i.deferUpdate().catch(() => {});
                fetching = true;

                try {
                    if (i.customId === 'lb_alltime_prev') currentPage = Math.max(0, currentPage - 1);
                    else if (i.customId === 'lb_alltime_next') currentPage = Math.min(totalPages - 1, currentPage + 1);

                    const loadMsg = i.customId === 'lb_alltime_next'
                        ? nextMessages[Math.floor(Math.random() * nextMessages.length)]
                        : prevMessages[Math.floor(Math.random() * prevMessages.length)];

                    await i.update({ content: loadMsg, embeds: [], components: [] });

                    const embed = await fetchPage(currentPage);
                    await i.editReply({ content: null, embeds: [embed], components: [buildButtons(currentPage)] });
                } catch (err) {
                    // Interaction may have expired or been invalidated
                } finally {
                    fetching = false;
                }
            });

            collector.on('end', async () => {
                const disabledRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('lb_alltime_prev').setEmoji('◀').setStyle(ButtonStyle.Secondary).setDisabled(true),
                    new ButtonBuilder().setCustomId('lb_alltime_next').setEmoji('▶').setStyle(ButtonStyle.Secondary).setDisabled(true)
                );
                await msg.edit({ components: [disabledRow] }).catch(() => {});
            });

            return;
            } catch (e) {
                console.error('[LEADERBOARD] alltime crash:', e);
                return loading.edit({ content: "S-Something exploded and it's NOT my fault! >///< Check the logs, idiot.", embeds: [], components: [] });
            }
        }

        // --- OVERLORD (Season Activity) ---
        if (type === 'overlord') {
            const loading = await message.reply("🔍 **Calculating Overlord scores...** Judging your pathetic financial decisions... (¬_¬)");
            
            const topUsers = await User.aggregate([
                { $match: { $or: [{ systemEarned: { $gt: 0 } }, { systemSpent: { $gt: 0 } }] } },
                { $project: { 
                    userId: 1, 
                    score: { 
                        $floor: { 
                            $pow: [
                                { $add: [
                                    { $ifNull: ["$systemEarned", 0] }, 
                                    { $ifNull: ["$systemSpent", 0] }
                                ] },
                                1/3
                            ]
                        } 
                    } 
                } },
                { $sort: { score: -1 } },
                { $limit: 10 }
            ]);

            if (topUsers.length === 0) {
                await loading.delete();
                return message.reply("No one has done literally anything yet! Are you all asleep?! (¬_¬)");
            }

            const desc = await Promise.all(topUsers.map(async (u, i) => {
                const displayName = await getDisplayName(u.userId, message.guild);
                const medal = i === 0 ? '👑' : (i === 1 ? '🥈' : (i === 2 ? '🥉' : `${i + 1}.`));
                return `${medal} **${displayName}** - **${u.score.toLocaleString('en-US')}** OP (Overlord Points)`;
            }));

            const embed = new EmbedBuilder()
                .setColor(0x010101)
                .setTitle("👑 Season Overlord Rankings")
                .setDescription(desc.join('\n'))
                .setFooter({ text: "U-Ugh... here are the tryhards sweating for the title. It's just a number, you addicts! (¬_¬)" });

            await loading.delete();
            return message.reply({ embeds: [embed] });
        }

        // --- RICH (Top) ---
        if (type === 'rich') {
            const loading = await message.reply("U-Ugh, fetching the rich list... don't rush me, you impatient bastard! 😒");
            const richUsers = await User.find({ coins: { $gt: 0 } }).sort({ coins: -1 }).limit(10);

            if (richUsers.length === 0) {
                await loading.delete();
                return message.reply("No one has any coins yet! What a poor server! I-It's not like I care about your wealth or anything! (¬_¬)");
            }

            const desc = await Promise.all(richUsers.map(async (u, i) => {
                const displayName = await getDisplayName(u.userId, message.guild);
                const medal = i === 0 ? '🥇' : (i === 1 ? '🥈' : (i === 2 ? '🥉' : `${i + 1}.`));
                return `${medal} **${displayName}** - **${u.coins.toLocaleString('en-US')}** Coins`;
            }));

            const embed = new EmbedBuilder()
                .setColor(0xFFD700)
                .setTitle("💰 Richest Users")
                .setDescription(desc.join('\n'))
                .setFooter({ text: "Use !lb poor to see the poorest!" });

            await loading.delete();
            return message.reply({ embeds: [embed] });
        }

        // --- POOR (Losers) ---
        if (type === 'poor') {
            const loading = await message.reply("U-Ugh, fetching the poor list... don't rush me, you impatient bastard! 😒");
            const poorUsers = await User.find({ coins: { $gt: 0 } }).sort({ coins: 1 }).limit(10);

            if (poorUsers.length === 0) {
                await loading.delete();
                return message.reply("No one has any coins yet! What a poor server! I-It's not like I care about your wealth or anything! (¬_¬)");
            }

            const desc = await Promise.all(poorUsers.map(async (u, i) => {
                const displayName = await getDisplayName(u.userId, message.guild);
                const medal = i === 0 ? '🗑️' : (i === 1 ? '💩' : (i === 2 ? '🤡' : `${i + 1}.`));
                return `${medal} **${displayName}** - **${u.coins.toLocaleString('en-US')}** Coins`;
            }));

            const embed = new EmbedBuilder()
                .setColor(0x8B4513)
                .setTitle("🗑️ Poorest Users")
                .setDescription(desc.join('\n'))
                .setFooter({ text: "Use !lb rich to see the richest!" });

            await loading.delete();
            return message.reply({ embeds: [embed] });
        }

        // --- HIGHER LOWER (Top Streak) ---
        if (type === 'hl') {
            const loading = await message.reply("🔍 **Fetching the high rollers...** Don't be impatient! (¬_¬)");
        
            const topPlayers = await User.find({ highScore: { $gt: 0 } })
                .sort({ highScore: -1 })
                .limit(10);

            if (topPlayers.length === 0) {
                return loading.edit("No one has played yet! What a boring server... (¬_¬)");
            }

            const desc = await Promise.all(topPlayers.map(async (u, i) => {
                const name = await getShortName(u.userId);

                const rank = i === 0 ? '🥇' : (i === 1 ? '🥈' : (i === 2 ? '🥉' : `\`${i + 1}.\``));
                return `${rank} **${name}** — Streak: **${u.highScore}**`;
            }));

            const embed = new EmbedBuilder()
                .setColor(0xFFD700)
                .setTitle("🏆 Higher Lower Leaderboard")
                .setDescription(desc.join('\n'))
                .setFooter({ text: "Can you beat the top score? I doubt it. (¬_¬)" });

            return loading.edit({ content: null, embeds: [embed] });
        }

        // --- DUEL (Top/Losers) ---
        if (type === 'duel') {
            if (!['top', 'losers'].includes(subtype)) {
                return message.reply("Usage: `!lb duel top` or `!lb duel losers`");
            }

            const sort = subtype === 'top' ? { elo: -1 } : { elo: 1 };
            const query = subtype === 'top' ? { wins: { $gt: 0 } } : { losses: { $gt: 0 } };
            const users = await User.find(query).sort(sort).limit(10);
        
            if (users.length === 0) return message.reply("No one has battled yet! Cowards! (¬_¬)");
        
            const desc = await Promise.all(users.map(async (u, i) => {
                const name = await getShortName(u.userId);
        
                const medal = subtype === 'top' && i < 3 ? ['🥇', '🥈', '🥉'][i] : (subtype === 'losers' && i < 3 ? ['🗑️', '💩', '🤡'][i] : `${i + 1}.`);
                return `${medal} **${name}** - **${u.elo}** Elo`;
            }));
        
            const embed = new EmbedBuilder()
                .setColor(subtype === 'top' ? 0xFF0000 : 0x8B4513)
                .setTitle(subtype === 'top' ? "🏆 Taste Battle Leaderboard" : "🗑️ Hall of Shame")
                .setDescription(desc.join('\n'));
        
            return message.reply({ embeds: [embed] });
        }

        // --- FISHING (Heaviest / Total Caught) ---
        if (type === 'fish' || type === 'heavy') {
            const loading = await message.reply("🔍 **Fetching the fishing records...** Don't be impatient! (¬_¬)");
            
            const isHeavy = type === 'heavy';
            const sortField = isHeavy ? 'fishing.stats.heaviestFish' : 'fishing.stats.totalCaught';
            
            const topPlayers = await User.find({ [sortField]: { $gt: 0 } })
                .sort({ [sortField]: -1 })
                .limit(10);

            if (topPlayers.length === 0) {
                return loading.edit("No one has caught anything yet! Are you all using twigs for fishing rods?! (¬_¬)");
            }

            const desc = await Promise.all(topPlayers.map(async (u, i) => {
                const name = await getShortName(u.userId);
                const rank = i === 0 ? '🥇' : (i === 1 ? '🥈' : (i === 2 ? '🥉' : `\`${i + 1}.\``));
                const statValue = isHeavy ? `${u.fishing.stats.heaviestFish.toLocaleString('en-US')} lbs` : `${u.fishing.stats.totalCaught.toLocaleString('en-US')} caught`;
                return `${rank} **${name}** — ${statValue}`;
            }));

            const embed = new EmbedBuilder()
                .setColor(0x00BFFF)
                .setTitle(isHeavy ? "🎣 Heaviest Catches" : "🎣 Top Fishermen")
                .setDescription(desc.join('\n'))
                .setFooter({ text: "I-It's not like I'm impressed by your fish size or anything! (¬_¬)" });

            return loading.edit({ content: null, embeds: [embed] });
        }

        // --- BUZZWORDS ---
        if (type === 'buzz' || type === 'buzzwords') {
            const rawGroups = config.BUZZWORDS || [];
            if (rawGroups.length === 0) {
                return message.reply("No buzzwords configured yet! Tell the owner to add some, baka! (¬_¬)");
            }

            // Normalize: strings become single-element arrays
            const groups = rawGroups.map(g => Array.isArray(g) ? g.map(w => w.toLowerCase()) : [g.toLowerCase()]);

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('buzz_select')
                .setPlaceholder('Pick a buzzword to see rankings...')
                .addOptions(groups.map(group => ({
                    label: group.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' | '),
                    value: group.join(','),
                    emoji: '🔤',
                })));

            const row = new ActionRowBuilder().addComponents(selectMenu);

            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('📊 Buzzword Leaderboard')
                .setDescription('Pick a word from the dropdown to see who says it the most!\n\nD-Don\'t get too obsessed with tracking people\'s words... weirdo. (¬_¬)')
                .setFooter({ text: `${groups.length} buzzword group${groups.length === 1 ? '' : 's'} being tracked` })
                .setTimestamp();

            const msg = await message.reply({ embeds: [embed], components: [row] });

            const collector = msg.createMessageComponentCollector({
                componentType: ComponentType.StringSelect,
                time: 120_000,
            });

            collector.on('collect', async (i) => {
                const groupKeywords = i.values[0].split(',');
                const displayLabel = groupKeywords.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' | ');

                // Aggregate per-user totals across all keywords in the group
                const topUsers = await BuzzwordCount.aggregate([
                    { $match: { keyword: { $in: groupKeywords } } },
                    { $group: { _id: '$userId', count: { $sum: '$count' } } },
                    { $sort: { count: -1 } },
                    { $limit: 10 },
                ]);

                if (topUsers.length === 0) {
                    const emptyEmbed = new EmbedBuilder()
                        .setColor(0x95A5A6)
                        .setTitle(`📊 Buzzword: "${displayLabel}"`)
                        .setDescription('No one has said this word yet... how boring. (¬_¬)')
                        .setTimestamp();

                    return i.update({ embeds: [emptyEmbed], components: [row] });
                }

                const lines = await Promise.all(topUsers.map(async (entry, idx) => {
                    const name = await getShortName(entry._id);
                    const rank = idx === 0 ? '🥇' : (idx === 1 ? '🥈' : (idx === 2 ? '🥉' : `\`${String(idx + 1).padStart(2)}\``));
                    return `${rank} **${name}** — ${entry.count.toLocaleString('en-US')} time${entry.count === 1 ? '' : 's'}`;
                }));

                const totalAgg = await BuzzwordCount.aggregate([
                    { $match: { keyword: { $in: groupKeywords } } },
                    { $group: { _id: null, total: { $sum: '$count' }, users: { $addToSet: '$userId' } } },
                    { $project: { total: 1, userCount: { $size: '$users' } } },
                ]);
                const total = totalAgg[0]?.total || 0;
                const userCount = totalAgg[0]?.userCount || 0;

                const resultEmbed = new EmbedBuilder()
                    .setColor(0xE67E22)
                    .setTitle(`📊 Buzzword: "${displayLabel}"`)
                    .setDescription(lines.join('\n'))
                    .addFields(
                        { name: 'Total Uses', value: total.toLocaleString('en-US'), inline: true },
                        { name: 'Unique Users', value: userCount.toLocaleString('en-US'), inline: true },
                    )
                    .setFooter({ text: 'I-It\'s not like I\'m keeping tabs on you or anything! (¬_¬)' })
                    .setTimestamp();

                await i.update({ embeds: [resultEmbed], components: [row] });
            });

            collector.on('end', async () => {
                const disabledMenu = StringSelectMenuBuilder.from(selectMenu).setDisabled(true);
                const disabledRow = new ActionRowBuilder().addComponents(disabledMenu);
                await msg.edit({ components: [disabledRow] }).catch(() => {});
            });

            return;
        }

        // Default: If they just type `!leaderboard` or `!lb` with no args
        return message.reply("Usage:\n`!lb chats`\n`!lb chats alltime`\n`!lb rich`\n`!lb poor`\n`!lb overlord`\n`!lb hl`\n`!lb duel top`\n`!lb duel losers`\n`!lb buzz`\n`!lb fish`\n`!lb heavy`\n`!slave top`");
    }
};

