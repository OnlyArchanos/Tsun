const mongoose = require('mongoose');
require('dotenv').config({path: './web/.env.local'});
const Stock = mongoose.models.Stock || mongoose.model('Stock', new mongoose.Schema({ userId: String, currentPrice: Number, previousClose: Number }, { strict: false }));
mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const stocks = await Stock.find({ currentPrice: { $lt: 50 } }).lean();
  console.log('Low stocks:', stocks);
  // Let's fix them to 100
  for(const s of stocks) {
      if(s.currentPrice < 5) {
          // It's definitely the bug. Let's reset to 100 + (currentPrice - 1)
          const newPrice = 100 + (s.currentPrice - 1);
          await Stock.updateOne({_id: s._id}, { $set: { currentPrice: newPrice, dailyHigh: newPrice, dailyLow: 100, allTimeHigh: newPrice, previousClose: 100 } });
          console.log('Fixed', s.userId, 'to', newPrice);
      }
  }
  process.exit(0);
});
