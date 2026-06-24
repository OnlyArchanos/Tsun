const mongoose = require('mongoose');
const config = require('./config');
const Stock = require('./models/Stock');

mongoose.connect(config.MONGODB_URI).then(async () => {
    const MARKET_PAGE_SIZE = 10;
    const targetPage = 1;
    
    const allStocks = await Stock.find({}).sort({ currentPrice: -1 });
    const totalPages = Math.max(1, Math.ceil(allStocks.length / MARKET_PAGE_SIZE));
    const page = Math.max(0, Math.min(targetPage, totalPages - 1));
    const pageStocks = allStocks.slice(page * MARKET_PAGE_SIZE, (page + 1) * MARKET_PAGE_SIZE);
    const startRank = page * MARKET_PAGE_SIZE;
    
    console.log(`targetPage: ${targetPage}, page: ${page}, totalPages: ${totalPages}, startRank: ${startRank}`);
    for (let i = 0; i < pageStocks.length; i++) {
        const s = pageStocks[i];
        console.log(`\`#${startRank + i + 1}\` ${s.userId} — ${s.currentPrice}`);
    }
    
    process.exit(0);
});
