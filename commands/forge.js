const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, MessageFlags } = require('discord.js');
const User = require('../models/User');
const Loan = require('../models/Loan');
const config = require('../config');
const { getVaultCap } = require('../utils/helpers');

// Upgrade costs per tier (index = current tier → next tier)
const WALLET_COSTS = config.FORGE.WALLET_COSTS;
const VAULT_COSTS  = config.FORGE.VAULT_COSTS;

const MAX_WALLET_TIER = config.FORGE.MAX_WALLET_TIER;
const MAX_VAULT_TIER = config.FORGE.MAX_VAULT_TIER;

function getWalletCap(prestige, walletTier) {
    return config.ECONOMY.BASE_WALLET_CAP + (prestige * config.ECONOMY.WALLET_CAP_PER_LEVEL) + (walletTier * config.ECONOMY.FORGE_WALLET_CAP_PER_TIER);
}

function buildStatusEmbed(user, displayName) {
    const prestige = user.prestige || 0;
    const walletTier = user.upgrades?.walletTier || 0;
    const vaultTier = user.upgrades?.vaultTier || 0;
    const nuggets = user.nuggets || 0;

    const walletCap = getWalletCap(prestige, walletTier);
    const vaultCap = getVaultCap(prestige, vaultTier, user.titanVaultUsed);

    const activeItems = [];
    if ((user.goldenAmuletCount || 0) > 0) activeItems.push(`🪙 Golden Amulets ×${user.goldenAmuletCount}/3`);
    if (user.titanVaultUsed) activeItems.push('🏛️ Titan Vault (2× capacity)');

    const embed = new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle(`💎 ${displayName}'s Forge`)
        .setDescription(`*Hmph... fine, here's your forge status. Don't stare at it too long! (¬_¬)*`)
        .addFields(
            { name: '💎 Nuggets', value: `\`${nuggets.toLocaleString('en-US')}\``, inline: true },
            { name: '⬆️ Wallet Tier', value: `\`${walletTier}/${MAX_WALLET_TIER}\``, inline: true },
            { name: '⬆️ Vault Tier', value: `\`${vaultTier}/${MAX_VAULT_TIER}\``, inline: true },
            { name: '💰 Wallet Cap', value: `\`${walletCap.toLocaleString('en-US')}\``, inline: true },
            { name: '🏦 Vault Cap', value: `\`${vaultCap.toLocaleString('en-US')}\``, inline: true },
            { name: '\u200b', value: '\u200b', inline: true },
            {
                name: '🔮 Active Forge Items',
                value: activeItems.length > 0 ? activeItems.join('\n') : '*None — go buy something, cheapskate! >////<*',
                inline: false
            }
        );

    return embed;
}

