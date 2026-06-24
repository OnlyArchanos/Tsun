const mongoose = require('mongoose');
const Stock = require('./models/Stock');
const Portfolio = require('./models/Portfolio');
const StockHistory = require('./models/StockHistory');
require('dotenv').config();

async function run() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB for Migration.");

    // 1. Update Stocks
    console.log("Updating Stocks...");
    const stockResult = await Stock.updateMany(
      {},
      {
        $mul: {
          currentPrice: 50,
          previousClose: 50,
          dailyHigh: 50,
          dailyLow: 50,
          allTimeHigh: 50
        }
      }
    );
    console.log(`Stocks updated: ${stockResult.modifiedCount}`);

    // 2. Update Portfolios (ONLY totalInvested, not shares)
    console.log("Updating Portfolios...");
    const portfolioResult = await Portfolio.updateMany(
      {},
      {
        $mul: {
          totalInvested: 50
        }
      }
    );
    console.log(`Portfolios updated: ${portfolioResult.modifiedCount}`);

    // 3. Update StockHistory
    console.log("Updating StockHistory...");
    const historyResult = await StockHistory.updateMany(
      {},
      {
        $mul: {
          price: 50
        }
      }
    );
    console.log(`StockHistory updated: ${historyResult.modifiedCount}`);

    console.log("Migration complete!");
    await mongoose.disconnect();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run();
