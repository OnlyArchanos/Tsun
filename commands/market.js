const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags
} = require('discord.js');
const User = require('../models/User');
const MarketListing = require('../models/MarketListing');
const GACHA_TITLES = require('../config/gachaTitles');
const { getDisplayName } = require('../utils/helpers');
const { distributeIncome } = require('../utils/income');
const config = require('../config');

// Import from centralized config
const SHOP_BASE_PRICES = config.SHOP_PRICES;
const SHOP_TITLE_PRICE = config.SHOP_PRICES.TITLE_PRICE;
const GACHA_MIN_PRICES = config.GACHA_MIN_PRICES;
const NON_TITLE_ITEMS = config.ITEMS.NON_TITLE;
const FRAME_COLORS = config.ITEMS.FRAME_COLORS;
const SHOP_TITLES = config.ITEMS.SHOP_TITLES;

// Generate unique listing ID
function generateListingId() {
    return 'M' + Math.random().toString(36).substr(2, 5).toUpperCase();
}

// Get gacha rarity for a title
function getGachaRarity(titleName) {
    for (const [rarity, titles] of Object.entries(GACHA_TITLES)) {
        if (titles.includes(titleName)) {
            return rarity;
        }
    }
    return null;
}

// Get minimum price for an item
function getMinPrice(itemName) {
    // Check if it's a shop item
    if (SHOP_BASE_PRICES[itemName]) {
        return Math.floor(SHOP_BASE_PRICES[itemName] * config.MARKET.MIN_PRICE_MODIFIER);
    }

    // Check if it's a frame color
    if (FRAME_COLORS.includes(itemName)) {
        return Math.floor(config.MARKET.FRAME_BASE_PRICE * config.MARKET.MIN_PRICE_MODIFIER); // Random frame base price
    }

    // Check if it's a shop title
    const normalizedName = itemName.toLowerCase();
    const isShopTitle = SHOP_TITLES.some(t => t.toLowerCase() === normalizedName);
    if (isShopTitle) {
        return Math.floor(SHOP_TITLE_PRICE * config.MARKET.MIN_PRICE_MODIFIER);
    }

    // Check if it's a gacha title
    const rarity = getGachaRarity(itemName);
    if (rarity && GACHA_MIN_PRICES[rarity]) {
        return GACHA_MIN_PRICES[rarity];
    }

    // Default for unknown items (treat as common title)
    return config.MARKET.DEFAULT_UNKNOWN_PRICE;
}

// Format time remaining
function formatTimeRemaining(expiresAt) {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) return 'Expired';

    const days = Math.floor(remaining / (24 * 60 * 60 * 1000));
    const hours = Math.floor((remaining % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));

    if (days > 0) return `${days}d ${hours}h`;
    return `${hours}h`;
}

