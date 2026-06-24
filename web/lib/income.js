import { getModels } from './models.js';

// Config values matching config.js
const BASE_WALLET_CAP = 5000000;
const WALLET_CAP_PER_LEVEL = 85000000;
const FORGE_WALLET_CAP_PER_TIER = 40000000;
const SLAVE_TAX_RATE = 0.4;
const LOAN_REPAY_RATE = 0.2;

export async function distributeIncome(userId, baseAmount) {
  if (baseAmount <= 0) return { slaveTax: 0, loanRepayment: 0, taxBurn: 0, overflow: 0, netIncome: 0 };

  const { User, Loan, ServerStats } = await getModels();

  const carrotResetSet = {
    'activeCarrot.amount': 0,
    'activeCarrot.bonusPerHr': 0,
    'activeCarrot.expiresAt': 0,
    'activeCarrot.ownerId': null
  };

  const user = await User.findOne({ userId }) || new User({ userId });

  const WALLET_CAP = BASE_WALLET_CAP 
    + ((user.prestige || 0) * WALLET_CAP_PER_LEVEL) 
    + ((user.upgrades?.walletTier || 0) * FORGE_WALLET_CAP_PER_TIER);

  // Since website is stock trades only, skipMultipliers is implicitly true.
  // We do NOT apply double dip, prestige multipliers, or Golden Amulet.
  const preTaxTotal = baseAmount; 

  const currentWealth = user.coins;
  let taxBurn = 0;
  if (currentWealth > 1000000) {
    taxBurn = Math.floor(preTaxTotal * 0.30);
  } else if (currentWealth > 100000) {
    taxBurn = Math.floor(preTaxTotal * 0.20);
  }

  const totalAmount = preTaxTotal - taxBurn;

  let netIncome = totalAmount;
  let slaveTax = 0;
  let loanRepayment = 0;

  // Slave Tax
  if (user.isSlave && user.slaveOwner) {
    slaveTax = Math.floor(netIncome * SLAVE_TAX_RATE);
    if (slaveTax > 0) {
      netIncome -= slaveTax;
      // Transfer to Owner (also increment masterIncomeFromSlaves)
      await User.findOneAndUpdate(
        { userId: user.slaveOwner },
        { $inc: { coins: slaveTax, masterIncomeFromSlaves: slaveTax } },
        { upsert: true }
      );
    }
  }

  // Loan Repayments
  const loan = await Loan.findOne({
    borrowerId: userId,
    status: { $in: ['ACTIVE', 'DEFAULTED'] }
  }).sort({ dueDate: 1 });

  if (loan) {
    const repayBudget = Math.floor(netIncome * LOAN_REPAY_RATE);
    if (repayBudget > 0) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const currentLoan = await Loan.findOne({
          _id: loan._id,
          borrowerId: userId,
          status: { $in: ['ACTIVE', 'DEFAULTED'] }
        }).select('remainingAmount status lenderId').lean();

        if (!currentLoan || currentLoan.remainingAmount <= 0) break;

        const repayThisAttempt = Math.min(repayBudget, currentLoan.remainingAmount);
        if (repayThisAttempt <= 0) break;

        const newRemaining = currentLoan.remainingAmount - repayThisAttempt;
        const newStatus = newRemaining <= 0 ? 'PAID' : currentLoan.status;

        const loanUpdate = await Loan.updateOne(
          {
            _id: loan._id,
            borrowerId: userId,
            status: currentLoan.status,
            remainingAmount: currentLoan.remainingAmount
          },
          { $set: { remainingAmount: newRemaining, status: newStatus } }
        );

        if (loanUpdate.modifiedCount === 0) continue;

        loanRepayment = repayThisAttempt;
        netIncome -= loanRepayment;

        await User.findOneAndUpdate(
          { userId: currentLoan.lenderId },
          { $inc: { coins: loanRepayment } },
          { upsert: true }
        );

        if (newStatus === 'PAID') {
          await User.findOneAndUpdate(
            { userId },
            {
              $set: {
                isSlave: false,
                slaveOwner: null,
                carrotResistUsed: false,
                resistExpiresAt: 0,
                ...carrotResetSet
              }
            }
          );
        }
        break;
      }
    }
  }

  // Wallet Cap
  let finalIncome = netIncome;
  let overflow = 0;
  if (finalIncome > 0) {
    if (user.coins + finalIncome > WALLET_CAP) {
      overflow = (user.coins + finalIncome) - WALLET_CAP;
      finalIncome = Math.max(0, finalIncome - overflow);
    }
  }

  const updates = {};
  if (finalIncome > 0) updates.coins = finalIncome;
  if (preTaxTotal > 0) updates.systemEarned = preTaxTotal;
  const totalSpentHere = taxBurn + overflow;
  if (totalSpentHere > 0) updates.systemSpent = totalSpentHere;

  if (Object.keys(updates).length > 0) {
    await User.updateOne({ userId }, { $inc: updates }, { upsert: true });
  }

  // Server Stats Weekly Coin Tracker
  try {
    const targetStats = await ServerStats.findOne({}).sort({ lastReset: -1 }).select('_id').lean();
    if (targetStats?._id) {
      await ServerStats.updateOne(
        { _id: targetStats._id },
        { $inc: { weeklyCoinCount: totalAmount } }
      );
    }
  } catch (e) {
    console.error("Stats update failed:", e);
  }

  return {
    slaveTax,
    loanRepayment,
    taxBurn,
    overflow,
    netIncome: finalIncome
  };
}
