const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, StringSelectMenuBuilder } = require('discord.js');
const crypto = require('crypto');
const User = require('../models/User');
const config = require('../config');
const { distributeIncome } = require('../utils/income');
const { createCleaningMap } = require('../utils/helpers');
const fishTradeSystem = require('./fishTrade');

const activeGames = createCleaningMap(60000, 30000);
// activeGames prevents concurrent minigames and catch/sell race conditions
const activeReelButtons = createCleaningMap(15000, 5000);
const activeAutocastSessions = createCleaningMap(660000, 60000);
const GENERIC_FISHING_FALLBACK = "S-Something broke in fishing. Tch... try again in a moment, baka! >///<";
const STALE_FISHING_PANEL_FALLBACK = "That fishing panel went stale before I could update it. Use `!fish` (or `!fih`) again, slowpoke! (¬_¬)";

function isUnknownInteractionError(e) {
    return e?.code === 10062 || e?.code === 40060 || e?.rawError?.code === 10062 || e?.rawError?.code === 40060;
}

function buildInteractionPayload(content, ephemeral = true) {
    const payload = typeof content === 'string' ? { content } : { ...content };
    const wantsEphemeral = payload.ephemeral ?? ephemeral;
    if (payload.flags == null && wantsEphemeral) payload.flags = MessageFlags.Ephemeral;
    delete payload.ephemeral;
    return payload;
}

async function safeInteractionReply(interaction, content, ephemeral = true) {
    try {
        const payload = buildInteractionPayload(content, ephemeral);

        if (interaction.replied || interaction.deferred) {
            return await interaction.followUp(payload);
        }
        return await interaction.reply(payload);
    } catch (e) {
        if (!isUnknownInteractionError(e)) console.error("Fishing interaction reply failed:", e);
    }
}

async function safeDeferUpdate(interaction) {
    try {
        if (!interaction.replied && !interaction.deferred) await interaction.deferUpdate();
        return true;
    } catch (e) {
        if (!isUnknownInteractionError(e)) {
            console.error("Fishing interaction defer failed:", e);
            await safeInteractionReply(interaction, "I couldn't grab that fishing click. Try the command again, baka! (¬_¬)");
        }
        return false;
    }
}

async function safeInteractionUpdate(interaction, payload) {
    try {
        if (!interaction.replied && !interaction.deferred) await interaction.update(payload);
        else await interaction.editReply(payload);
        return true;
    } catch (e) {
        if (!isUnknownInteractionError(e)) {
            console.error("Fishing interaction update failed:", e);
            await safeInteractionReply(interaction, STALE_FISHING_PANEL_FALLBACK);
        }
        return false;
    }
}

async function safeMessageReply(message, content) {
    return message.reply({ content }).catch(e => {
        console.error("Fishing message reply failed:", e);
    });
}

async function sendFishingContextFallback(context, content) {
    if (context?.customId) return safeInteractionReply(context, content);
    if (context?.reply) return safeMessageReply(context, content);
}

function fishingErrorEmbed(author, description = GENERIC_FISHING_FALLBACK) {
    return new EmbedBuilder()
        .setColor(0xE74C3C)
        .setTitle("Fishing Broke!")
        .setThumbnail(author.displayAvatarURL({ dynamic: true }))
        .setDescription(description);
}

function getScalingValue(wealth, scaleTable) {
    let value = scaleTable[0].base || scaleTable[0].cost;
    for (const tier of scaleTable) {
        if (wealth >= tier.threshold) {
            value = tier.base || tier.cost;
        } else {
            break;
        }
    }
    return value;
}

function rollTable(table) {
    const totalWeight = Object.values(table).reduce((sum, entry) => sum + entry.chance, 0);
    let rand = Math.random() * totalWeight;
    for (const [tier, data] of Object.entries(table)) {
        rand -= data.chance;
        if (rand <= 0) return { tier, mult: data.mult };
    }
    return { tier: 'JUNK', mult: 0 };
}

async function getJunkName(guild) {
    const templates = config.FISHING.JUNK_TEMPLATES;
    const template = templates[Math.floor(Math.random() * templates.length)];
    
    try {
        const role = guild.roles.cache.find(r => r.name === config.ROLES.MEMBER);
        if (role && role.members.size > 0) {
            const randomMember = role.members.random();
            return `${randomMember.displayName}'s ${template}`;
        }
    } catch(e) {}
    return `Someone's ${template}`;
}

function getRandomSpecies(tier, biomeId = 'shallow_pond') {
    if (tier === 'JUNK') return "Garbage"; // Handled by getJunkName separately
    const biome = config.FISHING.BIOMES[biomeId] || config.FISHING.BIOMES['shallow_pond'];
    const list = biome.species[tier] || ["Unknown Fish"];
    return list[Math.floor(Math.random() * list.length)];
}

const RARITY_COLORS = {
    JUNK: 0x808080,
    COMMON: 0xAAAAAA,
    RARE: 0x3498DB,
    UR: 0x9B59B6,
    LEGENDARY: 0xE74C3C,
    MYTHIC: 0xF1C40F
};

function getRodInfo(rodId) {
    return config.FISHING.GEAR.RODS[rodId] || config.FISHING.GEAR.RODS.flimsy_stick;
}

function getBaitInfo(baitId) {
    return config.FISHING.GEAR.BAITS[baitId] || null;
}

async function normalizeFishingGear(userId) {
    // Bait exhaustion: reset active bait when count hits 0
    const baitUser = await User.findOne(
        { userId, 'fishing.gear.activeBait': { $ne: 'none' }, 'fishing.gear.baitCount': { $lte: 0 } }
    ).select('fishing.gear.activeBait').lean();
    if (baitUser) {
        const exhaustedBait = baitUser.fishing.gear.activeBait;
        await User.updateOne(
            { userId, 'fishing.gear.activeBait': exhaustedBait, 'fishing.gear.baitCount': { $lte: 0 } },
            {
                $set: { 'fishing.gear.activeBait': 'none', 'fishing.gear.baitCount': 0 },
                $unset: { [`fishing.gear.ownedBaits.${exhaustedBait}`]: '' }
            }
        );
    }
    // Rod break: save broken rod to ownedRods (0 durability, repairable) then switch to flimsy
    const brokenUser = await User.findOne(
        { userId, 'fishing.gear.activeRod': { $ne: 'flimsy_stick' }, 'fishing.gear.rodDurability': { $lte: 0 } }
    ).select('fishing.gear.activeRod').lean();
    if (brokenUser) {
        const brokenRod = brokenUser.fishing.gear.activeRod;
        await User.updateOne(
            { userId, 'fishing.gear.activeRod': brokenRod, 'fishing.gear.rodDurability': { $lte: 0 } },
            { $set: {
                'fishing.gear.activeRod': 'flimsy_stick',
                'fishing.gear.rodDurability': 0,
                [`fishing.gear.ownedRods.${brokenRod}`]: 0
            }}
        );
    }
}

function getInventoryCapacityFilter() {
    const maxInventory = config.FISHING.MAX_INVENTORY || 500;
    return { [`fishing.inventory.${maxInventory - 1}`]: { $exists: false } };
}

function fishFingerprint(fish) {
    return crypto
        .createHash('sha1')
        .update(`${fish.species || ''}|${fish.weight || 0}|${fish.rarity || ''}|${fish.value || 0}`)
        .digest('hex')
        .slice(0, 12);
}

function fishFieldFilter(index, fish) {
    return {
        [`fishing.inventory.${index}.species`]: fish.species,
        [`fishing.inventory.${index}.weight`]: fish.weight,
        [`fishing.inventory.${index}.rarity`]: fish.rarity,
        [`fishing.inventory.${index}.value`]: fish.value
    };
}

function getUserAutocastTier(user) {
    if (!user) return { tier: 0, reason: 'no_user' };
    
    const prestige = user.prestige || 0;
    const stats = user.fishing?.stats || {};
    const inventory = user.fishing?.inventory || [];
    const statsCaught = stats.totalCaught || 0;
    const invCount = inventory.length;
    const totalCaught = Math.max(statsCaught, invCount);
    
    // Backwards compatibility: calculate effective Rares & URs for legacy fishers
    const invRares = inventory.filter(f => f && f.rarity === 'RARE').length;
    const effectiveRares = Math.max(stats.raresCaught || 0, invRares, Math.floor(totalCaught * 0.10));
    
    const invUrs = inventory.filter(f => f && f.rarity === 'UR').length;
    const effectiveUrs = Math.max(stats.ursCaught || 0, invUrs, Math.floor(totalCaught * 0.03));
    
    // Check owned rods (Map or Object)
    const ownedRodsRaw = user.fishing?.gear?.ownedRods || {};
    const ownedRodsObj = ownedRodsRaw instanceof Map ? Object.fromEntries(ownedRodsRaw) : ownedRodsRaw;
    const activeRod = user.fishing?.gear?.activeRod || 'flimsy_stick';
    
    const hasRod = (rodId) => activeRod === rodId || ownedRodsObj[rodId] !== undefined;
    
    const tiers = config.FISHING.AUTOCAST.TIERS;
    
    // Check Tier 3: Prestige 7 + 2,500 Catches
    if (prestige >= tiers[3].UNLOCK_PRESTIGE && totalCaught >= tiers[3].UNLOCK_CATCHES) {
        return { tier: 3, info: tiers[3], effectiveRares, effectiveUrs, totalCaught, prestige };
    }
    
    // Check Tier 2: Prestige 5 OR (1,600 Catches + Deep Sea Rod + 10 URs)
    const t2Catches = totalCaught >= tiers[2].UNLOCK_CATCHES && effectiveUrs >= tiers[2].REQ_URS && hasRod(tiers[2].REQ_ROD);
    if (prestige >= tiers[2].UNLOCK_PRESTIGE || t2Catches) {
        return { tier: 2, info: tiers[2], effectiveRares, effectiveUrs, totalCaught, prestige };
    }
    
    // Check Tier 1: Prestige 3 OR (800 Catches + Carbon Rod + 25 Rares)
    const t1Catches = totalCaught >= tiers[1].UNLOCK_CATCHES && effectiveRares >= tiers[1].REQ_RARES && hasRod(tiers[1].REQ_ROD);
    if (prestige >= tiers[1].UNLOCK_PRESTIGE || t1Catches) {
        return { tier: 1, info: tiers[1], effectiveRares, effectiveUrs, totalCaught, prestige };
    }
    
    return { tier: 0, effectiveRares, effectiveUrs, totalCaught, prestige };
}