module.exports = {
    // --- MAIN COMMAND HANDLER ---
    handle: async (message, client) => {
        const content = message.content.toLowerCase();
        if (!content.startsWith('!market')) return;

        const args = message.content.split(' ').slice(1);
        const subCommand = args[0]?.toLowerCase();
        const directPageArg = parseInt(args[0], 10);
        const isDirectPageRequest = Number.isInteger(directPageArg) && directPageArg > 0;

        // Fetch user
        let user = await User.findOne({ userId: message.author.id });
        if (!user) user = await User.create({ userId: message.author.id });

        // Bot ban check
        if (user.botBanExpiry && user.botBanExpiry > Date.now()) {
            return message.reply("🚫 You're banned from the bot! No marketplace for you! (¬_¬)");
        }

        // ==================== !MARKET (View All Listings) ====================
        if (!subCommand || subCommand === 'browse' || isDirectPageRequest) {
            const page = isDirectPageRequest ? directPageArg : (parseInt(args[1], 10) || 1);
            const perPage = 10;
            const skip = (page - 1) * perPage;

            const totalListings = await MarketListing.countDocuments({ expiresAt: { $gt: new Date() } });
            const totalPages = Math.ceil(totalListings / perPage) || 1;

            if (page > totalPages && totalListings > 0) {
                const emptyEmbed = new EmbedBuilder()
                    .setColor(0x2B2D31)
                    .setTitle("🏪 MARKETPLACE PAGE NOT FOUND")
                    .setDescription(`Page **${page}** doesn't exist!\nThere are only **${totalPages}** pages. (¬_¬)`)
                    .setFooter({ text: "Learn to count!" });
                return message.reply({ embeds: [emptyEmbed] });
            }

            const listings = await MarketListing.find({ expiresAt: { $gt: new Date() } })
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(perPage);

            if (listings.length === 0 && page === 1) {
                return message.reply("📭 **The marketplace is empty!** No one is selling anything... pathetic! (¬_¬)");
            }

            // Increment view counts
            await MarketListing.updateMany(
                { _id: { $in: listings.map(l => l._id) } },
                { $inc: { views: 1 } }
            );

            let desc = `Currently **${totalListings}** items listed:\n\n`;

            for (const listing of listings) {
                const sellerName = await getDisplayName(listing.sellerId, message.guild);
                const minPrice = getMinPrice(listing.itemName);
                const timeLeft = formatTimeRemaining(listing.expiresAt);

                desc += `━━━━━━━━━━━━━━━━━━━━\n`;
                desc += `**#${listing.listingId}** - ${listing.itemName}\n`;
                desc += `💰 Price: **${listing.price.toLocaleString('en-US')}** coins\n`;
                desc += `👤 Seller: ${sellerName}\n`;
                desc += `⏰ Expires: ${timeLeft}\n`;
            }

            desc += `━━━━━━━━━━━━━━━━━━━━\n\n`;
            desc += `*Type \`!market buy [ID]\` to purchase!* (¬_¬)`;

            const embed = new EmbedBuilder()
                .setColor(0xFF1493)
                .setTitle('🏪 PLAYER MARKETPLACE')
                .setDescription(desc)
                .setFooter({ text: `Page ${page}/${totalPages} • Use !market [page] to navigate` });

            const row = new ActionRowBuilder();

            if (page > 1) {
                row.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`market_page_${page - 1}`)
                        .setLabel('◀ Previous')
                        .setStyle(ButtonStyle.Secondary)
                );
            }

            if (page < totalPages) {
                row.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`market_page_${page + 1}`)
                        .setLabel('Next ▶')
                        .setStyle(ButtonStyle.Secondary)
                );
            }

            const messageOptions = { embeds: [embed] };
            if (row.components.length > 0) {
                messageOptions.components = [row];
            }

            return message.reply(messageOptions);
        }

        // ==================== !MARKET SELL (Interactive) ====================
        if (subCommand === 'sell' || subCommand === 'list') {
            // Slave check
            if (user.isSlave) {
                return message.reply("H-Hah?! Slaves can't sell things! You don't even own yourself, you fool! (¬_¬)");
            }

            // Check listing limit (max 5 active listings per user)
            const userListingCount = await MarketListing.countDocuments({
                sellerId: message.author.id,
                expiresAt: { $gt: new Date() }
            });

            if (userListingCount >= config.MARKET.MAX_LISTINGS_PER_USER) {
                return message.reply(`B-Baka! You already have ${config.MARKET.MAX_LISTINGS_PER_USER} active listings! Cancel one first with \`!market cancel [ID]\`! I'm not your storage box! (¬_¬)`);
            }

            // Get sellable items (exclude equipped title)
            const sellableItems = user.inventory.filter(item => {
                if (user.equippedTitle && item.toLowerCase() === user.equippedTitle.toLowerCase()) {
                    return false;
                }
                return true;
            });

            if (sellableItems.length === 0) {
                return message.reply("Y-Your inventory is empty! What are you trying to sell, air?! Go get some items first! >///< ");
            }

            // Count items for display (handle duplicates)
            const itemCounts = {};
            for (const item of sellableItems) {
                itemCounts[item] = (itemCounts[item] || 0) + 1;
            }

            // Build dropdown options (max 25 for Discord limit)
            const uniqueItems = Object.entries(itemCounts).slice(0, 25);

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('market_sell_select')
                .setPlaceholder("F-Fine! Pick something to sell already...")
                .addOptions(
                    uniqueItems.map(([item, count]) => ({
                        label: count > 1 ? `${item} (x${count})` : item,
                        value: item,
                        description: `Min: ${getMinPrice(item).toLocaleString('en-US')} coins`
                    }))
                );

            const row = new ActionRowBuilder().addComponents(selectMenu);

            const embed = new EmbedBuilder()
                .setColor(0xFF1493)
                .setTitle("🏪 SELL ON MARKETPLACE")
                .setDescription(
                    "I-It's not like I want to help you sell your junk! Just pick an item already!\n\n" +
                    `**${uniqueItems.length}** sellable items found.\n` +
                    `You have **${config.MARKET.MAX_LISTINGS_PER_USER - userListingCount}** listing slots remaining.`
                )
                .setFooter({ text: "D-Don't blame me if no one buys your trash! (¬_¬)" });

            return message.reply({ embeds: [embed], components: [row] });
        }

        // ==================== !MARKET BUY [id] ====================
        if (subCommand === 'buy') {
            const listingId = args[1]?.toUpperCase();

            if (!listingId) {
                return message.reply("❌ Usage: `!market buy [listing ID]`\nExample: `!market buy M12345`");
            }

            // 1. Fetch listing without deleting yet
            const listing = await MarketListing.findOne({
                listingId: listingId.replace('#', ''),
                expiresAt: { $gt: new Date() }
            });

            if (!listing) {
                return message.reply("Are you blind?! That listing doesn't exist anymore! Too slow, loser! >///<");
            }

            // Can't buy your own listing
            if (listing.sellerId === message.author.id) {
                return message.reply("❌ You can't buy your own listing, idiot! Use `!market cancel` instead! (¬_¬)");
            }

            // Check buyer has enough coins
            if (user.coins < listing.price) {
                return message.reply(`❌ You need **${listing.price.toLocaleString('en-US')}** coins! You only have **${user.coins.toLocaleString('en-US')}**!`);
            }

            // Get seller
            const seller = await User.findOne({ userId: listing.sellerId });
            if (!seller) {
                // Seller is gone, clean up the dead listing
                await MarketListing.findByIdAndDelete(listing._id);
                return message.reply("❌ Seller no longer exists! Cancelling listing...");
            }

            // Calculate fees
            const marketFee = Math.floor(listing.price * config.MARKET.FEE_PERCENT);
            const sellerReceives = listing.price - marketFee;

            // 2. Lock the listing by deleting it NOW (Atomic lock against other buyers)
            const lockedListing = await MarketListing.findOneAndDelete({
                _id: listing._id
            });

            if (!lockedListing) {
                 return message.reply("❌ Too slow! Someone just bought it! (¬_¬)");
            }

            // 3. Execute transaction atomically
            const updateRes = await User.findOneAndUpdate(
                { userId: message.author.id, coins: { $gte: listing.price } },
                { 
                    $inc: { coins: -listing.price },
                    $push: { inventory: listing.itemName }
                },
                { new: true }
            );

            if (!updateRes) {
                // Restore listing since they didn't actually have enough money (race condition)
                await MarketListing.create({
                    listingId: lockedListing.listingId,
                    sellerId: lockedListing.sellerId,
                    itemName: lockedListing.itemName,
                    price: lockedListing.price,
                    createdAt: lockedListing.createdAt,
                    expiresAt: lockedListing.expiresAt,
                    views: lockedListing.views
                });
                return message.reply(`❌ Transaction failed! Keep your hands out of empty pockets! You need **${listing.price.toLocaleString('en-US')}** coins!`);
            }
            
            // Refresh local state for the final embed
            user = updateRes;

            // Pay seller through distributeIncome (applies Rich Tax, Slave Tax, Loan Repayment)
            await distributeIncome(listing.sellerId, sellerReceives);
            const updatedSeller = await User.findOne({ userId: listing.sellerId });

            const sellerName = await getDisplayName(listing.sellerId, message.guild);

            // Success embed for buyer
            const buyerEmbed = new EmbedBuilder()
                .setColor(0x57F287)
                .setTitle('✅ PURCHASE SUCCESSFUL')
                .addFields(
                    { name: 'You bought', value: listing.itemName, inline: true },
                    { name: 'From', value: sellerName, inline: true },
                    { name: 'Price Paid', value: `${listing.price.toLocaleString('en-US')} coins`, inline: true },
                    { name: 'Your New Balance', value: `${user.coins.toLocaleString('en-US')} coins`, inline: true }
                )
                .setFooter({ text: "There! Don't spend it all at once, idiot! >///< " });

            await message.reply({ embeds: [buyerEmbed] });

            // Try to notify seller
            try {
                const buyerName = await getDisplayName(message.author.id, message.guild);

                const sellerEmbed = new EmbedBuilder()
                    .setColor(0xFFD700)
                    .setTitle('💰 YOUR ITEM SOLD!')
                    .addFields(
                        { name: 'Item', value: listing.itemName, inline: true },
                        { name: 'Buyer', value: buyerName, inline: true },
                        { name: 'Sale Price', value: `${listing.price.toLocaleString('en-US')} coins`, inline: true },
                        { name: `Market Fee (${config.MARKET.FEE_PERCENT * 100}%)`, value: `${marketFee.toLocaleString('en-US')} coins`, inline: true },
                        { name: 'Pre-Tax Payout', value: `${sellerReceives.toLocaleString('en-US')} coins`, inline: true },
                        { name: 'Your Balance', value: `${updatedSeller ? updatedSeller.coins.toLocaleString('en-US') : '???'} coins`, inline: true }
                    )
                    .setFooter({ text: "H-Hmph! Congrats on the sale, I guess! >///<" });

                // Send to channel mentioning seller
                await message.channel.send({ content: `<@${listing.sellerId}>`, embeds: [sellerEmbed] });
            } catch (e) {
                console.log("Failed to notify seller:", e);
            }

            return;
        }

        // ==================== !MARKET CANCEL [id] ====================
        if (subCommand === 'cancel') {
            const listingId = args[1]?.toUpperCase();

            if (!listingId) {
                return message.reply("❌ Usage: `!market cancel [listing ID]`");
            }

            // Find and delete atomically to prevent cancel spam duplicating items
            const listing = await MarketListing.findOneAndDelete({
                listingId: listingId.replace('#', ''),
                sellerId: message.author.id
            });

            if (!listing) {
                return message.reply("❌ Listing not found or you don't own it! Check `!market mine`!");
            }

            // Return item to inventory atomically
            await User.updateOne(
                { userId: message.author.id },
                { $push: { inventory: listing.itemName } }
            );

            const embed = new EmbedBuilder()
                .setColor(0xFF6B6B)
                .setTitle('🚫 LISTING CANCELLED')
                .setDescription(`**Item Returned:** ${listing.itemName}\n\nYour item has been removed from the market and returned to your inventory.`)
                .setFooter({ text: "Changed your mind? Fine! (¬_¬)" });

            return message.reply({ embeds: [embed] });
        }

        // ==================== !MARKET MINE ====================
        if (subCommand === 'mine' || subCommand === 'my') {
            const listings = await MarketListing.find({
                sellerId: message.author.id,
                expiresAt: { $gt: new Date() }
            }).sort({ createdAt: -1 });

            if (listings.length === 0) {
                return message.reply("No active listings! Use `!market sell` to put something up for sale!");
            }

            let desc = `You have **${listings.length}** items listed:\n\n`;

            for (const listing of listings) {
                const timeLeft = formatTimeRemaining(listing.expiresAt);

                desc += `━━━━━━━━━━━━━━━━━━━━\n`;
                desc += `**#${listing.listingId}** - ${listing.itemName}\n`;
                desc += `💰 Price: **${listing.price.toLocaleString('en-US')}** coins\n`;
                desc += `⏰ Expires: ${timeLeft}\n`;
                desc += `📊 Views: ${listing.views}\n`;
            }

            desc += `━━━━━━━━━━━━━━━━━━━━\n\n`;
            desc += `*Type \`!market cancel [ID]\` to remove a listing!*`;

            const embed = new EmbedBuilder()
                .setColor(0xFF1493)
                .setTitle('📋 YOUR ACTIVE LISTINGS')
                .setDescription(desc);

            return message.reply({ embeds: [embed] });
        }

        // Unknown subcommand - show help
        const helpEmbed = new EmbedBuilder()
            .setColor(0xFF1493)
            .setTitle('🏪 MARKETPLACE COMMANDS')
            .setDescription(
                '`!market` - Browse all listings\n' +
                '`!market sell` - Sell an item (interactive)\n' +
                '`!market buy [ID]` - Purchase a listing\n' +
                '`!market cancel [ID]` - Cancel your listing\n' +
                '`!market mine` - View your listings'
            )
            .setFooter({ text: "D-Don't waste my time asking obvious questions! (¬_¬)" });

        return message.reply({ embeds: [helpEmbed] });
    },

    // --- INTERACTION HANDLER ---
    handleInteraction: async (interaction, client) => {
        // Only handle market-related interactions
        if (!interaction.customId?.startsWith('market_')) return;

        // ==================== SELL DROPDOWN HANDLER ====================
        if (interaction.customId === 'market_sell_select') {
            const selectedItem = interaction.values[0];
            const minPrice = getMinPrice(selectedItem);

            // Explain how minimum price is calculated
            let priceExplanation = '';

            const pctStr = `${config.MARKET.MIN_PRICE_MODIFIER * 100}%`;
            if (SHOP_BASE_PRICES[selectedItem]) {
                priceExplanation = `Shop item: ${SHOP_BASE_PRICES[selectedItem].toLocaleString('en-US')} x ${pctStr} = ${minPrice.toLocaleString('en-US')}`;
            } else if (FRAME_COLORS.includes(selectedItem)) {
                priceExplanation = `Frame color: ${config.MARKET.FRAME_BASE_PRICE.toLocaleString('en-US')} x ${pctStr} = ${minPrice.toLocaleString('en-US')}`;
            } else {
                const rarity = getGachaRarity(selectedItem);
                if (rarity) {
                    priceExplanation = `Gacha title (${rarity}): Fixed min = ${minPrice.toLocaleString('en-US')}`;
                } else {
                    const isShopTitle = SHOP_TITLES.some(t => t.toLowerCase() === selectedItem.toLowerCase());
                    if (isShopTitle) {
                        priceExplanation = `Shop title: ${SHOP_TITLE_PRICE.toLocaleString('en-US')} x ${pctStr} = ${minPrice.toLocaleString('en-US')}`;
                    } else {
                        priceExplanation = `Unknown item: Default min = ${minPrice.toLocaleString('en-US')}`;
                    }
                }
            }

            const modal = new ModalBuilder()
                .setCustomId(`market_sell_modal_${selectedItem}`)
                .setTitle(`Selling: ${selectedItem.slice(0, 35)}`)
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('price_input')
                            .setLabel(`MINIMUM: ${minPrice.toLocaleString('en-US')} COINS`)
                            .setPlaceholder(`Min ${minPrice.toLocaleString('en-US')} (${priceExplanation})`)
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                            .setMinLength(1)
                            .setMaxLength(12)
                    )
                );

            return interaction.showModal(modal);
        }

        // ==================== SELL MODAL SUBMIT HANDLER ====================
        if (interaction.customId.startsWith('market_sell_modal_')) {
            const itemName = interaction.customId.replace('market_sell_modal_', '');
            const priceInput = interaction.fields.getTextInputValue('price_input');
            const price = parseInt(priceInput.replace(/[,\s]/g, ''));

            // Validate price
            if (isNaN(price) || price <= 0) {
                return interaction.reply({
                    content: "H-Hah?! That's not a valid number, you idiot! Try again! (¬_¬)",
                    flags: MessageFlags.Ephemeral
                });
            }

            const minPrice = getMinPrice(itemName);
            if (price < minPrice) {
                return interaction.reply({
                    content: `B-Baka! Minimum price for **${itemName}** is **${minPrice.toLocaleString('en-US')}** coins! You can't sell it for less! >///< `,
                    flags: MessageFlags.Ephemeral
                });
            }

            // Fetch fresh user data
            const user = await User.findOne({ userId: interaction.user.id });
            if (!user) {
                return interaction.reply({
                    content: "Error fetching your data... W-What did you do?!",
                    flags: MessageFlags.Ephemeral
                });
            }

            // Initial verification
            const itemIndexStart = user.inventory.indexOf(itemName);
            if (itemIndexStart === -1) {
                return interaction.reply({
                    content: `Y-You don't have **${itemName}** anymore! Did you already sell it?! (¬_¬)`,
                    flags: MessageFlags.Ephemeral
                });
            }

            // Check listing limit again
            const userListingCount = await MarketListing.countDocuments({
                sellerId: interaction.user.id,
                expiresAt: { $gt: new Date() }
            });

            if (userListingCount >= config.MARKET.MAX_LISTINGS_PER_USER) {
                return interaction.reply({
                    content: `You already have ${config.MARKET.MAX_LISTINGS_PER_USER} listings! Cancel one first! I told you this already! >///< `,
                    flags: MessageFlags.Ephemeral
                });
            }

            // Verify item still in inventory (check after async operations)
            const freshUserAgain = await User.findOne({ userId: interaction.user.id });
            if (!freshUserAgain) {
                return interaction.reply({
                    content: "Error fetching your data... W-What did you do?!",
                    flags: MessageFlags.Ephemeral
                });
            }
            const itemIndex = freshUserAgain.inventory.indexOf(itemName);
            
            if (itemIndex === -1) {
                return interaction.reply({
                    content: `Y-You don't have **${itemName}** anymore! Did you already sell it?! (¬_¬)`,
                    flags: MessageFlags.Ephemeral
                });
            }

            // Create listing
            const listingId = generateListingId();
            const expiresAt = new Date(Date.now() + config.MARKET.LISTING_DURATION_DAYS * 24 * 60 * 60 * 1000);

            // Remove from inventory atomically using $unset + match to prevent concurrent node duplication
            const unsetObj = {};
            unsetObj[`inventory.${itemIndex}`] = 1;
            
            const updateRes = await User.updateOne(
                { userId: interaction.user.id, [`inventory.${itemIndex}`]: itemName }, 
                { $unset: unsetObj }
            );
            
            if (updateRes.modifiedCount === 0) {
                 return interaction.reply({
                    content: `Y-You don't have **${itemName}** anymore or the market is busy processing! (¬_¬)`,
                    flags: MessageFlags.Ephemeral
                });
            }
            
            await User.updateOne({ userId: interaction.user.id }, { $pull: { inventory: null } });

            // Create database entry
            await MarketListing.create({
                listingId,
                sellerId: interaction.user.id,
                itemName,
                price,
                expiresAt
            });

            const embed = new EmbedBuilder()
                .setColor(0x57F287)
                .setTitle('🏪 ITEM LISTED SUCCESSFULLY!')
                .addFields(
                    { name: 'Listing ID', value: `#${listingId}`, inline: true },
                    { name: 'Item', value: itemName, inline: true },
                    { name: 'Price', value: `${price.toLocaleString('en-US')} coins`, inline: true },
                    { name: 'Expires', value: `${config.MARKET.LISTING_DURATION_DAYS} days`, inline: true },
                    { name: 'Market Fee', value: `${config.MARKET.FEE_PERCENT * 100}% on sale`, inline: true }
                )
                .setFooter({ text: "H-Hmph! Let's see if anyone actually wants your junk! >///< " });

            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        // ==================== PAGINATION HANDLER ====================
        if (!interaction.customId.startsWith('market_page_')) return;

        const page = parseInt(interaction.customId.replace('market_page_', ''));
        const perPage = 10;
        const skip = (page - 1) * perPage;

        const totalListings = await MarketListing.countDocuments({ expiresAt: { $gt: new Date() } });
        const totalPages = Math.ceil(totalListings / perPage) || 1;

        const listings = await MarketListing.find({ expiresAt: { $gt: new Date() } })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(perPage);

        let desc = `Currently **${totalListings}** items listed:\n\n`;

        for (const listing of listings) {
            const sellerName = await getDisplayName(listing.sellerId, interaction.guild);
            const timeLeft = formatTimeRemaining(listing.expiresAt);

            desc += `━━━━━━━━━━━━━━━━━━━━\n`;
            desc += `**#${listing.listingId}** - ${listing.itemName}\n`;
            desc += `💰 Price: **${listing.price.toLocaleString('en-US')}** coins\n`;
            desc += `👤 Seller: ${sellerName}\n`;
            desc += `⏰ Expires: ${timeLeft}\n`;
        }

        desc += `━━━━━━━━━━━━━━━━━━━━\n\n`;
        desc += `*Type \`!market buy [ID]\` to purchase!* (¬_¬)`;

        const embed = new EmbedBuilder()
            .setColor(0xFF1493)
            .setTitle('🏪 PLAYER MARKETPLACE')
            .setDescription(desc)
            .setFooter({ text: `Page ${page}/${totalPages} • Use !market [page] to navigate` });

        const row = new ActionRowBuilder();

        if (page > 1) {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`market_page_${page - 1}`)
                    .setLabel('◀ Previous')
                    .setStyle(ButtonStyle.Secondary)
            );
        }

        if (page < totalPages) {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`market_page_${page + 1}`)
                    .setLabel('Next ▶')
                    .setStyle(ButtonStyle.Secondary)
            );
        }

        const updateOptions = { embeds: [embed] };
        if (row.components.length > 0) {
            updateOptions.components = [row];
        } else {
            updateOptions.components = [];
        }

        await interaction.update(updateOptions);
    },

    // --- EXPIRATION CHECKER (Called from index.js interval) ---
    checkExpiredListings: async (client) => {
        try {
            const expiredListings = await MarketListing.find({
                expiresAt: { $lt: new Date() }
            });

            for (const listing of expiredListings) {
                // Delete listing FIRST atomically to prevent duplicate refunds on node overlaps
                const deletedListing = await MarketListing.findOneAndDelete({ _id: listing._id });
                if (!deletedListing) continue; // Already grabbed by another process loop
                
                console.log(`🕐 Expired listing ${deletedListing.listingId} deleted, refunding to ${deletedListing.sellerId}`);

                // Atomic: return item to seller's inventory
                await User.findOneAndUpdate(
                    { userId: deletedListing.sellerId },
                    { $push: { inventory: deletedListing.itemName } }
                );

                // Try to notify only in a guild where the seller is present
                for (const guild of client.guilds.cache.values()) {
                    const sellerMember = await guild.members.fetch(deletedListing.sellerId).catch(() => null);
                    if (!sellerMember) continue;

                    const channel = guild.channels.cache.find(c =>
                        [config.CHANNELS.MAIN, config.CHANNELS.ALT].includes(c.name)
                    );
                    if (!channel) continue;

                    try {
                        const embed = new EmbedBuilder()
                            .setColor(0xFFA500)
                            .setTitle('⏰ LISTING EXPIRED')
                            .setDescription(
                                `<@${deletedListing.sellerId}>, your listing for **${deletedListing.itemName}** (ID: #${deletedListing.listingId}) has expired.\n\n` +
                                `The item has been returned to your inventory.`
                            )
                            .setFooter({ text: "Nobody wanted it? How sad! >///< " });

                        await channel.send({ embeds: [embed] });
                    } catch (e) { }

                    break;
                }
            }
        } catch (e) {
            console.error("Error checking expired listings:", e);
        }
    }
};

