const mongoose = require('mongoose');

const auctionSchema = new mongoose.Schema({
    auctionId: { type: String, required: true, unique: true },
    slaveId: { type: String, required: true },
    sellerId: { type: String, required: true },
    currentBid: { type: Number, default: 0 },
    currentBidder: { type: String, default: null },
    minimumBid: { type: Number, required: true },
    endTime: { type: Number, required: true },
    active: { type: Boolean, default: true },
    guildId: { type: String, required: true },
    createdAt: { type: Number, default: Date.now }
});

// Index for background sweeps
auctionSchema.index({ active: 1, endTime: 1 });

module.exports = mongoose.model('Auction', auctionSchema);