async function executeFishing(context, isCastAgain = false) {
    const isInteraction = !!context.customId;
    const author = isInteraction ? context.user : context.author;
    const authorId = author.id;
    
    let sub = '';
    let category = '';
    if (!isCastAgain && !isInteraction) {
        const args = context.content.split(' ');
        sub = args[1]?.toLowerCase();
        category = args[2]?.toUpperCase();
    }

    const replyMsg = async (opts) => {
        if (isInteraction) {
            opts.content = opts.content ? `<@${authorId}> ${opts.content}` : `<@${authorId}>`;
            return await context.channel.send(opts);
        } else {
            return await context.reply(opts);
        }
    };

    const validSubs = new Set(['charter', 'travel', 'inv', 'inventory', 'bag', 'repair', 'sell', 'bait', 'shop', 'quest', 'bounty', 'pin', 'unpin', 'trade', 'autocast']);
    if (sub && !validSubs.has(sub)) {
        return replyMsg({ content: `I don't know \`!fish ${sub}\`, baka! Use \`!fish\`, \`!fish travel\`, \`!fish bag\`, \`!fish sell all\`, \`!fish repair\`, \`!fish trade\`, \`!fish quest\`, or \`!fish autocast\`. (¬_¬)` });
    }

    if (sub === 'sell' || sub === 'inv' || sub === 'bag' || sub === 'quest' || sub === 'bounty' || sub === 'pin' || sub === 'unpin') {
        if ((sub === 'sell' || sub === 'pin' || sub === 'unpin') && activeGames.get(authorId)) {
            if (activeAutocastSessions.get(authorId)) {
                return replyMsg({ content: "Your rod is busy autocasting! Wait until the session finishes or stop it with `!fish autocast stop`, baka! (¬_¬)" });
            }
            return replyMsg({ content: "You're currently fishing! Finish reeling it in first, baka! (¬_¬)" });
        }
    } else if (sub === 'autocast') {
        // Autocast has its own lock logic inside executeAutocast — let it through
        // But block if a MANUAL minigame is active (not an autocast session)
        if (activeGames.get(authorId) && !activeAutocastSessions.get(authorId)) {
            return replyMsg({ content: "H-Hey! You already have your rod cast somewhere else! Finish that first, idiot! (¬_¬)" });
        }
    } else {
        if (activeGames.get(authorId)) {
            if (activeAutocastSessions.get(authorId)) {
                return replyMsg({ content: "Your rod is busy autocasting! Use `!fish autocast stop` to end it early, or wait for the summary. (¬_¬)" });
            }
            return replyMsg({ content: "H-Hey! You already have your rod cast somewhere else! Finish that first, idiot! (¬_¬)" });
        }
        // Lock immediately to prevent concurrent spam triggering multiple DB calls
        activeGames.set(authorId, true);
    }

    let user = await User.findOneAndUpdate(
        { userId: authorId },
        { $setOnInsert: { userId: authorId } },
        { upsert: true, returnDocument: 'after' }
    );
    user.fishing = user.fishing || {};

    if (sub === 'trade') {
        if (activeGames.get(authorId)) activeGames.delete(authorId); // release lock
        return fishTradeSystem.handle(context, context.client, user);
    }

    // --- QUESTS / BOUNTIES ---
    if (sub === 'quest' || sub === 'bounty') {
        let bounty = user.fishing?.dailyBounty;
        const totalCaught = user.fishing?.stats?.totalCaught || 0;
        
        // Generate new bounty if expired or doesn't exist
        if (!bounty || !bounty.targetBiome || bounty.expiresAt < Date.now()) {
            const biomes = Object.values(config.FISHING.BIOMES).filter(b => totalCaught >= b.reqCatches);
            const biome = biomes[Math.floor(Math.random() * biomes.length)];
            
            const tiers = Object.entries(config.FISHING.BOUNTIES.TIERS);
            const [tierName, tierData] = tiers[Math.floor(Math.random() * tiers.length)];
            
            const targetRarity = tierData.targetRarities[Math.floor(Math.random() * tierData.targetRarities.length)];
            const amountNeeded = Math.floor(Math.random() * (tierData.amountRange[1] - tierData.amountRange[0] + 1)) + tierData.amountRange[0];
            
            bounty = {
                targetBiome: biome.id,
                targetRarity,
                amountNeeded,
                amountCaught: 0,
                rewardTier: tierName,
                expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
                claimed: false
            };
            
            await User.updateOne(
                { userId: user.userId },
                { $set: { 'fishing.dailyBounty': bounty } }
            );
        }
        
        if (bounty.claimed) {
            const timeLeft = Math.max(0, bounty.expiresAt - Date.now());
            const hoursLeft = Math.floor(timeLeft / 3600000);
            const minsLeft = Math.floor((timeLeft % 3600000) / 60000);
            const embed = new EmbedBuilder()
                .setColor(0x2ECC71)
                .setTitle(`📜 Fishing Bounty — Complete!`)
                .setThumbnail(author.displayAvatarURL({ dynamic: true }))
                .setDescription(`You've already claimed your daily bounty! Come back in **${hoursLeft}h ${minsLeft}m** for a new one, baka! (¬_¬)`);
            return replyMsg({ embeds: [embed] });
        }

        const biomeInfo = config.FISHING.BIOMES[bounty.targetBiome] || config.FISHING.BIOMES.shallow_pond;
        const isComplete = bounty.amountCaught >= bounty.amountNeeded;
        const timeLeft = Math.max(0, bounty.expiresAt - Date.now());
        const hoursLeft = Math.floor(timeLeft / 3600000);
        const minsLeft = Math.floor((timeLeft % 3600000) / 60000);
        
        const tierData = config.FISHING.BOUNTIES.TIERS[bounty.rewardTier];
        const difficultyLabel = { EASY: '🟢 Easy', MEDIUM: '🟡 Medium', HARD: '🔴 Hard' }[bounty.rewardTier] || bounty.rewardTier;
        let rewardStr = `**${tierData.rewardMultipliers.baseCoinMult}x** coin reward`;
        if (tierData.rewardMultipliers.nuggets) rewardStr += ` + **${tierData.rewardMultipliers.nuggets}** 💎 Nugget${tierData.rewardMultipliers.nuggets > 1 ? 's' : ''}`;
        if (tierData.rewardMultipliers.nuggetChance) rewardStr += ` + **${tierData.rewardMultipliers.nuggetChance}%** chance for 💎 Nugget`;

        const embed = new EmbedBuilder()
            .setColor(isComplete ? 0x2ECC71 : 0xE67E22)
            .setTitle(`📜 Fishing Bounty — ${difficultyLabel}`)
            .setThumbnail(author.displayAvatarURL({ dynamic: true }))
            .setDescription(`**Target:** Catch **${bounty.amountNeeded}x ${config.FISHING.EMOJIS[bounty.targetRarity] || ''} ${bounty.targetRarity}** fish in the **${biomeInfo.emoji} ${biomeInfo.name}**\n\n` +
                            `**Progress:** ${bounty.amountCaught} / ${bounty.amountNeeded}\n` +
                            `**Reward:** ${rewardStr}\n` +
                            `**Time Left:** ${hoursLeft}h ${minsLeft}m\n\n` +
                            (isComplete ? `*You actually finished it?! Claim your reward before I change my mind! (¬_¬)*` : `*Hurry up and catch them, idiot! (¬_¬)*`));
                            
        const components = [];
        if (isComplete) {
            components.push(
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`fish_bounty_claim_${authorId}`)
                        .setLabel('Claim Reward')
                        .setStyle(ButtonStyle.Success)
                        .setEmoji('🎁')
                )
            );
        }
        
        return replyMsg({ embeds: [embed], components });
    }

    // --- TRAVEL ---
    if (sub === 'travel') {
        if (activeAutocastSessions.get(authorId)) {
            return replyMsg({ content: "Can't travel while your rod is busy autocasting, baka! Stop the session first! (¬_¬)" });
        }
        // activeGames is kept locked until travel select is processed or timed out.
        const biomes = Object.values(config.FISHING.BIOMES);
        const activeRodId = user.fishing?.gear?.activeRod || 'flimsy_stick';
        const activeRodInfo = getRodInfo(activeRodId);
        const activeRodCost = activeRodInfo.cost;
        const totalCaught = user.fishing?.stats?.totalCaught || 0;

        const options = biomes.map(b => {
            const hasCatches = totalCaught >= b.reqCatches;
            const reqRodInfo = b.reqRod ? getRodInfo(b.reqRod) : config.FISHING.GEAR.RODS.flimsy_stick;
            const reqRodCost = reqRodInfo.cost;
            const hasRod = activeRodCost >= reqRodCost;
            const unlocked = hasCatches && hasRod;
            
            const scaledCost = Math.floor(Math.min(b.travelCostMax || Infinity, b.travelCost + (user.coins || 0) * (b.travelCostWalletRate || 0)));
            const costStr = scaledCost > 0 ? ` [${scaledCost.toLocaleString('en-US')}c]` : ` [Free]`;
            
            let lockReason = "";
            if (!hasCatches) lockReason += `Req: ${b.reqCatches} catches. `;
            if (!hasRod) lockReason += `Req: ${reqRodInfo.name}.`;

            return {
                label: b.name + costStr,
                description: unlocked ? b.description.substring(0, 100) : `LOCKED: ${lockReason}`.substring(0, 100),
                value: `biome_${b.id}`,
                emoji: b.emoji
            };
        });
        
        const menu = new StringSelectMenuBuilder()
            .setCustomId(`fish_travel_${authorId}`)
            .setPlaceholder("Select a Biome to travel to")
            .addOptions(options);
            
        const embed = new EmbedBuilder()
            .setColor(0x3498DB)
            .setTitle("🗺️ Fishing Map")
            .setThumbnail(author.displayAvatarURL({ dynamic: true }))
            .setDescription(`You have caught **${totalCaught}** total fish.\nSelect a destination, idiot! Some places are too dangerous for novices. (¬_¬)`);
            
        return replyMsg({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] });
    }

    // --- INVENTORY ---
    if (sub === 'inv' || sub === 'inventory' || sub === 'bag') {
        activeGames.delete(authorId);
        return handleBag(context, null, user);
    }

    // --- REPAIR ---
    if (sub === 'repair') {
        if (activeAutocastSessions.get(authorId)) {
            return replyMsg({ content: "Your rod is in the water autocasting, idiot! Stop the session first before repairing! (¬_¬)" });
        }
        try {
            let targetRodId = user.fishing?.gear?.activeRod || 'flimsy_stick';
            const args = context.content ? context.content.split(' ') : [];
            const specifiedRod = args[2]?.toLowerCase();
            
            if (specifiedRod && config.FISHING.GEAR.RODS[specifiedRod]) {
                targetRodId = specifiedRod;
            } else if (targetRodId === 'flimsy_stick') {
                // Find first owned rod that needs repair (durability < max)
                const ownedRodsRaw1 = user.fishing?.gear?.ownedRods || {};
                const ownedRodsObj1 = ownedRodsRaw1 instanceof Map ? Object.fromEntries(ownedRodsRaw1) : ownedRodsRaw1;
                const repairableRod = Object.entries(ownedRodsObj1).find(([rid, dur]) => {
                    const rConf = config.FISHING.GEAR.RODS[rid];
                    return rConf && dur < rConf.maxDurability;
                });
                if (repairableRod) {
                    targetRodId = repairableRod[0];
                }
            }

            const rodInfo = config.FISHING.GEAR.RODS[targetRodId];
            if (!rodInfo || targetRodId === 'flimsy_stick') {
                return replyMsg({ content: "You're using a Flimsy Stick. It's literally just a stick, it doesn't break! Buy a real rod first! (¬_¬)" });
            }

            // Check ownership
            const isEquipped = targetRodId === (user.fishing?.gear?.activeRod || 'flimsy_stick');
            const ownedRodsRaw2 = user.fishing?.gear?.ownedRods || {};
            const ownedRodsObj2 = ownedRodsRaw2 instanceof Map ? Object.fromEntries(ownedRodsRaw2) : ownedRodsRaw2;
            const isOwned = isEquipped || ownedRodsObj2[targetRodId] !== undefined;
            
            if (!isOwned) {
                return replyMsg({ content: `You don't even own a **${rodInfo.name}**, idiot! How do you expect to repair it?! (¬_¬)` });
            }

            let dur = isEquipped ? (user.fishing?.gear?.rodDurability || 0) : (ownedRodsObj2[targetRodId] ?? 0);

            if (dur >= rodInfo.maxDurability) {
                return replyMsg({ content: `Your ${rodInfo.name} is already in perfect condition, idiot! Stop wasting my time! (¬_¬)` });
            }

            if ((user.nuggets || 0) < rodInfo.repairCost) {
                return replyMsg({ content: `🚫 You need **${rodInfo.repairCost} Nuggets** to repair your ${rodInfo.name}! You only have ${user.nuggets || 0}. Get back to work! (¬_¬)` });
            }

            const filterQuery = {
                userId: authorId,
                nuggets: { $gte: rodInfo.repairCost }
            };
            const updateFields = {
                $inc: { nuggets: -rodInfo.repairCost },
                $set: { [`fishing.gear.ownedRods.${targetRodId}`]: rodInfo.maxDurability }
            };

            if (isEquipped) {
                filterQuery['fishing.gear.activeRod'] = targetRodId;
                filterQuery['fishing.gear.rodDurability'] = { $lt: rodInfo.maxDurability };
                updateFields.$set['fishing.gear.rodDurability'] = rodInfo.maxDurability;
            } else {
                filterQuery[`fishing.gear.ownedRods.${targetRodId}`] = { $lt: rodInfo.maxDurability };
            }

            const updateRes = await User.findOneAndUpdate(filterQuery, updateFields, { returnDocument: 'after' });

            if (!updateRes) {
                return replyMsg({ content: "Transaction failed! Make sure you still have enough nuggets and the rod durability isn't already full! (¬_¬)" });
            }

            return replyMsg({ content: `🛠️ Paid **${rodInfo.repairCost} Nuggets** to repair your ${rodInfo.emoji} **${rodInfo.name}**! It's back to ${rodInfo.maxDurability} durability! Don't break it again! (¬_¬)` });
        } finally {
            activeGames.delete(authorId);
        }
    }

    // --- PIN / UNPIN ---
    // No activeGames lock needed: gate at line 231 already rejects during active fishing,
    // and these are single atomic $set operations with no multi-step state to protect.
    if (sub === 'pin' || sub === 'unpin') {
        const args = context.content ? context.content.split(' ') : [];
        const indexArg = args[2];
        const selectedIndex = parseInt(indexArg) - 1; // 1-indexed for users
        
        if (isNaN(selectedIndex) || selectedIndex < 0) {
            return replyMsg({ content: `Ugh! Specify a valid fish number from your bucket, baka! e.g., \`!fish ${sub} 3\` (¬_¬)` });
        }
        
        const inventory = user.fishing?.inventory || [];
        if (inventory.length === 0) {
            return replyMsg({ content: "Your bucket is empty! There's nothing to pin/unpin, baka! (¬_¬)" });
        }
        
        if (selectedIndex >= inventory.length) {
            return replyMsg({ content: `You only have **${inventory.length}** fishes in your bucket, baka! (¬_¬)` });
        }
        
        const f = inventory[selectedIndex];
        const pinName = `[${f.rarity}] ${f.species} — ${f.weight} lbs`;
        let pinned = user.fishing?.pinned || [];
        
        if (sub === 'pin') {
            if (pinned.includes(pinName)) {
                return replyMsg({ content: `That fish is already pinned on your profile, baka! (¬_¬)` });
            }
            if (pinned.length >= 5) {
                return replyMsg({ content: "You can only pin up to 5 fishes! Unpin one first! (¬_¬)" });
            }
            pinned.push(pinName);
            await User.updateOne({ userId: authorId }, { $set: { "fishing.pinned": pinned } });
            return replyMsg({ content: `📌 Pinned **${f.species}** (${f.weight} lbs) to your profile! (¬_¬)` });
        } else {
            if (!pinned.includes(pinName)) {
                const indexInPinned = pinned.findIndex(p => p.includes(f.species));
                if (indexInPinned === -1) {
                    return replyMsg({ content: "That fish isn't pinned, baka! (¬_¬)" });
                }
                pinned.splice(indexInPinned, 1);
            } else {
                pinned = pinned.filter(p => p !== pinName);
            }
            await User.updateOne({ userId: authorId }, { $set: { "fishing.pinned": pinned } });
            return replyMsg({ content: `🔓 Unpinned **${f.species}** from your profile! (¬_¬)` });
        }
    }

    // --- SELL ---
    if (sub === 'sell') {
        if (!category || !['ALL', 'JUNK', 'COMMON', 'RARE', 'UR', 'LEGENDARY', 'MYTHIC'].includes(category)) {
            return replyMsg({ content: "Ugh, you can't even sell properly?! Use `!fish sell all` (or `!fih sell all`) or `!fish sell [junk|common|rare|ur|legendary|mythic]`! (¬_¬)" });
        }
        
        // activeGames check already handled above, now we lock for selling
        activeGames.set(authorId, true);
        try {
            const pullQuery = category === 'ALL'
                ? { locked: { $ne: true } }
                : { rarity: category, locked: { $ne: true } };

            const freshUser = await User.findOneAndUpdate(
                { userId: authorId },
                { $pull: { 'fishing.inventory': pullQuery } },
                { new: false }
            );

            let inv = freshUser?.fishing?.inventory || [];
            if (inv.length === 0) {
                activeGames.delete(authorId);
                return replyMsg({ content: "You have nothing to sell! Pathetic. (¬_¬)" });
            }
            
            let totalValue = 0;
            let soldCount = 0;
            const soldFish = [];
            
            for (const fish of inv) {
                if ((category === 'ALL' || fish.rarity === category) && !fish.locked) {
                    totalValue += (fish.value || 0);
                    soldCount++;
                    soldFish.push({
                        species: fish.species,
                        weight: fish.weight,
                        rarity: fish.rarity,
                        value: fish.value,
                        locked: !!fish.locked
                    });
                }
            }
            
            if (soldCount === 0) {
                activeGames.delete(authorId);
                return replyMsg({ content: `You don't have any ${category} fish to sell! Are you blind?! (¬_¬)` });
            }

            // Route through distributeIncome
            let log = "";
            try {
                log = await distributeIncome(freshUser.userId, totalValue);
            } catch (e) {
                let restored = true;
                try {
                    await User.updateOne(
                        { userId: freshUser.userId },
                        { $push: { 'fishing.inventory': { $each: soldFish } } }
                    );
                } catch (err) {
                    restored = false;
                    console.error("Sell rollback failed:", err);
                }
                activeGames.delete(authorId);
                console.error("Sell payout failed:", e);
                return replyMsg({
                    content: restored
                        ? "S-Something broke while paying you, so I put the fish back. Try again in a moment! >///<"
                        : "S-Something broke while paying you, and I couldn't confirm the fish rollback. Tell an admin before selling again, baka! >///<"
                });
            }
            activeGames.delete(authorId);
            return replyMsg({ content: `Sold **${soldCount}** fish for a base value of **${totalValue.toLocaleString('en-US')}** coins! 🐟\n${log}` });
        } catch (e) {
            activeGames.delete(authorId);
            console.error("Sell error:", e);
            return replyMsg({ content: "S-Something broke! I didn't steal your fish, I swear! >///< " });
        }
    }

    // --- DEPRECATED ALIASES ---
    if (sub === 'bait' || sub === 'shop') {
        activeGames.delete(authorId);
        return replyMsg({ content: "The old bait shop is closed! Use `!shop` to buy fishing gear and baits now! (¬_¬)" });
    }

    // --- AUTOCAST ---
    if (sub === 'autocast') {
        const args = context.content ? context.content.trim().split(/\s+/) : [];
        const autoSub = args[2]?.toLowerCase();

        if (autoSub === 'stop') {
            const session = activeAutocastSessions.get(authorId);
            if (!session) {
                return replyMsg({ content: "You don't have an active autocast session to stop, baka! (¬_¬)" });
            }
            session.stopped = true;
            if (!session.processing && typeof session.runCatch === 'function') {
                session.runCatch();
            }
            return replyMsg({ content: "Stopped your autocast session! Reeling in your line now... (¬_¬)" });
        }

        if (autoSub === 'status') {
            const freshUser = await User.findOne({ userId: authorId }).select('fishing prestige').lean();
            const tierCheck = getUserAutocastTier(freshUser);
            if (tierCheck.tier === 0) {
                return replyMsg({ content: "You haven't unlocked Autocast yet, baka! Reach **Prestige 3** or **800 catches** with a Carbon Rod first! (¬_¬)" });
            }
            const dailyCap = tierCheck.info.DAILY_CAP;
            const session = activeAutocastSessions.get(authorId);
            if (!session) {
                const ac = freshUser?.fishing?.autocast || {};
                const today = new Date(); today.setUTCHours(0, 0, 0, 0);
                const sessionsUsed = (ac.lastSessionReset || 0) >= today.getTime() ? (ac.sessionsToday || 0) : 0;
                const nextCost = tierCheck.info.COST_NUGGETS_ARRAY[sessionsUsed] ?? 1;
                const costNote = sessionsUsed < dailyCap ? (nextCost === 0 ? "Next run: **Free**" : `Next run: **${nextCost} Nugget**`) : "Daily limit reached";
                return replyMsg({ content: `📊 **Autocast Status (${tierCheck.info.NAME}):** No active session.\nSessions today: **${sessionsUsed}/${dailyCap}** used. (${costNote}) (¬_¬)` });
            }
            const remaining = Math.max(0, Math.ceil((session.endsAt - Date.now()) / 1000));
            const mins = Math.floor(remaining / 60);
            const secs = remaining % 60;
            return replyMsg({ content: `📊 **Autocast Status (${session.tierInfo.NAME}):** Running! **${mins}:${secs.toString().padStart(2, '0')}** remaining. ${session.catches.length} fish caught so far. (¬_¬)` });
        }

        if (autoSub === 'help') {
            const freshUser = await User.findOne({ userId: authorId }).select('fishing prestige').lean();
            const tierCheck = getUserAutocastTier(freshUser);
            let statusLine = "You haven't unlocked a thing! Go fish manually like a normal person first! (¬_¬)";
            if (tierCheck.tier === 3) {
                statusLine = "Look at you, flexing **Tier 3: Abyssal Dredger**! D-Don't let it get to your head, baka! >///<";
            } else if (tierCheck.tier === 2) {
                statusLine = "You've got **Tier 2: Steam-Powered Reel** running! Not completely hopeless after all... (¬_¬)";
            } else if (tierCheck.tier === 1) {
                statusLine = "Clanking along with **Tier 1: Clockwork Spool**. Keep grinding, rookie! (¬_¬)";
            }

            const helpEmbed = new EmbedBuilder()
                .setColor(0x9B59B6)
                .setTitle("🤖 Autocast System (Tiered AFK Fishing)")
                .setDescription(
                    `*Too lazy to reel fish yourself? Set up automated spools!* (¬_¬)\n\n` +
                    `📊 **Your Status:** ${statusLine}\n\n` +
                    `⚙️ **Tier 1: Clockwork Spool** *(Entry-level automated crank)*\n` +
                    `> • **Unlock:** Prestige 3 OR (800 catches + Carbon Rod + 25 Rares)\n` +
                    `> • **Session:** 5 min (30 casts) | Durability shield: Max -8 loss\n` +
                    `> • **Daily Limit:** 1 run/day (**FREE**)\n\n` +
                    `⚙️ **Tier 2: Steam-Powered Reel** *(Heavy-duty pressurized spool)*\n` +
                    `> • **Unlock:** Prestige 5 OR (1,600 catches + Deep Sea Rod + 10 URs)\n` +
                    `> • **Session:** 8 min (48 casts) | Durability shield: Max -15 loss\n` +
                    `> • **Daily Limit:** 2 runs/day (1st run: **FREE**, 2nd: **1 Nugget**)\n\n` +
                    `⚙️ **Tier 3: Abyssal Dredger** *(Industrial deep-sea powerhouse)*\n` +
                    `> • **Unlock:** Prestige 7 + 2,500 catches + Abyssal Rod\n` +
                    `> • **Session:** 10 min (60 casts) | Full depth & normal wear\n` +
                    `> • **Daily Limit:** 3 runs/day (1st run: **FREE**, 2nd & 3rd: **1 Nugget**)\n\n` +
                    `🕹️ **Autocast Commands:**\n` +
                    `> • \`!fish autocast\` — Start your session (**1st run daily is 100% FREE!**)\n` +
                    `> • \`!fish autocast status\` — Check remaining time & daily runs left\n` +
                    `> • \`!fish autocast stop\` — Reel in early & keep whatever you caught\n` +
                    `> • \`!fish autocast tuneup\` — View Forge blueprints & material stockpiles\n` +
                    `> • \`!fish autocast buy <upgrade>\` — Forge a permanent machine upgrade\n` +
                    `> • \`!fish autocast help\` — View this guide`
                )
                .setFooter({ text: "Flimsy Sticks are BANNED! Hook a motor to a twig and I'll snap it myself, baka! (¬_¬)" });
            return replyMsg({ embeds: [helpEmbed] });
        }

        if (autoSub === 'tuneup' || autoSub === 'tuneups' || autoSub === 'upgrades') {
            return handleAutocastTuneupMenu(context);
        }

        if (autoSub === 'buy') {
            return handleAutocastBuy(context, args);
        }

        if (autoSub && autoSub !== 'start') {
            return replyMsg({ content: `I don't know \`!fish autocast ${autoSub}\`, baka! Use \`!fish autocast\`, \`!fish autocast status\`, \`!fish autocast stop\`, \`!fish autocast tuneup\`, or \`!fish autocast help\`. (¬_¬)` });
        }

        // --- ACTIVATION ---
        return executeAutocast(context, context.client || context.guild?.client);
    }

    // --- CORE MINIGAME VARS ---
    let isCharter = sub === 'charter';

    // --- GEAR & BIOME CHECK ---
    let activeRodId = user.fishing?.gear?.activeRod || 'flimsy_stick';
    let rodInfo = getRodInfo(activeRodId);
    if (!config.FISHING.GEAR.RODS[activeRodId]) {
        await User.updateOne(
            { userId: authorId },
            { $set: { 'fishing.gear.activeRod': 'flimsy_stick', 'fishing.gear.rodDurability': 0 } }
        );
        activeRodId = 'flimsy_stick';
        rodInfo = config.FISHING.GEAR.RODS.flimsy_stick;
        replyMsg({ content: "Your saved rod was corrupted, so I gave you a Flimsy Stick. Tch, maintenance is annoying! (¬_¬)" }).catch(()=>{});
    }
    
    let userBiomeId = user.fishing?.biome || 'shallow_pond';
    const biomeInfo = config.FISHING.BIOMES[userBiomeId] || config.FISHING.BIOMES.shallow_pond;
    
    if (activeRodId !== 'flimsy_stick' && (user.fishing?.gear?.rodDurability || 0) <= 0) {
        await User.updateOne({ userId: authorId }, { $set: { 'fishing.gear.activeRod': 'flimsy_stick' } });
        activeRodId = 'flimsy_stick';
        rodInfo = config.FISHING.GEAR.RODS.flimsy_stick;
        replyMsg({ content: `⚠️ Your fishing rod broke! I've given you a Flimsy Stick for now. (¬_¬)` }).catch(()=>{});
    }

    let activeBaitId = user.fishing?.gear?.activeBait;
    let baitInfo = null;
    let hasBait = false;

    // Migration: if activeBait+baitCount exist but ownedBaits is empty, migrate
    const ownedBaits = user.fishing?.gear?.ownedBaits;
    const ownedBaitsEmpty = !ownedBaits || (ownedBaits instanceof Map ? ownedBaits.size === 0 : Object.keys(ownedBaits).length === 0);
    if (activeBaitId && activeBaitId !== 'none' && (user.fishing?.gear?.baitCount || 0) > 0 && ownedBaitsEmpty) {
        await User.updateOne(
            { userId: authorId, 'fishing.gear.activeBait': activeBaitId, 'fishing.gear.baitCount': { $gt: 0 } },
            { $set: { [`fishing.gear.ownedBaits.${activeBaitId}`]: user.fishing.gear.baitCount } }
        );
    }

    if (activeBaitId && activeBaitId !== 'none' && !isCharter) {
        if ((user.fishing?.gear?.baitCount || 0) > 0) {
            baitInfo = getBaitInfo(activeBaitId);
            if (baitInfo) {
                hasBait = true;
            } else {
                await User.updateOne(
                    { userId: authorId },
                    {
                        $set: { 'fishing.gear.activeBait': 'none', 'fishing.gear.baitCount': 0 },
                        $unset: { [`fishing.gear.ownedBaits.${activeBaitId}`]: '' }
                    }
                );
                activeBaitId = 'none';
            }
        } else {
            // Reset bait status in DB since they're out
            await User.updateOne(
                { userId: authorId },
                {
                    $set: { 'fishing.gear.activeBait': 'none', 'fishing.gear.baitCount': 0 },
                    $unset: { [`fishing.gear.ownedBaits.${activeBaitId}`]: '' }
                }
            );
            activeBaitId = 'none';
        }
    }
    
    // Cooldown checks
    const now = Date.now();
    if (isCharter) {
        if (user.fishing.charterCooldown > now) {
            activeGames.delete(authorId);
            const left = Math.ceil((user.fishing.charterCooldown - now) / 60000);
            return replyMsg({ content: `Tch! The charter boat is refueling! Wait **${left} minutes**, rich boy! (¬_¬)` });
        }
    } else {
        if (user.fishing.cooldown > now) {
            activeGames.delete(authorId);
            const left = Math.ceil((user.fishing.cooldown - now) / 1000);
            return replyMsg({ content: `Your rod is tangled! Wait **${left} seconds** before casting again! (¬_¬)` });
        }
    }

    // Inventory Capacity Check
    const invLen = user.fishing.inventory?.length || 0;
    if (invLen >= (config.FISHING.MAX_INVENTORY || 500)) {
        activeGames.delete(authorId);
        return replyMsg({ content: `Your bucket is overflowing with ${invLen} fish! Use \`!fish sell all\` to clear it before you drop everything! (¬_¬)` });
    }

    // Costs
    let charterCost = 0;
    if (isCharter) {
        charterCost = getScalingValue(user.coins || 0, config.FISHING.CHARTER_COST_SCALE);
        if (user.coins < charterCost) {
            activeGames.delete(authorId);
            return replyMsg({ content: `You need **${charterCost.toLocaleString('en-US')}** coins for a charter! Stop wasting my time! (¬_¬)` });
        }
    }


    // Deduct costs & set cooldown atomically BEFORE game starts
    if (isCharter) {
        const deduct = await User.findOneAndUpdate(
            {
                userId: user.userId,
                coins: { $gte: charterCost },
                $or: [
                    { 'fishing.charterCooldown': { $lte: now } },
                    { 'fishing.charterCooldown': { $exists: false } }
                ]
            },
            { 
                $inc: { coins: -charterCost, systemSpent: charterCost },
                $set: { 'fishing.charterCooldown': now + config.FISHING.CHARTER_COOLDOWN_MS }
            },
            { returnDocument: 'after' }
        );
        if (!deduct) {
            activeGames.delete(authorId);
            return replyMsg({ content: "You can't afford that anymore! Did you spend it while talking to me?! (¬_¬)" });
        }
    } else {
        const cooldownSet = await User.findOneAndUpdate(
            {
                userId: user.userId,
                $or: [
                    { 'fishing.cooldown': { $lte: now } },
                    { 'fishing.cooldown': { $exists: false } }
                ]
            },
            { $set: { 'fishing.cooldown': now + config.FISHING.COOLDOWN_MS } }
        );
        if (!cooldownSet) {
            activeGames.delete(authorId);
            return replyMsg({ content: "Your rod is still tangled! Stop trying to sneak past the cooldown, baka! (¬_¬)" });
        }
    }

    const embed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle(isCharter ? "🚢 Deep Sea Charter" : (hasBait ? "🪱 Premium Fishing" : "🎣 Casting Line..."))
        .setThumbnail(author.displayAvatarURL({ dynamic: true }))
        .setDescription(`Using: **${rodInfo.emoji} ${rodInfo.name}**\nBait: **${hasBait ? `${baitInfo.emoji} ${baitInfo.name} (${Math.max(0, (user.fishing?.gear?.baitCount || 0) - 1)} left)` : 'None'}**\n\nWaiting for a bite... *Don't take your eyes off the float!* (¬_¬)`);

    let msg;
    try {
        msg = await replyMsg({ embeds: [embed] });
    } catch (e) {
        activeGames.delete(authorId);
        console.error("Fishing initial reply failed:", e);
        if (isInteraction) {
            await safeInteractionReply(context, GENERIC_FISHING_FALLBACK);
        } else {
            await safeMessageReply(context, GENERIC_FISHING_FALLBACK);
        }
        return;
    }

    // Random wait time
    const waitTime = Math.floor(Math.random() * (config.FISHING.MINIGAME_TIMEOUT_MAX - config.FISHING.MINIGAME_TIMEOUT_MIN)) + config.FISHING.MINIGAME_TIMEOUT_MIN;
    
    setTimeout(async () => {
        const buttonId = `fish_${authorId}_${Date.now()}`;
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(buttonId)
                .setLabel("REEL IT IN!")
                .setStyle(ButtonStyle.Danger)
        );

        const biteEmbed = new EmbedBuilder()
            .setColor(0xE74C3C)
            .setTitle("❗ BITE! ❗")
            .setThumbnail(author.displayAvatarURL({ dynamic: true }))
            .setDescription("**CLICK THE BUTTON NOW! HURRY UP!** >///<");

        let biteTime = Date.now();
        const biteShown = await msg.edit({ embeds: [biteEmbed], components: [row] }).then(m => {
            biteTime = m.editedTimestamp || Date.now();
            return true;
        }).catch(e => {
            console.error("Fishing bite prompt failed:", e);
            return false;
        });
        if (!biteShown) {
            activeGames.delete(authorId);
            await replyMsg({ content: "The fishing button broke before I could show it. Try casting again, baka! (¬_¬)" }).catch(err => {
                console.error("Fishing bite fallback failed:", err);
            });
            return;
        }
        activeReelButtons.set(buttonId, { authorId, expiresAt: Date.now() + 5000 });

        try {
            const reactionInteraction = await msg.awaitMessageComponent({
                filter: i => {
                    if (i.user.id !== authorId) {
                        safeInteractionReply(i, "This isn't your rod! Keep your hands off! (¬_¬)");
                        return false;
                    }
                    return i.customId === buttonId;
                },
                time: 5000 // Increased to 5 seconds for speed bonuses
            });
            
            const clickTime = reactionInteraction.createdTimestamp || Date.now();
            activeReelButtons.delete(buttonId);
            const acknowledged = await safeDeferUpdate(reactionInteraction);
            if (!acknowledged) {
                activeGames.delete(authorId);
                await msg.edit({ components: [] }).catch(err => {
                    console.error("Fishing stale component cleanup failed:", err);
                });
                return;
            }

            let reactionTimeMs = clickTime - biteTime;
            if (reactionTimeMs < 1) reactionTimeMs = 1;

            // Calculate Speed Bonus
            let speedMult = 1.0;
            let speedTitle = "";
            let speedColor = 0x2ECC71; // Green
            
            if (reactionTimeMs <= 1000) {
                speedMult = 1.5;
                speedTitle = `⚡ Lightning Fast! (+50% Reward) [${(reactionTimeMs/1000).toFixed(2)}s]`;
                speedColor = 0xF1C40F; // Gold
            } else if (reactionTimeMs <= 2500) {
                speedMult = 1.0;
                speedTitle = `🎯 Good Catch! [${(reactionTimeMs/1000).toFixed(2)}s]`;
            } else if (reactionTimeMs <= 4000) {
                speedMult = 0.6;
                speedTitle = `🐌 Barely Hooked... (-40% Reward) [${(reactionTimeMs/1000).toFixed(2)}s]`;
                speedColor = 0xE67E22; // Orange
            } else {
                speedMult = 0.3;
                speedTitle = `🐢 Almost Escaped... (-70% Reward) [${(reactionTimeMs/1000).toFixed(2)}s]`;
                speedColor = 0xE74C3C; // Red
            }

            // Create "Cast Again" button (Only for standard fishing)
            const castAgainComponents = [];
            if (!isCharter && (!hasBait || activeBaitId !== 'golden_worm')) {
                castAgainComponents.push(
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`fish_again_${authorId}`)
                            .setLabel("🎣 Cast Again")
                            .setStyle(ButtonStyle.Primary)
                    )
                );
            }

            // Calculate drop
            let table;
            
            if (isCharter) {
                table = structuredClone(config.FISHING.CHARTER_DROP);
            } else if (baitInfo && activeBaitId === 'golden_worm') {
                table = { LEGENDARY: { chance: 90, mult: 50 }, MYTHIC: { chance: 10, mult: 250 } };
            } else {
                table = structuredClone(config.FISHING.STANDARD_DROP);
            }

            // Apply biome drop modifiers
            if (!isCharter && biomeInfo.dropMods) {
                for (const t of Object.keys(biomeInfo.dropMods)) {
                    if (biomeInfo.dropMods[t] !== 0) {
                        // For golden worm, don't add lower tiers that would break "Guarantees UR+" promise
                        if (baitInfo && activeBaitId === 'golden_worm') {
                            if (!table[t]) continue;
                        }

                        if (!table[t]) {
                            // Find default multiplier from config if adding a new tier
                            let defaultMult = config.FISHING.STANDARD_DROP[t]?.mult || config.FISHING.CHARTER_DROP[t]?.mult || 1;
                            table[t] = { chance: 0, mult: defaultMult };
                        }
                        table[t].chance = Math.max(0, table[t].chance + biomeInfo.dropMods[t]);
                    }
                }
            }

            // Apply standard bait modifiers
            if (!isCharter && baitInfo && activeBaitId !== 'golden_worm') {
                if (activeBaitId === 'worm') {
                    if (table.COMMON) table.COMMON.chance -= 5; 
                    if (table.JUNK) table.JUNK.chance -= 5;
                    if (table.RARE) table.RARE.chance += 5; 
                    if (table.UR) table.UR.chance += 3; 
                    if (table.LEGENDARY) table.LEGENDARY.chance += 2;
                } else if (activeBaitId === 'glow_worm') {
                    if (table.COMMON) table.COMMON.chance -= 15; 
                    if (table.JUNK) table.JUNK.chance -= 10;
                    if (table.RARE) table.RARE.chance += 10; 
                    if (table.UR) table.UR.chance += 10; 
                    if (table.LEGENDARY) table.LEGENDARY.chance += 5;
                }
            }

            // Normalize negative chances to 0
            for (const t of Object.keys(table)) {
                if (table[t].chance < 0) table[t].chance = 0;
            }

            const roll = rollTable(table);
            const icon = config.FISHING.EMOJIS[roll.tier] || '🐟';
            
            if (roll.tier === 'JUNK') {
                const junkName = await getJunkName(msg.guild);
                const value = Math.floor(Math.random() * 10) + 1; // 1-10 coins
                
                const durLoss = config.FISHING.GEAR.DURABILITY_LOSS.JUNK || 0;
                const updateQuery = { 
                    $inc: { 'fishing.stats.junkCaught': 1, 'fishing.stats.totalCaught': 1 },
                    $push: { 'fishing.inventory': { species: junkName, weight: 0, rarity: 'JUNK', value: value } }
                };
                if (activeRodId !== 'flimsy_stick') updateQuery.$inc['fishing.gear.rodDurability'] = -durLoss;
                if (hasBait) {
                    updateQuery.$inc['fishing.gear.baitCount'] = -1;
                    updateQuery.$inc[`fishing.gear.ownedBaits.${activeBaitId}`] = -1;
                }
                
                const catchRes = await User.updateOne({ userId: user.userId, ...getInventoryCapacityFilter() }, updateQuery);
                if (catchRes.modifiedCount === 0) {
                    activeGames.delete(authorId);
                    const fullEmbed = new EmbedBuilder()
                        .setColor(0xE67E22)
                        .setTitle("🎒 Bucket Full!")
                        .setThumbnail(author.displayAvatarURL({ dynamic: true }))
                        .setDescription("Your bucket filled up while you were reeling! I threw that catch back before it made a mess. Sell something first, baka! (¬_¬)");
                    return msg.edit({ embeds: [fullEmbed], components: [] }).catch(async err => {
                        console.error("Fishing full bucket edit failed:", err);
                        await sendFishingContextFallback(context, "Your bucket filled up while reeling, so I threw that catch back. Sell something first, baka! (¬_¬)");
                    });
                }
                await normalizeFishingGear(user.userId);

                const junkEmbed = new EmbedBuilder()
                    .setColor(RARITY_COLORS.JUNK)
                    .setTitle(`${icon} You caught garbage!`)
                    .setThumbnail(author.displayAvatarURL({ dynamic: true }))
                    .setDescription(`You reeled in **${junkName}** worth ${value} coins. Pathetic. (¬_¬)\n\n**Reaction Speed:**\n${speedTitle}`);
                
                await msg.edit({ embeds: [junkEmbed], components: castAgainComponents }).catch(async err => {
                    console.error("Fishing junk result edit failed:", err);
                    await sendFishingContextFallback(context, `You caught **${junkName}** worth ${value} coins, but the fishing panel refused to update. Tch. (¬_¬)`);
                });
                activeGames.delete(authorId);
                return;
            }

            // Success
            let baseValue;
            if (baitInfo && activeBaitId === 'golden_worm') {
                baseValue = getScalingValue(user.coins || 0, config.FISHING.GOLDEN_WORM_VALUE);
                if (baseValue < config.FISHING.GOLDEN_WORM_FLOOR) baseValue = config.FISHING.GOLDEN_WORM_FLOOR;
            } else if (isCharter) {
                baseValue = getScalingValue(user.coins || 0, config.FISHING.CHARTER_COST_SCALE);
            } else {
                baseValue = getScalingValue(user.coins || 0, config.FISHING.REWARD_BASE);
            }
            
            // Apply Rod Multiplier
            baseValue = Math.floor(baseValue * rodInfo.mult);
            
            const rawFishValue = Math.floor(baseValue * roll.mult * (0.8 + Math.random() * 0.4)); // +/- 20% variance
            const fishValue = Math.floor(rawFishValue * speedMult);
            
            let fishWeight = Math.floor((rawFishValue / 100) * (0.8 + Math.random() * 0.4)) + 1;
            if (fishWeight > 999999999) fishWeight = 999999999; // Cap at ~1 Billion lbs
            const species = getRandomSpecies(roll.tier, userBiomeId);

            // Initialize DB update query
            const durLoss = config.FISHING.GEAR.DURABILITY_LOSS[roll.tier] || 1;
            const updateQuery = { 
                $inc: { 
                    'fishing.stats.totalCaught': 1,
                    'fishing.stats.mythicsCaught': roll.tier === 'MYTHIC' ? 1 : 0
                },
                $max: { 'fishing.stats.heaviestFish': fishWeight },
                $push: { 'fishing.inventory': { species, weight: fishWeight, rarity: roll.tier, value: fishValue } }
            };
            if (roll.tier === 'RARE') updateQuery.$inc['fishing.stats.raresCaught'] = 1;
            if (roll.tier === 'UR') updateQuery.$inc['fishing.stats.ursCaught'] = 1;

            // Check Bounty Progress
            let bountyNotice = "";
            if (user.fishing?.dailyBounty && user.fishing.dailyBounty.targetBiome) {
                const bounty = user.fishing.dailyBounty;
                if (bounty.expiresAt > Date.now() && bounty.amountCaught < bounty.amountNeeded) {
                    if (bounty.targetBiome === userBiomeId && bounty.targetRarity === roll.tier) {
                        bounty.amountCaught += 1;
                        updateQuery.$inc['fishing.dailyBounty.amountCaught'] = 1;
                        if (bounty.amountCaught >= bounty.amountNeeded) {
                            bountyNotice = `\n\n📜 **Bounty Complete!** Use \`!fish quest\` to claim your reward! >///<`;
                        } else {
                            bountyNotice = `\n\n📜 *Bounty Progress: ${bounty.amountCaught}/${bounty.amountNeeded}*`;
                        }
                    }
                }
            }

            if (activeRodId !== 'flimsy_stick') updateQuery.$inc['fishing.gear.rodDurability'] = -durLoss;
            if (hasBait) {
                updateQuery.$inc['fishing.gear.baitCount'] = -1;
                updateQuery.$inc[`fishing.gear.ownedBaits.${activeBaitId}`] = -1;
            }

            const catchRes = await User.updateOne({ userId: user.userId, ...getInventoryCapacityFilter() }, updateQuery);
            if (catchRes.modifiedCount === 0) {
                activeGames.delete(authorId);
                const fullEmbed = new EmbedBuilder()
                    .setColor(0xE67E22)
                    .setTitle("🎒 Bucket Full!")
                    .setThumbnail(author.displayAvatarURL({ dynamic: true }))
                    .setDescription("Your bucket filled up while you were reeling! I threw that catch back before it made a mess. Sell something first, baka! (¬_¬)");
                return msg.edit({ embeds: [fullEmbed], components: [] }).catch(async err => {
                    console.error("Fishing full bucket edit failed:", err);
                    await sendFishingContextFallback(context, "Your bucket filled up while reeling, so I threw that catch back. Sell something first, baka! (¬_¬)");
                });
            }
            await normalizeFishingGear(user.userId);

            const winEmbed = new EmbedBuilder()
                .setColor(speedMult < 1.0 ? speedColor : RARITY_COLORS[roll.tier]) // Color reflects speed if bad, rarity if good
                .setTitle(`${icon} You caught a ${roll.tier} fish! ${roll.tier === 'JUNK' ? '(¬_¬)' : '>///<'}`)
                .setThumbnail(author.displayAvatarURL({ dynamic: true }))
                .setDescription(`You reeled in a **${species}**!\n\n⚖️ **Weight:** ${fishWeight} lbs\n💰 **Est. Value:** ${fishValue.toLocaleString('en-US')} coins\n\n**Reaction Speed:**\n${speedTitle}${bountyNotice}`)
                .setFooter({ text: "Use !fish sell all to cash it in! Don't let it rot! (¬_¬)" });

            await msg.edit({ embeds: [winEmbed], components: castAgainComponents }).catch(async err => {
                console.error("Fishing result edit failed:", err);
                await sendFishingContextFallback(context, `You caught a **${species}** worth **${fishValue.toLocaleString('en-US')} coins**, but the fishing panel refused to update. Tch. (¬_¬)`);
            });
            activeGames.delete(authorId);

        } catch (e) {
            activeReelButtons.delete(buttonId);
            activeGames.delete(authorId);
            
            // Only penalize on actual timeout — not Discord API errors
            const isTimeout = e.code === 'InteractionCollectorError' || e.message?.includes('time');
            if (!isTimeout) {
                console.error("Fishing error:", e);
                await msg.edit({
                    embeds: [fishingErrorEmbed(author, "S-Something broke while reeling that in, so I cancelled the catch. Try again in a moment, baka! >///<")],
                    components: []
                }).catch(err => {
                    console.error("Fishing error fallback edit failed:", err);
                });
                return;
            }

            // Timeout (failed)
            // Deduct bait and flat 1 durability for fail
            const updateQuery = { $inc: {} };
            if (activeRodId !== 'flimsy_stick') updateQuery.$inc['fishing.gear.rodDurability'] = -1;
            if (hasBait) {
                updateQuery.$inc['fishing.gear.baitCount'] = -1;
                updateQuery.$inc[`fishing.gear.ownedBaits.${activeBaitId}`] = -1;
            }
            if (Object.keys(updateQuery.$inc).length > 0 || updateQuery.$set) {
                try {
                    await User.updateOne({ userId: user.userId }, updateQuery);
                    await normalizeFishingGear(user.userId);
                } catch (dbError) {
                    console.error("Fishing timeout penalty failed:", dbError);
                    await msg.edit({
                        embeds: [fishingErrorEmbed(author, "The fish escaped, but the system fumbled the bait/rod update. I cancelled the cleanup so nothing gets weirder. Try again in a moment, baka! >///<")],
                        components: []
                    }).catch(err => {
                        console.error("Fishing timeout fallback edit failed:", err);
                    });
                    return;
                }
            }
            
            // Create "Cast Again" button even on fail
            const castAgainComponents = [];
            if (!isCharter && (!hasBait || activeBaitId !== 'golden_worm')) {
                castAgainComponents.push(
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`fish_again_${authorId}`)
                            .setLabel("🎣 Cast Again")
                            .setStyle(ButtonStyle.Primary)
                    )
                );
            }

            const failEmbed = new EmbedBuilder()
                .setColor(0x000000)
                .setTitle("💦 It got away!")
                .setThumbnail(author.displayAvatarURL({ dynamic: true }))
                .setDescription(`You were too slow! Are your fingers broken?! Now you get NOTHING! (¬_¬)\n*(You lost your ${isCharter ? 'charter fee' : (hasBait ? (activeBaitId === 'golden_worm' ? 'golden worm' : 'bait') : 'cast')}...)*`);
            
            await msg.edit({ embeds: [failEmbed], components: castAgainComponents }).catch(async err => {
                console.error("Fishing timeout result edit failed:", err);
                await sendFishingContextFallback(context, "The fish escaped, but the panel refused to update. You were too slow anyway, baka! (¬_¬)");
            });
        }
    }, waitTime);
}

