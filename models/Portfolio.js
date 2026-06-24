const mongoose = require('mongoose');

const portfolioSchema = new mongoose.Schema({
    ownerId:       { type: String, required: true },     // The investor
    targetUserId:  { type: String, required: true },     // Whose stock they own
    shares:        { type: Number, default: 0 },         // Current share count
    totalInvested: { type: Number, default: 0 },         // Total coins spent (avgPrice = totalInvested / shares)
});

portfolioSchema.index({ ownerId: 1, targetUserId: 1 }, { unique: true });

module.exports = mongoose.model('Portfolio', portfolioSchema);
