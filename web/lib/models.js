import mongoose from 'mongoose';
import connectDB from './db.js';

// --- Inline schemas (copies of the bot's models, needed because Vercel can't
//     reach ../../models/ outside the deployed web/ directory) ---

const stockSchema = new mongoose.Schema({
  userId:            { type: String, required: true, unique: true },
  currentPrice:      { type: Number, default: 5000 },
  previousClose:     { type: Number, default: 5000 },
  sharesOutstanding: { type: Number, default: 0 },
  volume24h:         { type: Number, default: 0 },
  dailyHigh:         { type: Number, default: 5000 },
  dailyLow:          { type: Number, default: 5000 },
  allTimeHigh:       { type: Number, default: 5000 },
  lastActivityAt:    { type: Number, default: 0 }
});

const stockHistorySchema = new mongoose.Schema({
  userId:    { type: String, required: true, index: true },
  price:     { type: Number, required: true },
  timestamp: { type: Date, default: Date.now },
});
stockHistorySchema.index({ timestamp: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

const portfolioSchema = new mongoose.Schema({
  ownerId:       { type: String, required: true },
  targetUserId:  { type: String, required: true },
  shares:        { type: Number, default: 0 },
  totalInvested: { type: Number, default: 0 },
});
portfolioSchema.index({ ownerId: 1, targetUserId: 1 }, { unique: true });

// Minimal User schema — only the fields the website reads/writes.
// Mongoose ignores fields not in the schema on reads, but won't clobber them.
const userSchema = new mongoose.Schema({
  userId:                 { type: String, required: true, unique: true },
  displayName:            { type: String, default: null },
  avatarUrl:              { type: String, default: null },
  coins:                  { type: Number, default: 200 },
  equippedTitle:          { type: String, default: null },
  prestige:               { type: Number, default: 0 },
  isSlave:                { type: Boolean, default: false },
  slaveOwner:             { type: String, default: null },
  systemSpent:            { type: Number, default: 0 },
  systemEarned:           { type: Number, default: 0 },
  masterIncomeFromSlaves: { type: Number, default: 0 },
}, { strict: false }); // strict:false so we don't drop unknown fields on writes

const loanSchema = new mongoose.Schema({
  lenderId:        { type: String, required: true },
  borrowerId:      { type: String, required: true },
  initialAmount:   { type: Number, required: true },
  remainingAmount: { type: Number, required: true },
  interestRate:    { type: Number, required: true },
  totalRepayment:  { type: Number, required: true },
  dueDate:         { type: Number, required: true },
  status:          { type: String, enum: ['ACTIVE', 'PAID', 'DEFAULTED'], default: 'ACTIVE' }
});
loanSchema.index({ borrowerId: 1, status: 1 });
loanSchema.index({ lenderId: 1, status: 1 });
loanSchema.index({ status: 1, dueDate: 1 });

const serverStatsSchema = new mongoose.Schema({
  guildId:               { type: String, required: true, unique: true },
  weeklyCoinCount:       { type: Number, default: 0 },
  weeklyGoal:            { type: Number, default: 10000000 },
  weeklyReward:          { type: String, default: 'No reward set' },
  weeklyRewardAmount:    { type: Number, default: 5000 },
  lastReset:             { type: Number, default: Date.now },
  weeklyClaimers:        { type: [String], default: [] },
  lastDailyTax:          { type: Number, default: 0 },
  goalAnnouncedThisWeek: { type: Boolean, default: false },
  lastWeeklyReset:       { type: Number, default: 0 },
  seasonNumber:          { type: Number, default: 1 },
  featuredGachaTitle:    { type: String, default: null },
  featuredGachaLastRotation: { type: Number, default: 0 },
  rouletteJackpot:       { type: Number, default: 100000 }
});

export async function getModels() {
  await connectDB();

  const Stock        = mongoose.models.Stock        || mongoose.model('Stock', stockSchema);
  const StockHistory = mongoose.models.StockHistory || mongoose.model('StockHistory', stockHistorySchema);
  const Portfolio    = mongoose.models.Portfolio    || mongoose.model('Portfolio', portfolioSchema);
  const User         = mongoose.models.User         || mongoose.model('User', userSchema);
  const Loan         = mongoose.models.Loan         || mongoose.model('Loan', loanSchema);
  const ServerStats  = mongoose.models.ServerStats  || mongoose.model('ServerStats', serverStatsSchema);

  return { Stock, StockHistory, Portfolio, User, Loan, ServerStats };
}