const handleBag = async (context, client, user, page = 0) => {
    try {
    const isInteraction = !!context.customId;
    const author = isInteraction ? context.user : context.author;
    const authorId = author.id;

    if (!user) user = await User.findOne({ userId: authorId });
    if (!user) {
        const msg = "I can't find your fishing data! Try `!fish` (or `!fih`) first, baka! (¬_¬)";
        if (isInteraction) return safeInteractionReply(context, msg);
        return safeMessageReply(context, msg);
    }

    const inv = user.fishing?.inventory || [];
    const pinned = user.fishing?.pinned || [];
    
    let mappedInv = inv.map((f, i) => ({ ...(f.toObject ? f.toObject() : f), originalIndex: i }));
    mappedInv.sort((a, b) => (b.value || 0) - (a.value || 0));

    const pageSize = 10;
    const totalPages = Math.max(1, Math.ceil(mappedInv.length / pageSize));
    if (page >= totalPages) page = totalPages - 1;
    if (page < 0) page = 0;

    const start = page * pageSize;
    const end = start + pageSize;
    const pageItems = mappedInv.slice(start, end);

    const embed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle(`🎒 ${author.username}'s Catch Bucket`)
        .setThumbnail(author.displayAvatarURL({ dynamic: true }))
        .setFooter({ text: `Page ${page + 1}/${totalPages} • Use lock to prevent selling! (¬_¬)` });

    const biome = user.fishing?.biome || 'shallow_pond';
    const activeRod = user.fishing?.gear?.activeRod || 'flimsy_stick';
    const durability = user.fishing?.gear?.rodDurability || 0;
    const rodInfo = getRodInfo(activeRod);
    const durabilityText = activeRod === 'flimsy_stick' || !Number.isFinite(rodInfo.maxDurability) ? 'Infinite' : `${durability} Durability`;
    
    const formatName = str => str.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

    const tierCheck = getUserAutocastTier(user);
    const tierBadge = tierCheck.tier > 0 
        ? `⚙️ **Autocast:** Tier ${tierCheck.tier} [${tierCheck.info.NAME}]`
        : `⚙️ **Autocast:** Locked`;

    let desc = `📍 **Biome:** ${formatName(biome)} | 🎣 **Rod:** ${formatName(activeRod)} (${durabilityText})\n${tierBadge}\n\n`;

    if (pinned.length > 0) {
        desc += `📌 **Pinned Fishes:**\n` + pinned.map(p => `• ${p}`).join('\n') + `\n\n`;
    }

    desc += `🐟 **Inventory (${inv.length} catches):**\n`;
    if (pageItems.length === 0) {
        desc += `*Empty! Go catch something first! (¬_¬)*`;
    } else {
        desc += pageItems.map((f, i) => {
            let line = `\`${start + i + 1}.\` **${f.species || 'Unknown'}** (${f.rarity || '???'})`;
            if (f.locked) line += ` 🔒`;
            line += ` — ${(f.weight || 0)} lbs — **${(f.value || 0).toLocaleString('en-US')} c**`;
            return line;
        }).join('\n');
    }
    embed.setDescription(desc);

    const components = [];

    if (pageItems.length > 0) {
        const lockMenu = new StringSelectMenuBuilder()
            .setCustomId(`fish_bag_lock_${authorId}_${page}`)
            .setPlaceholder("Toggle Lock (Prevents Selling)")
            .addOptions(
                pageItems.map((f, i) => ({
                    label: `${f.locked ? 'Unlock' : 'Lock'}: ${f.species || 'Unknown'}`,
                    description: `${f.weight || 0} lbs | ${f.rarity || '???'} | ${f.value || 0}c`,
                    value: `${f.originalIndex}|${fishFingerprint(f)}`,
                    emoji: f.locked ? '🔓' : '🔒'
                }))
            );
        components.push(new ActionRowBuilder().addComponents(lockMenu));
        
        const pinMenu = new StringSelectMenuBuilder()
            .setCustomId(`fish_bag_pin_${authorId}_${page}`)
            .setPlaceholder("Toggle Pin (Showcase on Profile)")
            .addOptions(
                pageItems.map((f, i) => ({
                    label: `Pin/Unpin: ${f.species || 'Unknown'}`,
                    description: `${f.weight || 0} lbs | ${f.rarity || '???'}`,
                    value: `${f.originalIndex}|${fishFingerprint(f)}`,
                    emoji: '📌'
                }))
            );
        components.push(new ActionRowBuilder().addComponents(pinMenu));
    }

    if (totalPages > 1) {
        const btnRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`fish_bag_prev_${authorId}_${page}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
            new ButtonBuilder().setCustomId(`fish_bag_next_${authorId}_${page}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1)
        );
        components.push(btnRow);
    }

    if (isInteraction) {
        return safeInteractionUpdate(context, { embeds: [embed], components });
    } else {
        return context.reply({ embeds: [embed], components }).catch(()=>{});
    }
    } catch (e) {
        console.error("Fishing bag render failed:", e);
        if (context?.customId) return safeInteractionReply(context, GENERIC_FISHING_FALLBACK);
        return safeMessageReply(context, GENERIC_FISHING_FALLBACK);
    }
};