function buildUpgradeEmbed(type, user) {
    const isWallet = type === 'wallet';
    const maxTier = isWallet ? MAX_WALLET_TIER : MAX_VAULT_TIER;
    const currentTier = isWallet ? (user.upgrades?.walletTier || 0) : (user.upgrades?.vaultTier || 0);
    const costs = isWallet ? WALLET_COSTS : VAULT_COSTS;
    const prestige = user.prestige || 0;
    const nuggets = user.nuggets || 0;
    const label = isWallet ? 'Wallet' : 'Vault';
    const capPerTier = isWallet ? config.ECONOMY.FORGE_WALLET_CAP_PER_TIER : config.VAULT.TIER_CAPACITY_MULTIPLIER;

    const capFn = (tier) => isWallet
        ? getWalletCap(prestige, tier)
        : getVaultCap(prestige, tier, user.titanVaultUsed);

    const tierLines = [];
    for (let i = 0; i < maxTier; i++) {
        const tierNum = i + 1;
        const cost = costs[i];
        const cap = capFn(tierNum);
        if (i < currentTier) {
            tierLines.push(`✅ **Tier ${tierNum}** — +${(capPerTier / 1000000).toFixed(0)}M cap (${cap.toLocaleString('en-US')}) — *Unlocked*`);
        } else if (i === currentTier) {
            tierLines.push(`➡️ **Tier ${tierNum}** — +${(capPerTier / 1000000).toFixed(0)}M cap (${cap.toLocaleString('en-US')}) — **${cost} Nuggets**`);
        } else {
            tierLines.push(`🔒 **Tier ${tierNum}** — +${(capPerTier / 1000000).toFixed(0)}M cap (${cap.toLocaleString('en-US')}) — ${cost} Nuggets`);
        }
    }

    const nextCost = currentTier < maxTier ? costs[currentTier] : null;
    const canUpgrade = nextCost !== null && nuggets >= nextCost;

    const embed = new EmbedBuilder()
        .setColor(isWallet ? 0xF1C40F : 0x3498DB)
        .setTitle(`⬆️ ${label} Upgrades`)
        .setDescription(
            `**Current Tier:** ${currentTier}/${maxTier}\n` +
            `**Current ${label} Cap:** ${capFn(currentTier).toLocaleString('en-US')}\n` +
            `💎 **Your Nuggets:** ${nuggets}\n\n` +
            tierLines.join('\n')
        );

    const customId = isWallet ? 'forge_wallet_upgrade' : 'forge_vault_upgrade';
    const upgradeBtn = new ButtonBuilder()
        .setCustomId(customId)
        .setLabel(currentTier >= maxTier ? 'MAX TIER' : `Upgrade Tier ${currentTier}→${currentTier + 1} (${nextCost} 💎)`)
        .setStyle(ButtonStyle.Success)
        .setDisabled(!canUpgrade);

    const backBtn = new ButtonBuilder()
        .setCustomId('forge_back')
        .setLabel('◀ Back')
        .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(upgradeBtn, backBtn);

    return { embed, row };
}

function buildShopEmbed(user) {
    const nuggets = user.nuggets || 0;
    const amuletCount = user.goldenAmuletCount || 0;

    const embed = new EmbedBuilder()
        .setColor(0xE74C3C)
        .setTitle('🛒 Nugget Shop')
        .setDescription(
            `💎 **Your Nuggets:** ${nuggets}\n\n` +
            `*Pick something already! I don't have all day! (¬_¬)*`
        )
        .addFields(
            { name: `🥇 Golden Amulet — ${config.FORGE.SHOP.GOLDEN_AMULET_COST}💎`, value: `+0.2× income multiplier permanently (${amuletCount}/3 owned)`, inline: false },
            { name: `🏛️ Titan Vault — ${config.FORGE.SHOP.TITAN_VAULT_COST}💎`, value: `2× vault capacity (${user.titanVaultUsed ? '✅ Purchased' : 'Not owned'})`, inline: false },
            { name: `💳 Debt Forgiveness — ${config.FORGE.SHOP.DEBT_FORGIVENESS_COST}💎`, value: 'Wipe your entire active loan instantly', inline: false },
        );

    const menu = new StringSelectMenuBuilder()
        .setCustomId('forge_shop_select')
        .setPlaceholder('Select an item to purchase...')
        .addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel(`Golden Amulet (${config.FORGE.SHOP.GOLDEN_AMULET_COST}💎)`)
                .setDescription(`+0.2× income — ${amuletCount}/3 owned`)
                .setValue('shop_golden_amulet')
                .setEmoji('🥇'),
            new StringSelectMenuOptionBuilder()
                .setLabel(`Titan Vault (${config.FORGE.SHOP.TITAN_VAULT_COST}💎)`)
                .setDescription(`2× vault cap — ${user.titanVaultUsed ? 'Already purchased' : 'Available'}`)
                .setValue('shop_titan_vault')
                .setEmoji('🏛️'),
            new StringSelectMenuOptionBuilder()
                .setLabel(`Debt Forgiveness (${config.FORGE.SHOP.DEBT_FORGIVENESS_COST}💎)`)
                .setDescription('Wipe active loan instantly')
                .setValue('shop_debt_forgiveness')
                .setEmoji('💳')
        );

    const menuRow = new ActionRowBuilder().addComponents(menu);
    const backBtn = new ButtonBuilder()
        .setCustomId('forge_back')
        .setLabel('◀ Back')
        .setStyle(ButtonStyle.Secondary);
    const btnRow = new ActionRowBuilder().addComponents(backBtn);

    return { embed, components: [menuRow, btnRow] };
}

