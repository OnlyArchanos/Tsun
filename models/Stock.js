const mongoose = require('mongoose');
const config = require('../config');

const stockSchema = new mongoose.Schema({
    userId:            { type: String, required: true, unique: true },
    currentPrice:      { type: Number, default: config.STOCKS.BASE_PRICE },
    previousClose:     { type: Number, default: config.STOCKS.BASE_PRICE },   // Price at last midnight (for 24h% calc)
    sharesOutstanding: { type: Number, default: 0 },      // Total shares owned by all investors
    lastActivityAt:    { type: Number, default: 0 },      // Last timestamp that moved the price
    dailyHigh:         { type: Number, default: config.STOCKS.BASE_PRICE },
    dailyLow:          { type: Number, default: config.STOCKS.BASE_PRICE },
    allTimeHigh:       { type: Number, default: config.STOCKS.BASE_PRICE },
    volume24h:         { type: Number, default: 0 },      // Shares traded in last 24h
});

module.exports = mongoose.model('Stock', stockSchema);