async function handleAutocastTuneupMenu(context) {
    const authorId = context.author.id;
    const user = await User.findOne({ userId: authorId }).lean();
    if (!user) return context.reply({ content: "I can't find your data! Try `!fish` first, baka! (¬_¬)" });

    const upgrades = user.fishing?.autocast?.upgrades || {};
    const inv = user.fishing?.inventory || [];
    const pinned = user.fishing?.pinned || [];
    const isFishPinned = (pList, fish) => pList.some(p => typeof p === 'string' && (p === fish.species || p.includes(fish.species)));
    const unlockedCounts = { COMMON: 0, RARE: 0, UR: 0, JUNK: 0 };
    for (const f of inv) {
        if (f && !f.locked && !isFishPinned(pinned, f) && unlockedCounts[f.rarity] !== undefined) {
            unlockedCounts[f.rarity]++;
        }
    }

    const cfg = config.FISHING.AUTOCAST.UPGRADES;
    const spoolLvl = upgrades.spoolExt || 0;
    const gearLvl = upgrades.gearReinforce || 0;
    const rapidActive = !!upgrades.rapidRatchet;
    const compactorActive = !!upgrades.junkCompactor;

    // Spool Extension
    let spoolText = '';
    if (spoolLvl >= 2) {
        spoolText = `⭐ **Level 2/2 (MAX)** — +2 min duration (+12 casts). Maximum line capacity unlocked!`;
    } else {
        const nextCfg = cfg.spool[spoolLvl + 1];
        const coinStr = `${nextCfg.COINS.toLocaleString()} c`;
        const nugStr = nextCfg.NUGGETS > 0 ? `, ${nextCfg.NUGGETS} Nuggets` : '';
        const fishReqs = [];
        for (const [r, count] of Object.entries(nextCfg.FISH_REQ || {})) {
            fishReqs.push(`${unlockedCounts[r] || 0}/${count} ${r}`);
        }
        const fishStr = fishReqs.length > 0 ? ` + ${fishReqs.join(', ')}` : '';
        spoolText = `**Level ${spoolLvl}/2** ➔ Next: **${nextCfg.NAME}**\n` +
            `> *${nextCfg.DESC}*\n` +
            `> 💵 **Cost:** ${coinStr}${nugStr}${fishStr}\n` +
            `> 🔒 **Req:** Tier ${nextCfg.REQ_TIER} Autocast\n` +
            `> 🛒 \`!fish autocast buy spool\` — *Expand that spool already!*`;
    }

    // Reinforced Gears
    let gearText = '';
    if (gearLvl >= 2) {
        gearText = `⭐ **Level 2/2 (MAX)** — Absorbs up to 8 durability wear per session. Your rod won't snap now!`;
    } else {
        const nextCfg = cfg.reinforce[gearLvl + 1];
        const coinStr = `${nextCfg.COINS.toLocaleString()} c`;
        const nugStr = `, ${nextCfg.NUGGETS} Nuggets`;
        gearText = `**Level ${gearLvl}/2** ➔ Next: **${nextCfg.NAME}**\n` +
            `> *${nextCfg.DESC}*\n` +
            `> 💵 **Cost:** ${coinStr}${nugStr}\n` +
            `> 🔒 **Req:** Tier ${nextCfg.REQ_TIER} Autocast\n` +
            `> 🛒 \`!fish autocast buy reinforce\` — *Reinforce it before you snap another rod!*`;
    }

    // Quick-Reel Ratchet
    let ratchetText = '';
    if (rapidActive) {
        ratchetText = `⭐ **INSTALLED** — Reel interval reduced to 9s! Stop blinking or you'll miss the catches!`;
    } else {
        const rCfg = cfg.ratchet;
        ratchetText = `**Not Installed** ➔ **${rCfg.NAME}**\n` +
            `> *${rCfg.DESC}*\n` +
            `> 💵 **Cost:** ${rCfg.COINS.toLocaleString()} c, ${rCfg.NUGGETS} Nuggets\n` +
            `> 🔒 **Req:** Tier 2 Autocast, Prestige 5, 1,800 catches\n` +
            `> 🛒 \`!fish autocast buy ratchet\` — *Spin that reel faster, idiot!*`;
    }

    // Junk Compactor
    let compactorText = '';
    if (compactorActive) {
        compactorText = `⭐ **INSTALLED** — Auto-recycles junk directly into coins! Your bucket stays spotless!`;
    } else {
        const cCfg = cfg.compactor;
        compactorText = `**Not Installed** ➔ **${cCfg.NAME}**\n` +
            `> *${cCfg.DESC}*\n` +
            `> 💵 **Cost:** ${cCfg.COINS.toLocaleString()} c, ${cCfg.NUGGETS} Nuggets + ${unlockedCounts.JUNK || 0}/100 Junk\n` +
            `> 🔒 **Req:** Prestige 4, 1,200 catches\n` +
            `> 🛒 \`!fish autocast buy compactor\` — *Crush that smelly garbage into coins!*`;
    }

    const embed = new EmbedBuilder()
        .setColor(0xE67E22)
        .setTitle("🛠️ Autocast Forge — Machine Tuneups")
        .setDescription(
            "*Tch... so you want me to pimp out your automated fishing machine? Fine, but I don't work for free, idiot! Bring me coins, nuggets, and clean recycled fish!* (¬_¬)\n" +
            "*Safety Note: Locked (🔒) and Pinned (📌) fish in your bucket are NEVER touched! I'm not a thief! >///<*"
        )
        .addFields(
            { name: "🧵 Spool Extension", value: spoolText },
            { name: "⚙️ Reinforced Gears", value: gearText },
            { name: "⚡ Quick-Reel Ratchet", value: ratchetText },
            { name: "♻️ Junk Compactor", value: compactorText }
        )
        .setFooter({ text: "Use !fish autocast buy <upgrade> — Don't blame me when you're completely broke, baka! (¬_¬)" });

    return context.reply({ embeds: [embed] });
}

