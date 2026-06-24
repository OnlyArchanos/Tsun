const mongoose = require('mongoose');
const config = require('../config');

const serverStatsSchema = new mongoose.Schema({
    // The ID of the server (Guild)
    guildId: { type: String, required: true, unique: true },

    // The current progress towards the goal
    weeklyCoinCount: { type: Number, default: 0 },

    // The target goal (Default: 10,000,000)
    weeklyGoal: { type: Number, default: config.ECONOMY.WEEKLY_GOAL },

    // The reward text for completing the goal
    weeklyReward: { type: String, default: 'No reward set' },

    // The coin amount reward for completing the goal
    weeklyRewardAmount: { type: Number, default: config.ECONOMY.WEEKLY_REWARD_COINS },

    // Timestamp for when the week started
    lastReset: { type: Number, default: Date.now },

    // --- NEW: TRACK CLAIMERS PERSISTENTLY ---
    weeklyClaimers: { type: [String], default: [] },

    lastDailyTax: { type: Number, default: 0 },

    // Track whether goal announcement has been posted this week
    goalAnnouncedThisWeek: { type: Boolean, default: false },

    // Track when weekly stats were last reset
    lastWeeklyReset: { type: Number, default: 0 },

    // Season tracking — incremented on every !resetserver confirm
    seasonNumber: { type: Number, default: 1 },

    // Persistent Featured Gacha Banner state
    featuredGachaTitle: { type: String, default: null },
    featuredGachaLastRotation: { type: Number, default: 0 },

    // Progressive Roulette Jackpot
    rouletteJackpot: { type: Number, default: config.ROULETTE.JACKPOT_SEED }
    // ----------------------------------------
});

module.exports = mongoose.model('ServerStats', serverStatsSchema);