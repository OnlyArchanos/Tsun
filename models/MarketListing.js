const mongoose = require('mongoose');

const marketListingSchema = new mongoose.Schema({
    listingId: { type: String, required: true, unique: true },
    sellerId: { type: String, required: true },
    itemName: { type: String, required: true },
    price: { type: Number, required: true },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    views: { type: Number, default: 0 }
});

// Index for efficient queries
marketListingSchema.index({ expiresAt: 1 });
marketListingSchema.index({ sellerId: 1 });

module.exports = mongoose.model('MarketListing', marketListingSchema);