async function handleAutocastBuy(context, args) {
    const authorId = context.author.id;
    const replyMsg = (opts) => context.reply(opts);

    // Guard against running concurrent session or active minigame during Forge turn-in
    if (activeAutocastSessions.get(authorId)) {
        return replyMsg({ content: "You can't tune up your machine while it's actively running, idiot! Stop it first with `!fish autocast stop`! (¬_¬)" });
    }
    if (activeGames.get(authorId)) {
        return replyMsg({ content: "You're busy fishing right now! Reel in your line first before visiting the Forge, baka! (¬_¬)" });
    }

    const target = args[3]?.toLowerCase();

    if (!target) {
        return replyMsg({ content: "Which tuneup are you trying to buy, idiot?! Use `!fish autocast buy <spool|reinforce|ratchet|compactor>`! (¬_¬)" });
    }

    let upgradeKey = null;
    if (target === 'spool' || target === 'spool_ext' || target === 'spool_extension') upgradeKey = 'spool';
    else if (target === 'reinforce' || target === 'gears' || target === 'reinforced') upgradeKey = 'reinforce';
    else if (target === 'ratchet' || target === 'quick' || target === 'quick_reel') upgradeKey = 'ratchet';
    else if (target === 'compactor' || target === 'junk' || target === 'junk_compactor') upgradeKey = 'compactor';

    if (!upgradeKey) {
        return replyMsg({ content: `I don't know what tuneup \`${target}\` is, baka! Use \`spool\`, \`reinforce\`, \`ratchet\`, or \`compactor\`! (¬_¬)` });
    }

    const user = await User.findOne({ userId: authorId }).lean();
    if (!user) return replyMsg({ content: "I can't find your data! Try `!fish` first, baka! (¬_¬)" });

    const cfgAll = config.FISHING.AUTOCAST.UPGRADES;
    const tierCheck = getUserAutocastTier(user);
    const upgrades = user.fishing?.autocast?.upgrades || {};
    const prestige = user.prestige || 0;
    const totalCaught = tierCheck.totalCaught;

    let targetCfg = null;
    let targetField = '';
    let currentVal = 0;
    let nextVal = 0;
    let isBoolean = false;

    if (upgradeKey === 'spool') {
        targetField = 'spoolExt';
        currentVal = upgrades.spoolExt || 0;
        if (currentVal >= 2) {
            return replyMsg({ content: "Your Spool Extension is already at max level, idiot! (¬_¬)" });
        }
        nextVal = currentVal + 1;
        targetCfg = cfgAll.spool[nextVal];
    } else if (upgradeKey === 'reinforce') {
        targetField = 'gearReinforce';
        currentVal = upgrades.gearReinforce || 0;
        if (currentVal >= 2) {
            return replyMsg({ content: "Your Reinforced Gears are already at max level, idiot! (¬_¬)" });
        }
        nextVal = currentVal + 1;
        targetCfg = cfgAll.reinforce[nextVal];
    } else if (upgradeKey === 'ratchet') {
        targetField = 'rapidRatchet';
        isBoolean = true;
        if (upgrades.rapidRatchet) {
            return replyMsg({ content: "You already installed the Quick-Reel Ratchet, baka! (¬_¬)" });
        }
        nextVal = true;
        targetCfg = cfgAll.ratchet;
    } else if (upgradeKey === 'compactor') {
        targetField = 'junkCompactor';
        isBoolean = true;
        if (upgrades.junkCompactor) {
            return replyMsg({ content: "You already installed the Junk Compactor, baka! (¬_¬)" });
        }
        nextVal = true;
        targetCfg = cfgAll.compactor;
    }

    // Check prerequisites
    if (targetCfg.REQ_TIER && tierCheck.tier < targetCfg.REQ_TIER) {
        return replyMsg({ content: `You need to unlock Autocast Tier **${targetCfg.REQ_TIER}** before crafting this tuneup, idiot! (You are currently Tier ${tierCheck.tier}) (¬_¬)` });
    }
    if (targetCfg.REQ_PRESTIGE && prestige < targetCfg.REQ_PRESTIGE) {
        return replyMsg({ content: `You need Prestige **${targetCfg.REQ_PRESTIGE}** for this tuneup! (You are Prestige ${prestige}) (¬_¬)` });
    }
    if (targetCfg.REQ_CATCHES && totalCaught < targetCfg.REQ_CATCHES) {
        return replyMsg({ content: `You need at least **${targetCfg.REQ_CATCHES.toLocaleString()}** lifetime catches for this! (You have ${totalCaught.toLocaleString()}) (¬_¬)` });
    }

    // Check coins and nuggets
    if ((user.coins || 0) < targetCfg.COINS) {
        return replyMsg({ content: `You're too broke! You need **${targetCfg.COINS.toLocaleString()} coins** for this tuneup! (¬_¬)` });
    }
    if (targetCfg.NUGGETS > 0 && (user.nuggets || 0) < targetCfg.NUGGETS) {
        return replyMsg({ content: `You need **${targetCfg.NUGGETS} Nuggets** to forge this! (You only have ${user.nuggets || 0}) (¬_¬)` });
    }

    // Check fish turn-in requirements
    const inv = user.fishing?.inventory || [];
    const pinned = user.fishing?.pinned || [];
    const isFishPinned = (pList, fish) => pList.some(p => typeof p === 'string' && (p === fish.species || p.includes(fish.species)));
    const indicesToConsume = [];
    const fishSummary = [];

    if (targetCfg.FISH_REQ && Object.keys(targetCfg.FISH_REQ).length > 0) {
        for (const [rarity, needed] of Object.entries(targetCfg.FISH_REQ)) {
            const availableIndices = [];
            for (let i = 0; i < inv.length; i++) {
                const f = inv[i];
                if (f && f.rarity === rarity && !f.locked && !isFishPinned(pinned, f) && !indicesToConsume.includes(i)) {
                    availableIndices.push(i);
                }
            }
            if (availableIndices.length < needed) {
                return replyMsg({
                    content: `You don't have enough unlocked, unpinned **${rarity}** fish in your bucket! Need **${needed}**, but you only have **${availableIndices.length}** eligible! (¬_¬)`
                });
            }
            indicesToConsume.push(...availableIndices.slice(0, needed));
            fishSummary.push(`${needed} ${rarity}`);
        }
    }

    // Atomic execution
    const matchConditions = {
        userId: authorId,
        coins: { $gte: targetCfg.COINS }
    };
    if (targetCfg.NUGGETS > 0) {
        matchConditions.nuggets = { $gte: targetCfg.NUGGETS };
    }
    if (isBoolean) {
        matchConditions[`fishing.autocast.upgrades.${targetField}`] = { $ne: true };
    } else {
        matchConditions[`fishing.autocast.upgrades.${targetField}`] = currentVal;
    }

    const unsetObj = {};
    for (const idx of indicesToConsume) {
        unsetObj[`fishing.inventory.${idx}`] = 1;
        matchConditions[`fishing.inventory.${idx}.species`] = inv[idx].species;
        matchConditions[`fishing.inventory.${idx}.rarity`] = inv[idx].rarity;
    }

    const updateQuery = {
        $inc: { coins: -targetCfg.COINS },
        $set: {
            [`fishing.autocast.upgrades.${targetField}`]: nextVal
        }
    };
    if (indicesToConsume.length > 0) {
        updateQuery.$unset = unsetObj;
    }
    if (targetCfg.NUGGETS > 0) {
        updateQuery.$inc.nuggets = -targetCfg.NUGGETS;
    }

    const updateRes = await User.updateOne(matchConditions, updateQuery);
    if (updateRes.modifiedCount === 0) {
        return replyMsg({ content: "Transaction failed! Your inventory or balances changed while processing. Try again, baka! (¬_¬)" });
    }

    // Pull nulls from unset fish
    if (indicesToConsume.length > 0) {
        await User.updateOne({ userId: authorId }, { $pull: { 'fishing.inventory': null } });
    }

    const matStr = fishSummary.length > 0 ? ` and turned in **${fishSummary.join(', ')}**` : '';
    const nugStr = targetCfg.NUGGETS > 0 ? ` + **${targetCfg.NUGGETS} Nuggets**` : '';

    const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle(`🛠️ Tuneup Installed — ${targetCfg.NAME}!`)
        .setDescription(
            `*Clank, hiss, whir...* Your machine just got an upgrade!\n\n` +
            `Paid **${targetCfg.COINS.toLocaleString()} coins**${nugStr}${matStr}.\n\n` +
            `✨ **Perk Activated:** ${targetCfg.DESC}\n\n` +
            `*Don't get cocky! Even with top-tier gear, active fishers can still outfish you, idiot!* >///<`
        )
        .setFooter({ text: "Tsun Engineering Dept. — Permanent Autocast Tuneup" });

    return replyMsg({ embeds: [embed] });
}

