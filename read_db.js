const mongoose = require('mongoose');
const User = require('./models/User');
const Stock = require('./models/Stock');
const Portfolio = require('./models/Portfolio');
require('dotenv').config();

async function run() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB.");

    const stocks = await Stock.find().limit(3).lean();
    console.log("\n=== STOCKS SAMPLE ===");
    for (const s of stocks) {
      console.log(`User ID: ${s.userId}`);
      console.log(`  Current Price: ${s.currentPrice} -> Would become: ${s.currentPrice * 50}`);
      console.log(`  Previous Close: ${s.previousClose} -> Would become: ${s.previousClose * 50}`);
      console.log(`  All Time High: ${s.allTimeHigh} -> Would become: ${s.allTimeHigh * 50}`);
    }

    const users = await User.find({ coins: { $gt: 0 } }).limit(3).lean();
    console.log("\n=== USERS SAMPLE ===");
    for (const u of users) {
      console.log(`User ID: ${u.userId} (${u.displayName || 'Unknown'})`);
      console.log(`  Coins: ${u.coins} -> Would become: ${u.coins * 50}`);
      console.log(`  System Earned: ${u.systemEarned} -> Would become: ${u.systemEarned * 50}`);
    }

    const portfolios = await Portfolio.find().limit(3).lean();
    console.log("\n=== PORTFOLIO SAMPLE ===");
    for (const p of portfolios) {
      console.log(`Owner: ${p.ownerId} | Target: ${p.targetUserId}`);
      console.log(`  Shares: ${p.shares} (No change)`);
      console.log(`  Total Invested: ${p.totalInvested} -> Would become: ${p.totalInvested * 50}`);
    }

    await mongoose.disconnect();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run();
