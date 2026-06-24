import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getModels } from '@/lib/models';
import { distributeIncome } from '@/lib/income';

// Config values matching the bot's config.STOCKS
const BROKER_FEE = 0.05;
const MAX_SHARES_PER_USER = 200;
const PRICE_FLOOR = 1;
const BUY_PRESSURE = 0.01;
const SELL_PRESSURE = 0.01;

export async function POST(request) {
  try {
    const session = await auth();
    if (!session?.user?.discordId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { action, targetUserId, shares } = body;

    // Validate input
    if (!action || !targetUserId || !shares) {
      return NextResponse.json({ error: 'Missing required fields: action, targetUserId, shares' }, { status: 400 });
    }
    if (action !== 'buy' && action !== 'sell') {
      return NextResponse.json({ error: 'Action must be "buy" or "sell"' }, { status: 400 });
    }
    
    // Validate targetUserId format (Discord ID: 17-20 digits)
    if (!/^\d{17,20}$/.test(targetUserId)) {
      return NextResponse.json({ error: 'Invalid targetUserId format' }, { status: 400 });
    }

    const amount = parseInt(shares);
    if (!Number.isFinite(amount) || amount < 1) {
      return NextResponse.json({ error: 'Shares must be a positive integer' }, { status: 400 });
    }

    const ownerId = session.user.discordId;

    // Block self-trading
    if (ownerId === targetUserId) {
      return NextResponse.json({ error: 'You cannot trade your own stock' }, { status: 400 });
    }

    const { Stock, Portfolio, User } = await getModels();

    // Prevent trading for phantom/bot accounts that aren't registered in the economy
    const targetUser = await User.findOne({ userId: targetUserId });
    if (!targetUser) {
      return NextResponse.json({ error: 'Target user does not exist in the economy yet' }, { status: 400 });
    }

    if (action === 'buy') {
      return await handleBuy(ownerId, targetUserId, amount, { Stock, Portfolio, User });
    } else {
      return await handleSell(ownerId, targetUserId, amount, { Stock, Portfolio, User });
    }
  } catch (err) {
    console.error('[API /trade] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function handleBuy(ownerId, targetUserId, amount, { Stock, Portfolio, User }) {
  // Get current stock price (or create if missing)
  let stock = await Stock.findOne({ userId: targetUserId });
  if (!stock) {
    stock = await Stock.findOneAndUpdate(
      { userId: targetUserId },
      { $setOnInsert: { currentPrice: 5000, previousClose: 5000, dailyHigh: 5000, dailyLow: 5000, allTimeHigh: 5000, lastActivityAt: Date.now() } },
      { upsert: true, new: true }
    );
  }

  const totalCost = Math.ceil(amount * stock.currentPrice * (1 + BROKER_FEE));

  // Atomic share cap check + update: only increment if resulting shares <= MAX
  const portfolioUpdate = await Portfolio.findOneAndUpdate(
    {
      ownerId,
      targetUserId,
      $expr: { $lte: [{ $add: [{ $ifNull: ['$shares', 0] }, amount] }, MAX_SHARES_PER_USER] }
    },
    { $inc: { shares: amount, totalInvested: totalCost } },
    { new: true }
  );

  let capExceeded = false;
  if (!portfolioUpdate) {
    // Check if it's a new portfolio (no doc exists yet)
    const existing = await Portfolio.findOne({ ownerId, targetUserId });
    if (!existing && amount <= MAX_SHARES_PER_USER) {
      await Portfolio.create({ ownerId, targetUserId, shares: amount, totalInvested: totalCost });
    } else {
      capExceeded = true;
    }
  }

  if (capExceeded) {
    const existing = await Portfolio.findOne({ ownerId, targetUserId });
    const currentShares = existing?.shares || 0;
    const canBuy = MAX_SHARES_PER_USER - currentShares;
    return NextResponse.json({
      error: `Share cap exceeded. You own ${currentShares}/${MAX_SHARES_PER_USER}. Can buy ${canBuy} more.`,
    }, { status: 400 });
  }

  // Atomic coin deduction with $gte guard
  const buyer = await User.findOneAndUpdate(
    { userId: ownerId, coins: { $gte: totalCost } },
    { $inc: { coins: -totalCost, systemSpent: totalCost } },
    { new: true }
  );
  
  if (!buyer) {
    // Rollback the portfolio update
    const rolledBack = await Portfolio.findOneAndUpdate(
      { ownerId, targetUserId },
      { $inc: { shares: -amount, totalInvested: -totalCost } },
      { new: true }
    );
    if (rolledBack && rolledBack.shares <= 0) {
      await Portfolio.deleteOne({ _id: rolledBack._id });
    }
    return NextResponse.json({ error: 'Insufficient coins' }, { status: 400 });
  }

  // Update stock: increment shares outstanding and volume
  await Stock.findOneAndUpdate(
    { userId: targetUserId },
    { $inc: { sharesOutstanding: amount, volume24h: amount } }
  );

  // Apply buy pressure: +1% multiplicative
  await Stock.findOneAndUpdate(
    { userId: targetUserId },
    [{ $set: {
      currentPrice: { $max: [PRICE_FLOOR, { $multiply: ['$currentPrice', 1 + BUY_PRESSURE] }] },
      dailyHigh: { $max: ['$dailyHigh', { $max: [PRICE_FLOOR, { $multiply: ['$currentPrice', 1 + BUY_PRESSURE] }] }] },
      dailyLow: { $min: ['$dailyLow', { $max: [PRICE_FLOOR, { $multiply: ['$currentPrice', 1 + BUY_PRESSURE] }] }] },
      allTimeHigh: { $max: ['$allTimeHigh', { $max: [PRICE_FLOOR, { $multiply: ['$currentPrice', 1 + BUY_PRESSURE] }] }] },
      lastActivityAt: Date.now(),
    }}],
    { updatePipeline: true }
  );

  return NextResponse.json({
    success: true,
    action: 'buy',
    shares: amount,
    totalCost,
    newBalance: buyer.coins,
    pricePerShare: stock.currentPrice,
  });
}

async function handleSell(ownerId, targetUserId, amount, { Stock, Portfolio, User }) {
  // Atomic: deduct shares only if they have enough
  const holding = await Portfolio.findOneAndUpdate(
    { ownerId, targetUserId, shares: { $gte: amount } },
    { $inc: { shares: -amount } },
    { new: true }
  );
  if (!holding) {
    return NextResponse.json({ error: 'Insufficient shares' }, { status: 400 });
  }

  // Reduce totalInvested proportionally (so avg price stays accurate for remaining shares)
  if (holding.shares > 0) {
    const sharesBeforeSell = holding.shares + amount;
    const investmentToRemove = Math.floor(holding.totalInvested * (amount / sharesBeforeSell));
    await Portfolio.findOneAndUpdate(
      { ownerId, targetUserId },
      { $inc: { totalInvested: -investmentToRemove } }
    );
  } else {
    // Sold all shares, clean up
    await Portfolio.deleteOne({ ownerId, targetUserId });
  }

  // Get current price for payout
  const stock = await Stock.findOne({ userId: targetUserId });
  if (!stock) {
    return NextResponse.json({ error: 'Stock not found' }, { status: 404 });
  }

  const totalReturn = Math.floor(amount * stock.currentPrice * (1 - BROKER_FEE));

  // Credit seller via distributeIncome (handles rich tax, slave tax, loan repayments, and wallet cap)
  // Note: Web distributeIncome implicitly skips multipliers by design, but we pass skipMultipliers for clarity.
  const sellResult = await distributeIncome(ownerId, totalReturn, { skipMultipliers: true });

  // Update stock: decrement shares outstanding, increment volume
  await Stock.findOneAndUpdate(
    { userId: targetUserId },
    { $inc: { sharesOutstanding: -amount, volume24h: amount } }
  );

  // Apply sell pressure: -1% multiplicative
  await Stock.findOneAndUpdate(
    { userId: targetUserId },
    [{ $set: {
      currentPrice: { $max: [PRICE_FLOOR, { $multiply: ['$currentPrice', 1 - SELL_PRESSURE] }] },
      dailyHigh: { $max: ['$dailyHigh', { $max: [PRICE_FLOOR, { $multiply: ['$currentPrice', 1 - SELL_PRESSURE] }] }] },
      dailyLow: { $min: ['$dailyLow', { $max: [PRICE_FLOOR, { $multiply: ['$currentPrice', 1 - SELL_PRESSURE] }] }] },
      allTimeHigh: { $max: ['$allTimeHigh', { $max: [PRICE_FLOOR, { $multiply: ['$currentPrice', 1 - SELL_PRESSURE] }] }] },
      lastActivityAt: Date.now(),
    }}],
    { updatePipeline: true }
  );
  
  // Re-fetch user to get the new balance
  const seller = await User.findOne({ userId: ownerId });

  return NextResponse.json({
    success: true,
    action: 'sell',
    shares: amount,
    totalReturn,
    newBalance: seller ? seller.coins : 0,
    pricePerShare: stock.currentPrice,
  });
}