async function executeAutocast(context, client) {
    const author = context.author;
    const authorId = author.id;

    const replyMsg = async (opts) => context.reply(opts);

    // Check if already running or locked
    if (activeGames.get(authorId) || activeAutocastSessions.get(authorId)) {
        if (activeAutocastSessions.get(authorId)) {
            return replyMsg({ content: "You already have an autocast session running! Use `!fish autocast stop` to end it, or wait. (¬_¬)" });
        }
        return replyMsg({ content: "H-Hey! You already have your rod cast somewhere else! Finish that first, idiot! (¬_¬)" });
    }
    // Set lock immediately to block concurrent command spam while resolving DB
    activeGames.set(authorId, true);

    const unlockFail = (msg) => {
        activeGames.delete(authorId);
        return replyMsg(msg);
    };

    // Fetch user
    const user = await User.findOne({ userId: authorId }).lean();
    if (!user) return unlockFail({ content: "I can't find your data! Try `!fish` first, baka! (¬_¬)" });

    // Tier qualification check (dual-track)
    const tierCheck = getUserAutocastTier(user);
    if (tierCheck.tier === 0) {
        return unlockFail({
            content: `🔒 **Autocast is Locked!** You need either:\n` +
                `> 💰 **Wealth Route:** Prestige **3** (You have: Prestige ${tierCheck.prestige})\n` +
                `> 🎣 **Fisherman Route:** **800** catches, **25** Rares & Carbon Rod (You have: **${tierCheck.totalCaught}** catches, **${tierCheck.effectiveRares}** rares)\n\n` +
                `*Keep grinding, baka! I'm not doing your chores for free!* (¬_¬)`
        });
    }

    const tierNum = tierCheck.tier;
    const tierInfo = tierCheck.info;

    // Flimsy stick guard & rod info
    const activeRodId = user.fishing?.gear?.activeRod || 'flimsy_stick';
    const rodInfo = getRodInfo(activeRodId);
    if (activeRodId === 'flimsy_stick') {
        return unlockFail({ content: "You think you can hook an automated clockwork spool to a fragile wooden branch?! Buy a real rod first, idiot! (¬_¬)" });
    }

    // Broken rod guard (prevent wasting daily runs/nuggets on 0 durability rod)
    const rodDur = user.fishing?.gear?.rodDurability || 0;
    if (rodDur <= 0) {
        return unlockFail({ content: `Your ${rodInfo.emoji} **${rodInfo.name}** is broken (0 durability)! Repair it with \`!fish repair\` before asking me to autocast for you, idiot! (¬_¬)` });
    }

    // Daily cap check (reset at UTC midnight)
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const todayMs = today.getTime();
    const ac = user.fishing?.autocast || {};
    const sessionsUsed = (ac.lastSessionReset || 0) >= todayMs ? (ac.sessionsToday || 0) : 0;

    if (sessionsUsed >= tierInfo.DAILY_CAP) {
        return unlockFail({ content: `🚫 You've used all **${tierInfo.DAILY_CAP}** ${tierInfo.NAME} sessions today! Come back tomorrow, baka! (¬_¬)` });
    }

    // Cost calculation (1st run free: cost = 0)
    const sessionCost = tierInfo.COST_NUGGETS_ARRAY[sessionsUsed] ?? 1;
    if (sessionCost > 0 && (user.nuggets || 0) < sessionCost) {
        return unlockFail({ content: `🚫 You need **${sessionCost} Nugget(s)** for this autocast session! You have ${user.nuggets || 0}. (¬_¬)` });
    }

    // Bucket check
    const invLen = user.fishing?.inventory?.length || 0;
    if (invLen >= (config.FISHING.MAX_INVENTORY || 500)) {
        return unlockFail({ content: `Your bucket is overflowing with ${invLen} fish! Sell some first before autocasting! (¬_¬)` });
    }

    // Upgrades & Modifiers
    const userUpgrades = user.fishing?.autocast?.upgrades || {};
    const spoolLvl = userUpgrades.spoolExt || 0;
    const extraDurationMs = spoolLvl * 60000;
    const totalDurationMs = tierInfo.DURATION_MS + extraDurationMs;
    const gearAbsorbCap = userUpgrades.gearReinforce === 2 ? 8 : (userUpgrades.gearReinforce === 1 ? 4 : 0);

    // Deduct nugget (if > 0) + increment sessions atomically
    const filterQuery = { userId: authorId };
    const sessionUpdate = {
        $set: {
            'fishing.autocast.sessionsToday': sessionsUsed + 1,
            'fishing.autocast.lastSessionReset': todayMs,
            'fishing.autocast.activeUntil': Date.now() + totalDurationMs
        }
    };
    if (sessionCost > 0) {
        filterQuery.nuggets = { $gte: sessionCost };
        sessionUpdate.$inc = { nuggets: -sessionCost };
    }

    const deductRes = await User.findOneAndUpdate(
        filterQuery,
        sessionUpdate,
        { returnDocument: 'after' }
    );
    if (!deductRes) {
        return unlockFail({ content: "Transaction failed! Make sure you still meet the requirements! (¬_¬)" });
    }

    // Gather gear info
    const userBiomeId = deductRes.fishing?.biome || 'shallow_pond';
    const biomeInfo = config.FISHING.BIOMES[userBiomeId] || config.FISHING.BIOMES.shallow_pond;

    // Session state
    const session = {
        authorId,
        channelId: context.channel.id,
        endsAt: Date.now() + totalDurationMs,
        totalDurationMs,
        tierNum,
        tierInfo,
        userUpgrades,
        gearAbsorbCap,
        gearAbsorbedSoFar: 0,
        junkCompactedCount: 0,
        junkCompactedValue: 0,
        maxDurabilityLoss: tierInfo.MAX_DURABILITY_LOSS,
        durabilityLostSoFar: 0,
        catches: [],
        castCount: 0,
        stopped: false,
        intervalId: null,
        stopReason: null,
        processing: false,
        startDurability: deductRes.fishing?.gear?.rodDurability || 0,
        userCoins: deductRes.coins || 0,
        runCatch: null
    };
    activeAutocastSessions.set(authorId, session);

    // Show start embed
    const costText = sessionCost === 0 ? "Free (Daily Bonus)" : `${sessionCost} Nugget`;
    const spoolText = spoolLvl > 0 ? ` *(+${spoolLvl}m Spool Extension)*` : '';
    const speedText = userUpgrades.rapidRatchet ? '⚡ **Speed:** 9s interval (Ratchet Boosted!)' : '⚡ **Speed:** Fixed 0.7x (10s interval)';
    const durShieldText = gearAbsorbCap > 0
        ? `🛡️ **Durability Shield:** Max -${tierInfo.MAX_DURABILITY_LOSS} loss (Gears absorb first ${gearAbsorbCap})`
        : `🛡️ **Durability Shield:** Max -${tierInfo.MAX_DURABILITY_LOSS} loss`;

    const startEmbed = new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle(`🤖 Autocast Activated — ${tierInfo.NAME}`)
        .setThumbnail(author.displayAvatarURL({ dynamic: true }))
        .setDescription(
            `Paid **${costText}**. Your ${rodInfo.emoji} **${rodInfo.name}** is fishing on autopilot for **${totalDurationMs / 60000} minutes**${spoolText}.\n\n` +
            `📍 **Biome:** ${biomeInfo.emoji} ${biomeInfo.name}\n` +
            `${speedText}\n` +
            `🪱 **Bait:** Not used during autocast\n` +
            `${durShieldText}\n\n` +
            `*I'll post a summary when it's done. Don't bother me until then! (¬_¬)*\n\n` +
            `Use \`!fish autocast stop\` to end early. Sessions today: **${sessionsUsed + 1}/${tierInfo.DAILY_CAP}**`
        );
    await replyMsg({ embeds: [startEmbed] }).catch(e => {
        console.error("Autocast start embed failed:", e);
    });

    // --- THE CATCH LOOP ---
    const runCatch = async () => {
        if (session.processing) return; // Prevent async re-entry
        session.processing = true;
        try {
            if (session.stopped || Date.now() >= session.endsAt) {
                clearInterval(session.intervalId);
                await finalizeAutocast(session, author, context.channel, activeRodId, rodInfo, biomeInfo, client);
                return;
            }

            session.castCount++;

            // Re-check bucket capacity & in-loop overflow liquidation
            const capCheck = await User.exists({ userId: authorId, ...getInventoryCapacityFilter() });
            if (!capCheck) {
                const maxCap = config.FISHING.MAX_INVENTORY || 500;
                const freshUser = await User.findOne({ userId: authorId }).select('fishing.inventory fishing.pinned').lean();
                const currentInv = freshUser?.fishing?.inventory || [];
                const pinnedList = freshUser?.fishing?.pinned || [];

                if (currentInv.length >= maxCap) {
                    // Find up to 10 discardable (unpinned & unlocked JUNK and COMMON fish)
                    const isFishPinned = (pList, fish) => pList.some(p => typeof p === 'string' && (p === fish.species || p.includes(fish.species)));
                    const discardableIndices = [];
                    for (let i = 0; i < currentInv.length; i++) {
                        const f = currentInv[i];
                        if (f && (f.rarity === 'JUNK' || f.rarity === 'COMMON') && !f.locked && !isFishPinned(pinnedList, f)) {
                            discardableIndices.push(i);
                            if (discardableIndices.length >= 10) break;
                        }
                    }

                    if (discardableIndices.length >= 10) {
                        const batchToSell = discardableIndices.map(i => currentInv[i]);
                        const sellValue = batchToSell.reduce((sum, f) => sum + (f.value || 0), 0);

                        const unsetObj = {};
                        const matchConditions = { userId: authorId };
                        for (const idx of discardableIndices) {
                            unsetObj[`fishing.inventory.${idx}`] = 1;
                            matchConditions[`fishing.inventory.${idx}.species`] = currentInv[idx].species;
                            matchConditions[`fishing.inventory.${idx}.rarity`] = currentInv[idx].rarity;
                        }

                        const updateRes = await User.updateOne(matchConditions, { $unset: unsetObj });
                        if (updateRes.modifiedCount > 0) {
                            await User.updateOne({ userId: authorId }, { $pull: { 'fishing.inventory': null } });
                            await distributeIncome(authorId, sellValue);
                            session.autoSoldFishCount = (session.autoSoldFishCount || 0) + batchToSell.length;
                            session.autoSoldValue = (session.autoSoldValue || 0) + sellValue;
                        }
                    } else {
                        // Truly full of Rare+ or Locked fish -> Stop safely
                        session.stopped = true;
                        session.stopReason = 'bucket_full';
                        clearInterval(session.intervalId);
                        await finalizeAutocast(session, author, context.channel, activeRodId, rodInfo, biomeInfo, client);
                        return;
                    }
                }
            }

            // Re-check rod isn't broken (for non-flimsy)
            if (activeRodId !== 'flimsy_stick') {
                const rodCheck = await User.exists({ userId: authorId, 'fishing.gear.activeRod': activeRodId, 'fishing.gear.rodDurability': { $gt: 0 } });
                if (!rodCheck) {
                    session.stopped = true;
                    session.stopReason = 'rod_broke';
                    clearInterval(session.intervalId);
                    await finalizeAutocast(session, author, context.channel, activeRodId, rodInfo, biomeInfo, client);
                    return;
                }
            }

            // Build drop table: standard + biome mods + JUNK bonus, NO bait
            let table = structuredClone(config.FISHING.STANDARD_DROP);

            // Apply biome drop mods
            if (biomeInfo.dropMods) {
                for (const t of Object.keys(biomeInfo.dropMods)) {
                    if (biomeInfo.dropMods[t] !== 0) {
                        if (!table[t]) {
                            let defaultMult = config.FISHING.STANDARD_DROP[t]?.mult || 1;
                            table[t] = { chance: 0, mult: defaultMult };
                        }
                        table[t].chance = Math.max(0, table[t].chance + biomeInfo.dropMods[t]);
                    }
                }
            }

            // Apply autocast JUNK bonus
            if (table.JUNK) {
                table.JUNK.chance += config.FISHING.AUTOCAST.JUNK_BONUS;
            }

            // Clamp negatives
            for (const t of Object.keys(table)) {
                if (table[t].chance < 0) table[t].chance = 0;
            }

            const roll = rollTable(table);

            if (roll.tier === 'JUNK') {
                const junkName = await getJunkName(context.guild);
                const value = Math.floor(Math.random() * 10) + 1;

                let rawDurLoss = config.FISHING.GEAR.DURABILITY_LOSS.JUNK || 0;
                let effectiveDurLoss = rawDurLoss;
                if (session.gearAbsorbCap > 0 && session.gearAbsorbedSoFar < session.gearAbsorbCap && effectiveDurLoss > 0) {
                    const absorb = Math.min(effectiveDurLoss, session.gearAbsorbCap - session.gearAbsorbedSoFar);
                    session.gearAbsorbedSoFar += absorb;
                    effectiveDurLoss -= absorb;
                }
                const allowedLoss = Math.max(0, (session.maxDurabilityLoss || 999) - (session.durabilityLostSoFar || 0));
                const durLoss = Math.min(effectiveDurLoss, allowedLoss);
                session.durabilityLostSoFar = (session.durabilityLostSoFar || 0) + durLoss;

                if (session.userUpgrades?.junkCompactor) {
                    // Junk Compactor: Crush junk directly into coins without filling inventory!
                    await distributeIncome(authorId, value);
                    session.junkCompactedCount = (session.junkCompactedCount || 0) + 1;
                    session.junkCompactedValue = (session.junkCompactedValue || 0) + value;

                    const updateQuery = {
                        $inc: { 'fishing.stats.junkCaught': 1, 'fishing.stats.totalCaught': 1 }
                    };
                    if (activeRodId !== 'flimsy_stick' && durLoss > 0) updateQuery.$inc['fishing.gear.rodDurability'] = -durLoss;

                    await User.updateOne({ userId: authorId }, updateQuery);
                    await normalizeFishingGear(authorId);

                    session.catches.push({ species: `${junkName} (Compacted)`, weight: 0, rarity: 'JUNK', value: value });
                } else {
                    const updateQuery = {
                        $inc: { 'fishing.stats.junkCaught': 1, 'fishing.stats.totalCaught': 1 },
                        $push: { 'fishing.inventory': { species: junkName, weight: 0, rarity: 'JUNK', value: value } }
                    };
                    if (activeRodId !== 'flimsy_stick' && durLoss > 0) updateQuery.$inc['fishing.gear.rodDurability'] = -durLoss;

                    await User.updateOne({ userId: authorId, ...getInventoryCapacityFilter() }, updateQuery);
                    await normalizeFishingGear(authorId);

                    session.catches.push({ species: junkName, weight: 0, rarity: 'JUNK', value: value });
                }
            } else {
                // Successful catch
                let baseValue = getScalingValue(session.userCoins, config.FISHING.REWARD_BASE);
                baseValue = Math.floor(baseValue * rodInfo.mult);
                const rawFishValue = Math.floor(baseValue * roll.mult * (0.8 + Math.random() * 0.4));
                const fishValue = Math.floor(rawFishValue * config.FISHING.AUTOCAST.SPEED_MULT);

                let fishWeight = Math.floor((rawFishValue / 100) * (0.8 + Math.random() * 0.4)) + 1;
                if (fishWeight > 999999999) fishWeight = 999999999;
                const species = getRandomSpecies(roll.tier, userBiomeId);

                const rawDurLoss = config.FISHING.GEAR.DURABILITY_LOSS[roll.tier] || 1;
                let effectiveDurLoss = rawDurLoss;
                if (session.gearAbsorbCap > 0 && session.gearAbsorbedSoFar < session.gearAbsorbCap) {
                    const absorb = Math.min(effectiveDurLoss, session.gearAbsorbCap - session.gearAbsorbedSoFar);
                    session.gearAbsorbedSoFar += absorb;
                    effectiveDurLoss -= absorb;
                }
                const allowedLoss = Math.max(0, (session.maxDurabilityLoss || 999) - (session.durabilityLostSoFar || 0));
                const durLoss = Math.min(effectiveDurLoss, allowedLoss);
                session.durabilityLostSoFar = (session.durabilityLostSoFar || 0) + durLoss;

                const updateQuery = {
                    $inc: {
                        'fishing.stats.totalCaught': 1,
                        'fishing.stats.mythicsCaught': roll.tier === 'MYTHIC' ? 1 : 0
                    },
                    $max: { 'fishing.stats.heaviestFish': fishWeight },
                    $push: { 'fishing.inventory': { species, weight: fishWeight, rarity: roll.tier, value: fishValue } }
                };
                if (roll.tier === 'RARE') updateQuery.$inc['fishing.stats.raresCaught'] = 1;
                if (roll.tier === 'UR') updateQuery.$inc['fishing.stats.ursCaught'] = 1;

                if (activeRodId !== 'flimsy_stick' && durLoss > 0) updateQuery.$inc['fishing.gear.rodDurability'] = -durLoss;

                // Bounty progress
                const freshBounty = await User.findOne({ userId: authorId }).select('fishing.dailyBounty').lean();
                const bounty = freshBounty?.fishing?.dailyBounty;
                if (bounty && bounty.targetBiome && bounty.expiresAt > Date.now() && bounty.amountCaught < bounty.amountNeeded) {
                    if (bounty.targetBiome === userBiomeId && bounty.targetRarity === roll.tier) {
                        updateQuery.$inc['fishing.dailyBounty.amountCaught'] = 1;
                    }
                }

                await User.updateOne({ userId: authorId, ...getInventoryCapacityFilter() }, updateQuery);
                await normalizeFishingGear(authorId);

                session.catches.push({ species, weight: fishWeight, rarity: roll.tier, value: fishValue });
            }
        } catch (e) {
            console.error("Autocast catch loop error:", e);
            // If finalize was supposed to run but failed, clean up
            if (session.stopped || Date.now() >= session.endsAt) {
                clearInterval(session.intervalId);
                activeAutocastSessions.delete(authorId);
                activeGames.delete(authorId);
                await User.updateOne({ userId: authorId }, { $set: { 'fishing.autocast.activeUntil': 0 } }).catch(() => {});
            }
        } finally {
            session.processing = false;
            if (session.stopped && !session.finalized) {
                await finalizeAutocast(session, author, context.channel, activeRodId, rodInfo, biomeInfo, client);
            }
        }
    };

    // Attach runCatch to session for responsive manual stopping
    session.runCatch = runCatch;

    // Start the interval (using Quick-Reel Ratchet speed if active)
    const castInterval = session.userUpgrades?.rapidRatchet ? 9000 : (tierInfo.CAST_INTERVAL_MS || 10000);
    session.intervalId = setInterval(runCatch, castInterval);
    // Run the first cast immediately
    runCatch();
}

