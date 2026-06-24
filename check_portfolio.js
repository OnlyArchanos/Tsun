const mongoose = require('mongoose');
require('dotenv').config();
const Portfolio = require('./models/Portfolio');

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const ps = await Portfolio.find({ ownerId: process.env.OWNER_ID }).lean();
  for (const p of ps) {
    const avgCost = p.shares > 0 ? p.totalInvested / p.shares : 0;
    console.log(`Target: ${p.targetUserId} | Shares: ${p.shares} | TotalInvested: ${p.totalInvested} | AvgCost/share: ${avgCost.toFixed(2)}`);
  }
  process.exit(0);
});
