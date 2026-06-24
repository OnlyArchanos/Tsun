require('dotenv').config();
const mongoose = require('mongoose');
const Stock = require('./models/Stock');
const Portfolio = require('./models/Portfolio');

mongoose.connect(process.env.MONGO_URI)
    .then(async () => {
        const topStocks = await Stock.find({ currentPrice: { $gt: 20000 } });
        console.log(`Found ${topStocks.length} anomaly stocks.`);
        
        for (const stock of topStocks) {
            console.log(`\nStock: ${stock.userId} - Price: ${stock.currentPrice}`);
            const holdings = await Portfolio.find({ targetUserId: stock.userId, shares: { $gt: 0 } });
            console.log(`  Owned by ${holdings.length} users:`);
            let totalShares = 0;
            for (const h of holdings) {
                console.log(`    Owner: ${h.ownerId} - Shares: ${h.shares} - Invested: ${h.totalInvested}`);
                totalShares += h.shares;
            }
            console.log(`  Total Shares Outstanding in Portfolios: ${totalShares}`);
            console.log(`  Reported sharesOutstanding in Stock: ${stock.sharesOutstanding}`);
        }
        process.exit(0);
    })
    .catch(console.error);
