// utils/stockEngine.js — TsunStocks price engine
// All stock price mutations flow through this file.
// Never modify Stock.currentPrice directly from command files.

const Stock = require('../models/Stock');
const StockHistory = require('../models/StockHistory');
const config = require('../config');
const { createCleaningMap } = require('./helpers');

const S = config.STOCKS;

// Track per-user message counts for the hourly cap (auto-cleans every hour)
const messageCountMap = createCleaningMap(60 * 60 * 1000, 30 * 60 * 1000);

// --- Internal helpers ---

/**
 * Atomically adjust a stock's price by an additive delta.
 * Enforces PRICE_FLOOR, updates dailyHigh/Low/allTimeHigh.
 * Upserts: creates the Stock document if it doesn't exist yet.
 */
async function adjustPriceAdditive(userId, delta) {
    const now = Date.now();
    // Use aggregation pipeline update for computed $max/$min
    const stock = await Stock.findOneAndUpdate(
        { userId },
        [{
            $set: {
                currentPrice: { $max: [S.PRICE_FLOOR, { $add: [{ $ifNull: ['$currentPrice', S.BASE_PRICE] }, delta] }] },
                dailyHigh: { $max: [{ $ifNull: ['$dailyHigh', S.BASE_PRICE] }, { $max: [S.PRICE_FLOOR, { $add: [{ $ifNull: ['$currentPrice', S.BASE_PRICE] }, delta] }] }] },
                dailyLow: { $min: [{ $ifNull: ['$dailyLow', S.BASE_PRICE] }, { $max: [S.PRICE_FLOOR, { $add: [{ $ifNull: ['$currentPrice', S.BASE_PRICE] }, delta] }] }] },
                allTimeHigh: { $max: [{ $ifNull: ['$allTimeHigh', S.BASE_PRICE] }, { $max: [S.PRICE_FLOOR, { $add: [{ $ifNull: ['$currentPrice', S.BASE_PRICE] }, delta] }] }] },
                previousClose: { $ifNull: ['$previousClose', S.BASE_PRICE] },
                lastActivityAt: now,
            }
        }],
        { upsert: true, new: true, updatePipeline: true }
    );
    return stock;
}

/**
 * Atomically adjust a stock's price by a multiplicative factor.
 * e.g. factor = 1.01 for +1%, factor = 0.99 for -1%.
 * Enforces PRICE_FLOOR.
 */
async function adjustPriceMultiplicative(userId, factor) {
    const now = Date.now();
    const stock = await Stock.findOneAndUpdate(
        { userId },
        [{
            $set: {
                currentPrice: { $max: [S.PRICE_FLOOR, { $multiply: [{ $ifNull: ['$currentPrice', S.BASE_PRICE] }, factor] }] },
                dailyHigh: { $max: [{ $ifNull: ['$dailyHigh', S.BASE_PRICE] }, { $max: [S.PRICE_FLOOR, { $multiply: [{ $ifNull: ['$currentPrice', S.BASE_PRICE] }, factor] }] }] },
                dailyLow: { $min: [{ $ifNull: ['$dailyLow', S.BASE_PRICE] }, { $max: [S.PRICE_FLOOR, { $multiply: [{ $ifNull: ['$currentPrice', S.BASE_PRICE] }, factor] }] }] },
                allTimeHigh: { $max: [{ $ifNull: ['$allTimeHigh', S.BASE_PRICE] }, { $max: [S.PRICE_FLOOR, { $multiply: [{ $ifNull: ['$currentPrice', S.BASE_PRICE] }, factor] }] }] },
                previousClose: { $ifNull: ['$previousClose', S.BASE_PRICE] },
                lastActivityAt: now,
            }
        }],
        { upsert: true, new: true, updatePipeline: true }
    );
    return stock;
}

// --- Exported event handlers ---

/**
 * Called on every message from messageCreate in index.js.
 * Bumps the sender's stock price if under the hourly cap.
 */
async function onMessage(userId) {
    try {
        const key = userId;
        const count = (messageCountMap.get(key) || 0) + 1;
        messageCountMap.set(key, count);

        if (count > S.MESSAGE_HOURLY_CAP) return; // Spam protection
        await adjustPriceAdditive(userId, S.MESSAGE_PRICE_BUMP);
    } catch (err) {
        console.error('[StockEngine] onMessage error:', err.message);
    }
}

/**
 * Called after a duel resolves in battle.js.
 * Winner's stock goes up, loser's stock goes down.
 */
async function onDuelResult(winnerId, loserId) {
    try {
        await adjustPriceAdditive(winnerId, S.DUEL_WIN_BUMP);
        await adjustPriceAdditive(loserId, -S.DUEL_LOSS_DROP);
    } catch (err) {
        console.error('[StockEngine] onDuelResult error:', err.message);
    }
}

