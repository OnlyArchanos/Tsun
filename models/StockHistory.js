const mongoose = require('mongoose');

const stockHistorySchema = new mongoose.Schema({
    userId:    { type: String, required: true, index: true },
    price:     { type: Number, required: true },
    timestamp: { type: Date, default: Date.now },
});

// Auto-delete entries older than 30 days
stockHistorySchema.index({ timestamp: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

module.exports = mongoose.model('StockHistory', stockHistorySchema);