module.exports = {
    handle: async (message, client) => {
        const args = message.content.toLowerCase().split(/\s+/);
        const sub = args[1];

        const user = await User.findOne({ userId: message.author.id });
        if (!user) return message.reply("Who are you? Go send a message first so I know you exist! (¬_¬)");

        // !forge wallet
        if (sub === 'wallet') {
            const { embed, row } = buildUpgradeEmbed('wallet', user);
            return message.reply({ embeds: [embed], components: [row] });
        }

        // !forge vault
        if (sub === 'vault') {
            const { embed, row } = buildUpgradeEmbed('vault', user);
            return message.reply({ embeds: [embed], components: [row] });
        }

        // !forge (status)
        const member = await message.guild.members.fetch(message.author.id).catch(() => null);
        const displayName = member ? member.displayName : message.author.username;

        const embed = buildStatusEmbed(user, displayName);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('forge_wallet_page').setLabel('⬆️ Wallet').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('forge_vault_page').setLabel('⬆️ Vault').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('forge_shop_page').setLabel('🛒 Shop').setStyle(ButtonStyle.Success)
        );

        return message.reply({ embeds: [embed], components: [row] });
    },

    handleInteraction: async (interaction, client) => {
        if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;
        if (!interaction.customId.startsWith('forge_')) return;

        const user = await User.findOne({ userId: interaction.user.id });
        if (!user) return interaction.reply({ content: "Who are you?! Go send a message first! (¬_¬)", flags: MessageFlags.Ephemeral });

        // --- WALLET PAGE ---
        if (interaction.customId === 'forge_wallet_page') {
            const { embed, row } = buildUpgradeEmbed('wallet', user);
            return interaction.update({ embeds: [embed], components: [row] });
        }

        // --- VAULT PAGE ---
        if (interaction.customId === 'forge_vault_page') {
            const { embed, row } = buildUpgradeEmbed('vault', user);
            return interaction.update({ embeds: [embed], components: [row] });
        }

        // --- SHOP PAGE ---
        if (interaction.customId === 'forge_shop_page') {
            const { embed, components } = buildShopEmbed(user);
            return interaction.update({ embeds: [embed], components });
        }

        // --- BACK TO STATUS ---
        if (interaction.customId === 'forge_back') {
            const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
            const displayName = member ? member.displayName : interaction.user.username;
            const freshUser = await User.findOne({ userId: interaction.user.id });
            if (!freshUser) return interaction.reply({ content: "Wait, where did your profile go?! T-Try again! >///<", flags: MessageFlags.Ephemeral });

            const embed = buildStatusEmbed(freshUser, displayName);
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('forge_wallet_page').setLabel('⬆️ Wallet').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('forge_vault_page').setLabel('⬆️ Vault').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('forge_shop_page').setLabel('🛒 Shop').setStyle(ButtonStyle.Success)
            );

            return interaction.update({ embeds: [embed], components: [row] });
        }

        // --- WALLET UPGRADE ---
        if (interaction.customId === 'forge_wallet_upgrade') {
            const currentTier = user.upgrades?.walletTier || 0;
            if (currentTier >= MAX_WALLET_TIER) {
                return interaction.reply({ content: "Already maxed out! What more do you want?! (¬_¬)", flags: MessageFlags.Ephemeral });
            }

            const cost = WALLET_COSTS[currentTier];
            if ((user.nuggets || 0) < cost) {
                return interaction.reply({ content: `You need **${cost} Nuggets** but only have **${user.nuggets || 0}**. Go earn more, broke-ass! (¬_¬)`, flags: MessageFlags.Ephemeral });
            }

            const walletTierFilter = currentTier === 0 ? { $in: [0, null] } : currentTier;
            const result = await User.findOneAndUpdate(
                { userId: interaction.user.id, nuggets: { $gte: cost }, 'upgrades.walletTier': walletTierFilter },
                { $inc: { nuggets: -cost, 'upgrades.walletTier': 1 } },
                { new: true }
            );

            if (!result) {
                return interaction.reply({ content: "Something changed while upgrading! Try again! >////<", flags: MessageFlags.Ephemeral });
            }

            const newCap = getWalletCap(result.prestige || 0, result.upgrades.walletTier);
            const { embed, row } = buildUpgradeEmbed('wallet', result);
            embed.setFooter({ text: `⬆️ Wallet Tier upgraded to ${result.upgrades.walletTier}! New cap: ${newCap.toLocaleString('en-US')}` });
            return interaction.update({ embeds: [embed], components: [row] });
        }

        // --- VAULT UPGRADE ---
        if (interaction.customId === 'forge_vault_upgrade') {
            const currentTier = user.upgrades?.vaultTier || 0;
            if (currentTier >= MAX_VAULT_TIER) {
                return interaction.reply({ content: "Already maxed out! What more do you want?! (¬_¬)", flags: MessageFlags.Ephemeral });
            }

            const cost = VAULT_COSTS[currentTier];
            if ((user.nuggets || 0) < cost) {
                return interaction.reply({ content: `You need **${cost} Nuggets** but only have **${user.nuggets || 0}**. Go earn more, broke-ass! (¬_¬)`, flags: MessageFlags.Ephemeral });
            }

            const vaultTierFilter = currentTier === 0 ? { $in: [0, null] } : currentTier;
            const result = await User.findOneAndUpdate(
                { userId: interaction.user.id, nuggets: { $gte: cost }, 'upgrades.vaultTier': vaultTierFilter },
                { $inc: { nuggets: -cost, 'upgrades.vaultTier': 1 } },
                { new: true }
            );

            if (!result) {
                return interaction.reply({ content: "Something changed while upgrading! Try again! >////<", flags: MessageFlags.Ephemeral });
            }

            const newCap = getVaultCap(result.prestige || 0, result.upgrades.vaultTier, result.titanVaultUsed);
            const { embed, row } = buildUpgradeEmbed('vault', result);
            embed.setFooter({ text: `⬆️ Vault Tier upgraded to ${result.upgrades.vaultTier}! New cap: ${newCap.toLocaleString('en-US')}` });
            return interaction.update({ embeds: [embed], components: [row] });
        }

        // ==================== SHOP PURCHASES ====================
        if (interaction.customId === 'forge_shop_select') {
            const choice = interaction.values[0];
            const freshUser = await User.findOne({ userId: interaction.user.id });
            if (!freshUser) return interaction.reply({ content: "Where did your data go?! Try again! >///<", flags: MessageFlags.Ephemeral });

            // --- GOLDEN AMULET ---
            if (choice === 'shop_golden_amulet') {
                const cost = config.FORGE.SHOP.GOLDEN_AMULET_COST;
                if ((freshUser.goldenAmuletCount || 0) >= 3) {
                    return interaction.reply({ content: "You already have **3/3 Golden Amulets**. Greedy much? (¬_¬)", flags: MessageFlags.Ephemeral });
                }
                if ((freshUser.nuggets || 0) < cost) {
                    return interaction.reply({ content: `Need **${cost} Nuggets**, you only have **${freshUser.nuggets || 0}**. Pathetic! (¬_¬)`, flags: MessageFlags.Ephemeral });
                }

                const result = await User.findOneAndUpdate(
                    {
                        userId: interaction.user.id,
                        nuggets: { $gte: cost },
                        $or: [{ goldenAmuletCount: { $lt: 3 } }, { goldenAmuletCount: { $exists: false } }]
                    },
                    { $inc: { nuggets: -cost, goldenAmuletCount: 1 } },
                    { new: true }
                );
                if (!result) return interaction.reply({ content: "Purchase failed! Something shifted. Try again! >////<", flags: MessageFlags.Ephemeral });

                const { embed, components } = buildShopEmbed(result);
                embed.setFooter({ text: `🥇 Golden Amulet purchased! (${result.goldenAmuletCount}/3) — 💎 ${result.nuggets} remaining` });
                return interaction.update({ embeds: [embed], components });
            }

            // --- TITAN VAULT (one-time) ---
            if (choice === 'shop_titan_vault') {
                const cost = config.FORGE.SHOP.TITAN_VAULT_COST;
                if (freshUser.titanVaultUsed) {
                    return interaction.reply({ content: "Already doubled! Your vault is as big as it gets! (¬_¬)", flags: MessageFlags.Ephemeral });
                }
                if ((freshUser.nuggets || 0) < cost) {
                    return interaction.reply({ content: `Need **${cost} Nuggets**, you only have **${freshUser.nuggets || 0}**. Pathetic! (¬_¬)`, flags: MessageFlags.Ephemeral });
                }

                const result = await User.findOneAndUpdate(
                    { userId: interaction.user.id, nuggets: { $gte: cost }, titanVaultUsed: { $in: [false, null] } },
                    { $inc: { nuggets: -cost }, $set: { titanVaultUsed: true } },
                    { new: true }
                );
                if (!result) return interaction.reply({ content: "Purchase failed! Something shifted. Try again! >////<", flags: MessageFlags.Ephemeral });

                const newCap = getVaultCap(result.prestige || 0, result.upgrades?.vaultTier || 0, true);
                const { embed, components } = buildShopEmbed(result);
                embed.setFooter({ text: `🏛️ Titan Vault activated! New vault cap: ${newCap.toLocaleString('en-US')} — 💎 ${result.nuggets} remaining` });
                return interaction.update({ embeds: [embed], components });
            }

            // --- DEBT FORGIVENESS ---
            if (choice === 'shop_debt_forgiveness') {
                const cost = config.FORGE.SHOP.DEBT_FORGIVENESS_COST;
                if ((freshUser.nuggets || 0) < cost) {
                    return interaction.reply({ content: `Need **${cost} Nuggets**, you only have **${freshUser.nuggets || 0}**. Pathetic! (¬_¬)`, flags: MessageFlags.Ephemeral });
                }

                const loan = await Loan.findOne({
                    borrowerId: interaction.user.id,
                    status: { $in: ['ACTIVE', 'DEFAULTED'] }
                }).sort({ dueDate: 1 });

                if (!loan) {
                    return interaction.reply({ content: "You don't even HAVE a loan, idiot! What a waste of my time! (¬_¬)", flags: MessageFlags.Ephemeral });
                }

                // Wipe the loan
                await Loan.updateOne(
                    { _id: loan._id },
                    { $set: { remainingAmount: 0, status: 'PAID' } }
                );

                // Deduct nuggets and free from slavery if applicable
                const updateOps = { $inc: { nuggets: -cost } };
                if (freshUser.isSlave) {
                    updateOps.$set = {
                        isSlave: false,
                        slaveOwner: null,
                        carrotResistUsed: false,
                        resistExpiresAt: 0,
                        'activeCarrot.amount': 0,
                        'activeCarrot.bonusPerHr': 0,
                        'activeCarrot.expiresAt': 0,
                        'activeCarrot.ownerId': null
                    };
                }

                const result = await User.findOneAndUpdate(
                    { userId: interaction.user.id, nuggets: { $gte: cost } },
                    updateOps,
                    { new: true }
                );
                if (!result) return interaction.reply({ content: "Purchase failed! Something shifted. Try again! >////<", flags: MessageFlags.Ephemeral });

                const freedMsg = freshUser.isSlave ? '\n⛓️ You are now FREE from slavery!' : '';
                const { embed, components } = buildShopEmbed(result);
                embed.setFooter({ text: `💳 Loan wiped! ${loan.remainingAmount.toLocaleString('en-US')}c debt forgiven!${freedMsg} — 💎 ${result.nuggets} remaining` });
                return interaction.update({ embeds: [embed], components });
            }

        }
    }
};