/**
 * Called after a minigame win (guess, higherLower, etc).
 */
async function onMinigameWin(userId) {
    try {
        await adjustPriceAdditive(userId, S.MINIGAME_WIN_BUMP);
    } catch (err) {
        console.error('[StockEngine] onMinigameWin error:', err.message);
    }
}

/**
 * Called when someone buys shares of a user. +1% price bump.
 */
async function applyBuyPressure(userId) {
    try {
        await adjustPriceMultiplicative(userId, 1 + S.BUY_PRESSURE);
    } catch (err) {
        console.error('[StockEngine] applyBuyPressure error:', err.message);
    }
}

/**
 * Called when someone sells shares of a user. -1% price drop.
 */
async function applySellPressure(userId) {
    try {
        await adjustPriceMultiplicative(userId, 1 - S.SELL_PRESSURE);
    } catch (err) {
        console.error('[StockEngine] applySellPressure error:', err.message);
    }
}

/**
 * Hourly timer: decay prices for users who haven't been active in 24h+.
 */
async function runInactivityDecay() {
    try {
        const threshold = Date.now() - S.INACTIVITY_THRESHOLD;
        // Find all stocks where the user has been inactive past the threshold
        const inactiveStocks = await Stock.find({
            lastActivityAt: { $gt: 0, $lt: threshold },
            currentPrice: { $gt: S.PRICE_FLOOR }
        });

        for (const stock of inactiveStocks) {
            await Stock.findOneAndUpdate(
                { userId: stock.userId, currentPrice: { $gt: S.PRICE_FLOOR } },
                [{
                    $set: {
                        currentPrice: { $max: [S.PRICE_FLOOR, { $multiply: ['$currentPrice', 1 - S.INACTIVITY_DECAY_RATE] }] },
                        dailyLow: { $min: ['$dailyLow', { $max: [S.PRICE_FLOOR, { $multiply: ['$currentPrice', 1 - S.INACTIVITY_DECAY_RATE] }] }] },
                    }
                }],
                { updatePipeline: true }
            );
        }
        console.log(`[StockEngine] Decay applied to ${inactiveStocks.length} inactive stocks.`);
    } catch (err) {
        console.error('[StockEngine] runInactivityDecay error:', err.message);
    }
}

/**
 * Hourly timer: snapshot all stock prices into StockHistory for charting.
 */
async function snapshotPrices() {
    try {
        const stocks = await Stock.find({});
        if (stocks.length === 0) return;

        const docs = stocks.map(s => ({
            userId: s.userId,
            price: s.currentPrice,
            timestamp: new Date(),
        }));
        await StockHistory.insertMany(docs);
        console.log(`[StockEngine] Snapshotted ${docs.length} stock prices.`);
    } catch (err) {
        console.error('[StockEngine] snapshotPrices error:', err.message);
    }
}

/**
 * Daily timer: reset dailyHigh/Low/volume, set previousClose, pay CEO salary, pay dividends.
 * Returns arrays of { userId, amount } for CEO salary and dividends so index.js can call distributeIncome.
 */
async function runDailyReset() {
    try {
        const stocks = await Stock.find({});

        // Collect CEO salary payouts (to be processed by caller via distributeIncome)
        const ceoPayouts = [];
        for (const stock of stocks) {
            const salary = Math.floor(stock.currentPrice * S.CEO_SALARY_RATE);
            if (salary > 0) {
                ceoPayouts.push({ userId: stock.userId, amount: salary });
            }
        }

        // Reset daily fields for all stocks
        await Stock.updateMany({}, [{
            $set: {
                previousClose: '$currentPrice',
                dailyHigh: '$currentPrice',
                dailyLow: '$currentPrice',
                volume24h: 0,
            }
        }], { updatePipeline: true });

        console.log(`[StockEngine] Daily reset complete. ${ceoPayouts.length} CEO salaries pending.`);
        return { ceoPayouts };
    } catch (err) {
        console.error('[StockEngine] runDailyReset error:', err.message);
        return { ceoPayouts: [] };
    }
}

/**
 * Get current stock price for a user (creates stock doc if missing).
 */
async function getOrCreateStock(userId) {
    let stock = await Stock.findOne({ userId });
    if (!stock) {
        stock = await Stock.findOneAndUpdate(
            { userId },
            { $setOnInsert: { currentPrice: S.BASE_PRICE, previousClose: S.BASE_PRICE, dailyHigh: S.BASE_PRICE, dailyLow: S.BASE_PRICE, allTimeHigh: S.BASE_PRICE, lastActivityAt: Date.now() } },
            { upsert: true, new: true }
        );
    }
    return stock;
}

module.exports = {
    onMessage,
    onDuelResult,
    onMinigameWin,
    applyBuyPressure,
    applySellPressure,
    runInactivityDecay,
    runDailyReset,
    snapshotPrices,
    getOrCreateStock,
};
