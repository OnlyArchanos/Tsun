const mongoose = require('mongoose');
require('dotenv').config();
const Stock = require('./models/Stock');
const Portfolio = require('./models/Portfolio');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB.");

  const portfolios = await Portfolio.find({ shares: { $gt: 0 } });
  console.log(`Found ${portfolios.length} portfolios to rebase.`);

  let updated = 0;
  for (const p of portfolios) {
    const stock = await Stock.findOne({ userId: p.targetUserId });
    if (!stock) {
      console.log(`  SKIP: No stock found for target ${p.targetUserId}`);
      continue;
    }

    const newInvested = Math.round(p.shares * stock.currentPrice);
    const oldInvested = p.totalInvested;

    await Portfolio.updateOne(
      { _id: p._id },
      { $set: { totalInvested: newInvested } }
    );

    console.log(`  Owner: ${p.ownerId} | Target: ${p.targetUserId} | Shares: ${p.shares} | Old: ${oldInvested} -> New: ${newInvested}`);
    updated++;
  }

  console.log(`\nDone! Rebased ${updated} portfolios. All PnL is now 0%.`);
  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
