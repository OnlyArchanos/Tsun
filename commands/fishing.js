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

    const validSubs = new Set(['charter', 'travel', 'inv', 'inventory', 'bag', 'repair', 'sell', 'bait', 'shop', 'quest', 'bounty', 'pin', 'unpin', 'trade']);
    if (sub && !validSubs.has(sub)) {
        return replyMsg({ content: `I don't know \`!fish ${sub}\`, baka! Use \`!fish\`, \`!fish travel\`, \`!fish bag\`, \`!fish sell all\`, \`!fish repair\`, \`!fish trade\`, or \`!fish quest\`. (¬_¬)` });
    }

    // Check if user has active minigame or is in a locked transaction
    if (sub === 'sell' || sub === 'inv' || sub === 'bag' || sub === 'quest' || sub === 'bounty' || sub === 'pin' || sub === 'unpin') {
        if ((sub === 'sell' || sub === 'pin' || sub === 'unpin') && activeGames.get(authorId)) {
            return replyMsg({ content: "You're currently fishing! Finish reeling it in first, baka! (¬_¬)" });
        }
    } else {
        if (activeGames.get(authorId)) {
            return replyMsg({ content: "H-Hey! You already have your rod cast somewhere else! Finish that first, idiot! (¬_¬)" });
        }
        // Lock immediately to prevent concurrent spam triggering multiple DB calls
        activeGames.set(authorId, true);
    }

    let user = await User.findOneAndUpdate(
        { userId: authorId },
        { $setOnInsert: { userId: authorId } },
        { upsert: true, new: true }
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

            const updateRes = await User.findOneAndUpdate(filterQuery, updateFields, { new: true });

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
            { new: true }
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

    let desc = `📍 **Biome:** ${formatName(biome)} | 🎣 **Rod:** ${formatName(activeRod)} (${durabilityText})\n\n`;

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
                    { new: true }
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
    activeGames
};
