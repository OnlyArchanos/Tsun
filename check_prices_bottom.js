require('dotenv').config();
const mongoose = require('mongoose');
const Stock = require('./models/Stock');

const uri = process.env.MONGO_URI;

mongoose.connect(uri)
    .then(async () => {
        const stocks = await Stock.find().sort({ currentPrice: 1 }).limit(10);
        console.log("Bottom 10 Stocks:");
        stocks.forEach(s => {
            console.log(`${s.userId} - Price: ${s.currentPrice}, prevClose: ${s.previousClose}`);
        });
        process.exit(0);
    })
    .catch(console.error);