async function finalizeAutocast(session, author, channel, activeRodId, rodInfo, biomeInfo, client) {
    if (session.finalized) return;
    session.finalized = true;
    clearInterval(session.intervalId);

    const authorId = session.authorId;
    activeAutocastSessions.delete(authorId);
    activeGames.delete(authorId);

    // Clear activeUntil
    await User.updateOne({ userId: authorId }, { $set: { 'fishing.autocast.activeUntil': 0 } });

    // Build summary
    const catches = session.catches;
    const rarityCounts = { JUNK: 0, COMMON: 0, RARE: 0, UR: 0, LEGENDARY: 0, MYTHIC: 0 };
    const rarityValues = { JUNK: 0, COMMON: 0, RARE: 0, UR: 0, LEGENDARY: 0, MYTHIC: 0 };
    let bestCatch = null;

    for (const fish of catches) {
        rarityCounts[fish.rarity] = (rarityCounts[fish.rarity] || 0) + 1;
        rarityValues[fish.rarity] = (rarityValues[fish.rarity] || 0) + fish.value;
        if (!bestCatch || fish.value > bestCatch.value) bestCatch = fish;
    }

    // Get end durability
    const endUser = await User.findOne({ userId: authorId }).select('fishing.gear.rodDurability fishing.autocast').lean();
    const endDur = endUser?.fishing?.gear?.rodDurability || 0;
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const isSameDay = (endUser?.fishing?.autocast?.lastSessionReset || 0) >= today.getTime();
    const sessionsUsed = isSameDay ? (endUser?.fishing?.autocast?.sessionsToday || 0) : 0;

    const tierNum = session.tierNum || 1;
    const tierInfo = session.tierInfo || config.FISHING.AUTOCAST.TIERS[tierNum];
    const dailyCap = tierInfo.DAILY_CAP;
    const remaining = Math.max(0, dailyCap - sessionsUsed);

    const totalDuration = session.totalDurationMs || tierInfo.DURATION_MS;
    const elapsed = Math.min(totalDuration, Date.now() - (session.endsAt - totalDuration));
    const mins = Math.floor(elapsed / 60000);
    const secs = Math.floor((elapsed % 60000) / 1000);

    let stopNote = '';
    if (session.stopReason === 'bucket_full') stopNote = '\n⚠️ *Stopped early — bucket was full!*';
    else if (session.stopReason === 'rod_broke') stopNote = '\n⚠️ *Stopped early — your rod broke! Use `!fish repair` to fix it!*';
    else if (session.stopped) stopNote = '\n*Stopped early by request.*';

    let totalHaulValue = 0;
    for (const val of Object.values(rarityValues)) totalHaulValue += val;

    const tableLines = [
        'Rarity          Count      Est. Value',
        '─────────────────────────────────────'
    ];

    for (const r of ['JUNK', 'COMMON', 'RARE', 'UR', 'LEGENDARY', 'MYTHIC']) {
        if (rarityCounts[r] > 0) {
            const nameCol = r.padEnd(14, ' ');
            const countCol = rarityCounts[r].toString().padStart(6, ' ');
            const valCol = `${rarityValues[r].toLocaleString('en-US')} c`.padStart(15, ' ');
            tableLines.push(`${nameCol} ${countCol} ${valCol}`);
        }
    }
    tableLines.push('─────────────────────────────────────');
    tableLines.push(`${'Total'.padEnd(14, ' ')} ${catches.length.toString().padStart(6, ' ')} ${`${totalHaulValue.toLocaleString('en-US')} c`.padStart(15, ' ')}`);

    const durUsed = session.startDurability - endDur;
    const durText = activeRodId === 'flimsy_stick' ? 'Infinite' : `${session.startDurability} → ${endDur} (-${durUsed} used)`;

    // Dynamic Tsundere Footer based on session luck and overflow events
    let footerText = "Tch... I watched your line the whole time so it didn't snap. Don't get used to it, baka! (¬_¬)";
    if (session.stopReason === 'bucket_full') {
        footerText = "Your bucket is overflowing with slimy fish! Clean it out before you make a mess, idiot! >///<";
    } else if (session.stopReason === 'rod_broke') {
        footerText = "Your rod literally snapped in half... I told you to maintain your gear, baka! (¬_¬)";
    } else if (session.stopped) {
        footerText = "Pulling your line early? Impatient as always, idiot... (¬_¬)";
    } else if (rarityCounts.MYTHIC > 0) {
        footerText = "W-Wait, a MYTHIC?! H-How did YOU pull that off on autopilot?! Pure dumb luck, baka! >///<";
    } else if (rarityCounts.LEGENDARY > 0) {
        footerText = "A Legendary catch while you weren't even looking?! D-Don't let it get to your head! >///<";
    } else if (catches.length === 0) {
        footerText = "Not a single fish?! Even a sleeping kitten catches more than you did. Pathetic! (¬_¬)";
    } else if (rarityCounts.JUNK >= Math.ceil(catches.length * 0.5)) {
        footerText = "Look at all this garbage you dragged up. Literal trash for a trash fisher! (¬_¬)";
    } else if (session.autoSoldFishCount > 0) {
        footerText = `Your bucket overflowed so I sold ${session.autoSoldFishCount} of your junk fish! You're welcome, baka! >///<`;
    } else if (session.junkCompactedCount > 0) {
        footerText = `Your compactor crunched ${session.junkCompactedCount} pieces of trash into clean coins! Pretty neat invention, I guess... >///<`;
    } else if (rarityCounts.UR > 0 || rarityCounts.RARE >= 5) {
        footerText = "Decent haul, I guess... N-Not that I was rooting for you or anything, idiot! >///<";
    }

    const embed = new EmbedBuilder()
        .setColor(bestCatch && ['LEGENDARY', 'MYTHIC'].includes(bestCatch.rarity) ? RARITY_COLORS[bestCatch.rarity] || 0xF1C40F : 0x9B59B6)
        .setTitle(`🤖 Autocast Complete — ${tierInfo.NAME} (Tier ${tierNum})`)
        .setDescription(`*Session finished in ${mins}m ${secs.toString().padStart(2, '0')}s across ${session.castCount} casts.* (¬_¬)\n${stopNote}`)
        .addFields(
            {
                name: '─── Catch Breakdown ───',
                value: `\`\`\`\n${tableLines.join('\n')}\n\`\`\``
            },
            {
                name: '─── Session Highlights ───',
                value:
                    (bestCatch ? `> ⭐ **Best Catch:** ${bestCatch.species} (${bestCatch.rarity}) — ${bestCatch.weight.toLocaleString('en-US')} lbs — ${bestCatch.value.toLocaleString('en-US')} c\n` : '') +
                    (session.autoSoldFishCount > 0 ? `> 📦 **Overflow Liquidation:** Auto-sold ${session.autoSoldFishCount} fish (+${(session.autoSoldValue || 0).toLocaleString('en-US')} c via income)\n` : '') +
                    (session.junkCompactedCount > 0 ? `> ♻️ **Junk Compactor:** Recycled ${session.junkCompactedCount} trash items into +${(session.junkCompactedValue || 0).toLocaleString('en-US')} c\n` : '') +
                    (session.gearAbsorbedSoFar > 0 ? `> 🛡️ **Reinforced Gears:** Absorbed ${session.gearAbsorbedSoFar} rod durability wear\n` : '') +
                    `> 📍 **Location:** ${biomeInfo.emoji} ${biomeInfo.name}\n` +
                    `> 🎣 **Rod Status:** ${rodInfo.emoji} ${rodInfo.name} (${durText})\n` +
                    `\nDaily Sessions Remaining: **${remaining}/${dailyCap}**`
            }
        )
        .setFooter({ text: footerText });

    try {
        await channel.send({ content: `<@${authorId}>`, embeds: [embed] });
    } catch (e) {
        console.error("Autocast summary embed failed:", e);
    }

    // Server milestone announcement for Tier II and III unlocks
    const announcedTier = endUser?.fishing?.autocast?.announcedTier || 0;
    if (tierNum >= 2 && tierNum > announcedTier) {
        await User.updateOne({ userId: authorId }, { $set: { 'fishing.autocast.announcedTier': tierNum } });
        const milestoneEmbed = new EmbedBuilder()
            .setColor(tierNum === 3 ? 0xF1C40F : 0x3498DB)
            .setTitle(`🎉 Autocast Milestone — ${tierInfo.NAME}!`)
            .setDescription(
                `Look who upgraded their lazy fishing machinery!\n\n` +
                `<@${authorId}> has officially deployed **Tier ${tierNum}: ${tierInfo.NAME}**!\n` +
                `*Session duration expanded to **${tierInfo.DURATION_MS / 60000} minutes** (${Math.floor(tierInfo.DURATION_MS / (tierInfo.CAST_INTERVAL_MS || 10000))} casts)! Don't get cocky, baka!* (¬_¬)`
            )
            .setFooter({ text: "Tsun Engineering Dept. — Upgrading lazy fishers since 2026" });
        await channel.send({ embeds: [milestoneEmbed] }).catch(() => {});
    }
}

