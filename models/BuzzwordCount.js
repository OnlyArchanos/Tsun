const mongoose = require('mongoose');

const buzzwordCountSchema = new mongoose.Schema({
    keyword: { type: String, required: true },
    userId: { type: String, required: true },
    count: { type: Number, default: 0 },
});

// Unique compound index — guarantees one doc per (keyword, userId) pair for upsert correctness
buzzwordCountSchema.index({ keyword: 1, userId: 1 }, { unique: true });

// Leaderboard query index — covers find({ keyword }).sort({ count: -1 }).limit(10)
buzzwordCountSchema.index({ keyword: 1, count: -1 });

module.exports = mongoose.model('BuzzwordCount', buzzwordCountSchema);
