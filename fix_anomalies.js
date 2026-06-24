require('dotenv').config();
const mongoose = require('mongoose');
const Stock = require('./models/Stock');
const Portfolio = require('./models/Portfolio');

mongoose.connect(process.env.MONGO_URI)
    .then(async () => {
        const topStocks = await Stock.find({ currentPrice: { $gt: 200000 } });
        
        for (const stock of topStocks) {
            console.log(`Fixing stock ${stock.userId}...`);
            
            // 1. Reset stock price to base price 5000
            await Stock.updateOne({ _id: stock._id }, {
                $set: {
                    currentPrice: 5000,
                    previousClose: 5000,
                    dailyHigh: 5000,
                    dailyLow: 5000,
                    allTimeHigh: 5000
                }
            });
            
            // 2. Rebase portfolios holding this stock to the new 5000 price
            const holdings = await Portfolio.find({ targetUserId: stock.userId, shares: { $gt: 0 } });
            for (const h of holdings) {
                const newInvested = h.shares * 5000;
                await Portfolio.updateOne({ _id: h._id }, {
                    $set: { totalInvested: newInvested }
                });
                console.log(`  -> Rebased portfolio for user ${h.ownerId} (shares: ${h.shares}) to ${newInvested}c`);
            }
        }
        
        console.log("Anomalies fixed successfully!");
        process.exit(0);
    })
    .catch(console.error);