module.exports = {
    handle: async (message, client) => {
        try {
            return await executeFishing(message, false);
        } catch (e) {
            activeGames.delete(message.author.id);
            console.error("Fishing command error:", e);
            return safeMessageReply(message, GENERIC_FISHING_FALLBACK);
        }
    },

    handleInteraction: async (interaction, client) => {
        try {
        if (interaction.customId && /^fish_\d+_\d+$/.test(interaction.customId)) {
            const targetId = interaction.customId.split('_')[1];
            if (activeReelButtons.get(interaction.customId)) return;
            if (interaction.user.id !== targetId) {
                return safeInteractionReply(interaction, "That bite wasn't yours, grabby hands! Start your own `!fish` (or `!fih`), baka! (¬_¬)");
            }
            return safeInteractionReply(interaction, "That fish already escaped! Click faster next time, slowpoke! (¬_¬)");
        }

        if (interaction.customId && interaction.customId.startsWith('fish_bag_')) {
            const parts = interaction.customId.split('_');
            const action = parts[2]; // prev, next, pin, lock
            const targetId = parts[3];
            const pageStr = parts[4];
            let page = parseInt(pageStr) || 0;

            if (interaction.user.id !== targetId) {
                return safeInteractionReply(interaction, "Look at your own bag! (¬_¬)");
            }
            if (!await safeDeferUpdate(interaction)) return;

            let userObj = await User.findOne({ userId: targetId });
            if (!userObj) return safeInteractionReply(interaction, "I can't find your fishing data! Try `!fish` (or `!fih`) first, baka! (¬_¬)");

            if (action === 'prev') page = Math.max(0, page - 1);
            if (action === 'next') page++;

            if (action === 'lock' || action === 'pin') {
                if (activeGames.get(targetId)) {
                    return safeInteractionReply(interaction, "Your bucket is busy right now! Finish the fish/sell action first, baka! (¬_¬)");
                }

                const selectionParts = interaction.values[0].split('|');
                const [indexStr] = selectionParts;
                let selectedIndex = parseInt(indexStr);
                
                if (isNaN(selectedIndex)) return safeInteractionReply(interaction, "Invalid selection, idiot! Did you click with your eyes closed?! (¬_¬)");
                
                const inventory = userObj.fishing?.inventory;
                if (!inventory || inventory.length === 0) {
                    return safeInteractionReply(interaction, "Your bag is empty! There's nothing to interact with! (¬_¬)");
                }
                
                let f = inventory[selectedIndex];
                const isCurrentSelection = (fish) => {
                    if (!fish) return false;
                    if (selectionParts.length === 2) return fishFingerprint(fish) === selectionParts[1];
                    const legacySpecies = selectionParts[1];
                    const legacyWeight = parseFloat(selectionParts[2]);
                    return fish.species === legacySpecies && fish.weight === legacyWeight;
                };

                // Verify it's the exact same fish (prevents shifting array exploit)
                if (!isCurrentSelection(f)) {
                    // Fallback: search the array for a matching fish
                    selectedIndex = inventory.findIndex(fish => isCurrentSelection(fish));
                    if (selectedIndex === -1) {
                        return safeInteractionReply(interaction, "Fish not found! The bag probably shifted because you sold something. Refresh the page! (¬_¬)");
                    }
                    f = inventory[selectedIndex];
                }

                if (action === 'lock') {
                    const newLocked = !f.locked;
                    const lockRes = await User.updateOne(
                        { userId: targetId, ...fishFieldFilter(selectedIndex, f) },
                        { $set: { [`fishing.inventory.${selectedIndex}.locked`]: newLocked } }
                    );
                    if (lockRes.modifiedCount === 0) {
                        return safeInteractionReply(interaction, "That fish shifted while I was locking it! Refresh your bag, baka! (¬_¬)");
                    }
                    userObj.fishing.inventory[selectedIndex].locked = newLocked;
                } else if (action === 'pin') {
                    const fishStillExists = await User.exists({ userId: targetId, ...fishFieldFilter(selectedIndex, f) });
                    if (!fishStillExists) {
                        return safeInteractionReply(interaction, "That fish shifted while I was pinning it! Refresh your bag, baka! (¬_¬)");
                    }
                    const pinName = `[${f.rarity}] ${f.species} — ${f.weight} lbs`;
                    let pinned = userObj.fishing.pinned || [];
                    if (pinned.includes(pinName)) {
                        pinned = pinned.filter(p => p !== pinName);
                    } else {
                        if (pinned.length >= 5) {
                            return safeInteractionReply(interaction, "You can only pin up to 5 fishes! Unpin one first! (¬_¬)");
                        }
                        pinned.push(pinName);
                    }
                    await User.updateOne({ userId: targetId }, { $set: { "fishing.pinned": pinned } });
                    userObj.fishing.pinned = pinned;
                }
            }

            return handleBag(interaction, client, userObj, page);
        }

        if (interaction.customId && interaction.customId.startsWith('fish_travel_')) {
            const targetId = interaction.customId.split('_')[2];
            if (interaction.user.id !== targetId) {
                return safeInteractionReply(interaction, "Book your own flight! (¬_¬)");
            }
            try {
                if (!await safeDeferUpdate(interaction)) return;
                
                const biomeId = interaction.values[0].replace('biome_', '');
                const biomeInfo = config.FISHING.BIOMES[biomeId];
                if (!biomeInfo) {
                    return safeInteractionReply(interaction, "Where are you trying to go?! That place doesn't exist! (¬_¬)");
                }
                
                const userObj = await User.findOne({ userId: targetId });
                if (!userObj) {
                    return safeInteractionReply(interaction, "I can't find your fishing data! Try `!fish` (or `!fih`) first, baka! (¬_¬)");
                }
                const totalCaught = userObj?.fishing?.stats?.totalCaught || 0;
                
                if (totalCaught < biomeInfo.reqCatches) {
                    return safeInteractionReply(interaction, `You're not experienced enough to go to ${biomeInfo.name}! You need ${biomeInfo.reqCatches} catches! (¬_¬)`);
                }
                
                const activeRodId = userObj.fishing?.gear?.activeRod || 'flimsy_stick';
                const activeRodInfo = getRodInfo(activeRodId);
                const activeRodCost = activeRodInfo.cost;
                const reqRodInfo = biomeInfo.reqRod ? getRodInfo(biomeInfo.reqRod) : config.FISHING.GEAR.RODS.flimsy_stick;
                const reqRodCost = reqRodInfo.cost;
                
                if (activeRodCost < reqRodCost) {
                    return safeInteractionReply(interaction, `You can't go to ${biomeInfo.name} with that garbage rod! You need at least a **${reqRodInfo.name}**! (¬_¬)`);
                }
                
                if (userObj.fishing?.biome === biomeId) {
                    return safeInteractionReply(interaction, `You're already at ${biomeInfo.name}, idiot! (¬_¬)`);
                }
                
                const scaledCost = Math.floor(Math.min(biomeInfo.travelCostMax || Infinity, (biomeInfo.travelCost || 0) + (userObj.coins || 0) * (biomeInfo.travelCostWalletRate || 0)));
                
                if ((userObj.coins || 0) < scaledCost) {
                    return safeInteractionReply(interaction, `You're too broke! You need **${scaledCost.toLocaleString('en-US')} Coins** to travel to ${biomeInfo.name}! (¬_¬)`);
                }
                
                const allowedRodIds = Object.entries(config.FISHING.GEAR.RODS)
                    .filter(([, rod]) => rod.cost >= reqRodCost)
                    .map(([rodId]) => rodId);
                const travelFilter = {
                    userId: targetId,
                    coins: { $gte: scaledCost },
                    'fishing.biome': { $ne: biomeId }
                };
                if (biomeInfo.reqCatches > 0) {
                    travelFilter['fishing.stats.totalCaught'] = { $gte: biomeInfo.reqCatches };
                }
                if (reqRodCost > 0) {
                    travelFilter['fishing.gear.activeRod'] = { $in: allowedRodIds };
                }

                const updateRes = await User.findOneAndUpdate(
                    travelFilter,
                    { 
                        $inc: { coins: -scaledCost, systemSpent: scaledCost },
                        $set: { 'fishing.biome': biomeId }
                    },
                    { returnDocument: 'after' }
                );
                
                if (!updateRes) {
                    return safeInteractionReply(interaction, `Travel failed! Your coins, rod, catches, or location changed while booking. Try again, slippery baka! (¬_¬)`);
                }
                
                return safeInteractionUpdate(interaction, { 
                    content: `✈️ You paid **${scaledCost.toLocaleString('en-US')} Coins** and traveled to **${biomeInfo.emoji} ${biomeInfo.name}**! Get your rod ready! (¬_¬)`,
                    embeds: [],
                    components: []
                });
            } finally {
                activeGames.delete(targetId);
            }
        }

        if (interaction.customId && interaction.customId.startsWith('fish_bounty_claim_')) {
            const targetId = interaction.customId.split('_')[3];
            if (interaction.user.id !== targetId) {
                return safeInteractionReply(interaction, "This isn't your bounty, thief! (¬_¬)");
            }
            if (!await safeDeferUpdate(interaction)) return;

            const userObj = await User.findOne({ userId: targetId });
            if (!userObj || !userObj.fishing?.dailyBounty) {
                return safeInteractionReply(interaction, "You don't have an active bounty! (¬_¬)");
            }

            const bounty = userObj.fishing.dailyBounty;
            if (bounty.expiresAt < Date.now()) {
                return safeInteractionReply(interaction, "Your bounty has already expired, slowpoke! (¬_¬)");
            }
            if (bounty.amountCaught < bounty.amountNeeded) {
                return safeInteractionReply(interaction, "You haven't finished this bounty yet, idiot! Keep fishing! (¬_¬)");
            }
            if (bounty.claimed) {
                return safeInteractionReply(interaction, "You already claimed this, thief! (¬_¬)");
            }

            // Reward Calculation
            const tierData = config.FISHING.BOUNTIES.TIERS[bounty.rewardTier];
            if (!tierData) {
                return safeInteractionReply(interaction, "S-Something broke with your reward tier! I didn't mess it up, the system did! >///< Try again later!");
            }

            const baseCoinReward = getScalingValue(userObj.coins || 0, config.FISHING.REWARD_BASE);
            const coinReward = Math.floor(baseCoinReward * (tierData.rewardMultipliers.baseCoinMult || 1.0));
            
            let nuggetReward = tierData.rewardMultipliers.nuggets || 0;
            if (tierData.rewardMultipliers.nuggetChance && Math.random() * 100 < tierData.rewardMultipliers.nuggetChance) {
                nuggetReward += 1;
            }

            const updateQuery = {
                $inc: { nuggets: nuggetReward },
                $set: { 'fishing.dailyBounty.claimed': true } // Mark as claimed
            };

            const claimRes = await User.findOneAndUpdate(
                { 
                    userId: targetId, 
                    'fishing.dailyBounty.amountCaught': { $gte: bounty.amountNeeded },
                    'fishing.dailyBounty.expiresAt': { $gt: Date.now() },
                    'fishing.dailyBounty.claimed': { $ne: true }
                },
                updateQuery
            );
            
            if (!claimRes) {
                return safeInteractionReply(interaction, "You already claimed this, thief! (¬_¬)");
            }

            // Route Coins through distributeIncome for taxes/prestige
            let log = "";
            try {
                log = await distributeIncome(targetId, coinReward);
            } catch (e) {
                console.error("Fishing bounty payout failed:", e);
                const rollbackUpdate = {
                    $set: { 'fishing.dailyBounty': bounty }
                };
                if (nuggetReward > 0) rollbackUpdate.$inc = { nuggets: -nuggetReward };
                let restored = true;
                await User.updateOne({ userId: targetId }, rollbackUpdate).catch(err => {
                    restored = false;
                    console.error("Fishing bounty rollback failed:", err);
                });
                return safeInteractionReply(
                    interaction,
                    restored
                        ? "S-Something broke while paying the bounty, so I restored it. Try claiming again in a moment! >///<"
                        : "S-Something broke while paying the bounty, and I couldn't confirm the rollback. Tell an admin before claiming again, baka! >///<"
                );
            }

            let rewardStr = `**${coinReward.toLocaleString('en-US')} Base Coins**`;
            if (nuggetReward > 0) rewardStr += ` and **${nuggetReward} Nuggets**`;

            return safeInteractionUpdate(interaction, { 
                content: `🎉 **Bounty Complete!**\nYou received ${rewardStr}! Now go away! (¬_¬)\n${log}`,
                embeds: [],
                components: []
            });
        }

        if (interaction.customId && interaction.customId.startsWith('fish_again_')) {
            const targetId = interaction.customId.split('_')[2];
            if (interaction.user.id !== targetId) {
                return safeInteractionReply(interaction, "Get your own rod! (¬_¬)");
            }
            
            // Strip the old button to prevent multi-clicks
            const acknowledged = await safeInteractionUpdate(interaction, { components: [] });
            if (!acknowledged) return;
            
            // Execute fishing loop anew via the button interaction context
            return await executeFishing(interaction, true);
        }

        if (interaction.customId && interaction.customId.startsWith('fish_')) {
            return safeInteractionReply(interaction, "That fishing button is stale or malformed. Use `!fish` (or `!fih`) again, baka! (¬_¬)");
        }
        } catch (e) {
            const userId = interaction.user?.id;
            if (userId) activeGames.delete(userId);
            console.error("Fishing interaction handler error:", e);
            return safeInteractionReply(interaction, GENERIC_FISHING_FALLBACK);
        }
    },
    handleBag,
    getUserAutocastTier,
    activeGames,
    activeAutocastSessions
};
