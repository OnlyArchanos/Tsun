const User = require('../models/User');
const Loan = require('../models/Loan');
const ServerStats = require('../models/ServerStats');
const config = require('../config');

/**
 * Centralized Income Handler for Phase 3.
 * Automatically processes Prestige Bonuses, Slave Taxes, and Loan Repayments.
 * @param {string} userId - The ID of the user receiving money.
 * @param {number} baseAmount - The gross amount earned (before bonuses).
 * @param {Object} options - Additional distribution options.
 * @returns {Promise<string>} - A log string detailing deductions/bonuses.
 */
async function distributeIncome(userId, baseAmount, options = {}) {
    if (baseAmount <= 0) return "";
    const { skipMultipliers = false } = options;

    // --- DEFINE LOG EARLY TO PREVENT CRASHES ---
    let log = "";
    const carrotResetSet = {
        'activeCarrot.amount': 0,
        'activeCarrot.bonusPerHr': 0,
        'activeCarrot.expiresAt': 0,
        'activeCarrot.ownerId': null
    };

    // 1. Fetch User (Fresh Data)
    const user = await User.findOne({ userId: userId }) || new User({ userId: userId });

    // MOVED UP — was computed inside final payout block, needed early for decay calc
    const baseCap = config.ECONOMY.BASE_WALLET_CAP;
    const extraPerLevel = config.ECONOMY.WALLET_CAP_PER_LEVEL;
    const forgeBonusCap = (user.upgrades?.walletTier || 0) * config.ECONOMY.FORGE_WALLET_CAP_PER_TIER;
    const WALLET_CAP = baseCap + ((user.prestige || 0) * extraPerLevel) + forgeBonusCap;

    // Fix 2: prestige/amulet bonus decays as wallet fills toward cap
    // walletFill: how full the wallet is as a ratio, clamped 0–1
    // Math.min(1, ...) handles edge case where user has MORE coins than cap
    // (can happen if cap was lowered by admin — prevents decayFactor going negative)
    const walletFill = WALLET_CAP > 0 ? Math.min(1, user.coins / WALLET_CAP) : 0;
    // WALLET_CAP > 0 guard prevents division by zero; returns 0 fill (= full bonus) as safe fallback

    // decayFactor: 1.0 below 80% fill, fades linearly to 0.0 at 95%+
    // Formula: 1 - ((fill - 0.80) / 0.15), then clamped to [0, 1]
    // Verification:
    //   fill=0.50 → 1 - (-2.0) = 3.0 → clamped to 1.0  (full bonus)
    //   fill=0.80 → 1 - (0.0)  = 1.0 → clamped to 1.0  (full bonus, threshold begins)
    //   fill=0.875→ 1 - (0.5)  = 0.5                    (half bonus)
    //   fill=0.95 → 1 - (1.0)  = 0.0                    (zero bonus)
    //   fill=1.00 → 1 - (1.33) = -0.33 → clamped to 0.0 (zero)
    const decayFactor = Math.max(0, Math.min(1, 1 - ((walletFill - config.ECONOMY.PRESTIGE_DECAY_START) / config.ECONOMY.PRESTIGE_DECAY_RANGE)));

    // ==================== DOUBLE DIP (consume on first use) ====================
    if (user.doubleDipActive && !skipMultipliers) {
        const dipResult = await User.findOneAndUpdate(
            { userId, doubleDipActive: true },
            { $set: { doubleDipActive: false } },
            { new: true }
        );
        if (dipResult) {
            baseAmount = baseAmount * 2;
            log += '\n✌️ **Double Dip:** Income doubled! (consumed)';
        }
    }

    // currentWealth used by rich tax to determine bracket
    const currentWealth = user.coins;

    // ==================== PRESTIGE BONUS (decays near wallet cap) ====================
    // Level 0: None
    // Level 1 (Iron): +10% | Level 2 (Bronze): +20% | Level 3 (Silver): +50%
    // Level 4 (Gold): +100% | Level 5 (Plat): +150% | Level 6 (Master): +200%
    const multipliers = config.ECONOMY.PRESTIGE_MULTIPLIERS;
    const userLevel = user.prestige || 0;
    const mult = skipMultipliers ? 0 : (multipliers[userLevel] || 0);
    // Fix 2: store undecayed amount separately for the log string (players need to see what was reduced)
    const rawPrestigeBonus = Math.floor(baseAmount * mult);
    // Fix 1: apply decay — at high wallet fill this approaches 0
    const bonus = Math.floor(rawPrestigeBonus * decayFactor);

    // ==================== GOLDEN AMULET BONUS (decays near wallet cap) ====================
    // Fix 2: store undecayed amount for log transparency (same pattern as prestige)
    const rawAmuletBonus = skipMultipliers ? 0 : Math.floor(baseAmount * (user.goldenAmuletCount || 0) * config.GOLDEN_AMULET_BONUS);    // Fix 1: apply same decay factor as prestige
    const goldenAmuletBonus = Math.floor(rawAmuletBonus * decayFactor);

    // Fix 1: compute full total BEFORE tax so bonuses are included in the tax base
    // Previously: tax hit baseAmount, then bonuses were added tax-free on top
    // Now: bonuses are added first, then tax hits the combined total
    const preTaxTotal = baseAmount + bonus + goldenAmuletBonus;

    let taxBurn = 0;
    if (currentWealth > config.ECONOMY.MILLIONAIRE_TAX_THRESHOLD) {
        taxBurn = Math.floor(preTaxTotal * config.ECONOMY.MILLIONAIRE_TAX_RATE);
    } else if (currentWealth > config.ECONOMY.RICH_TAX_THRESHOLD) {
        taxBurn = Math.floor(preTaxTotal * config.ECONOMY.RICH_TAX_RATE);
    }

    const totalAmount = preTaxTotal - taxBurn;
    // was: baseAmount - taxBurn + bonus + goldenAmuletBonus
    // algebraically equivalent when taxBurn=0, but now taxBurn is larger (taxes the bonuses too)

    let netIncome = totalAmount;
    let slaveTax = 0;
    let loanRepayment = 0;

    // ==================== SLAVE LOGIC ====================
    if (user.isSlave && user.slaveOwner) {
        slaveTax = Math.floor(netIncome * config.ECONOMY.SLAVE_TAX_RATE); // 40% Tax on remaining

        if (slaveTax > 0) {
            netIncome -= slaveTax;

            // Transfer to Owner (also increment masterIncomeFromSlaves stats)
            await User.findOneAndUpdate(
                { userId: user.slaveOwner },
                { $inc: { coins: slaveTax, masterIncomeFromSlaves: slaveTax } },
                { upsert: true }
            );
        }
    }

    // ==================== LOAN LOGIC ====================
    // Find earliest Active or Defaulted loan
    const loan = await Loan.findOne({
        borrowerId: userId,
        status: { $in: ['ACTIVE', 'DEFAULTED'] }
    }).sort({ dueDate: 1 });

    if (loan) {
        // Repay with optimistic locking so concurrent payouts cannot over-credit lender.
        const repayBudget = Math.floor(netIncome * config.ECONOMY.LOAN_REPAY_RATE);
        if (repayBudget > 0) {
            for (let attempt = 0; attempt < 3; attempt++) {
                const currentLoan = await Loan.findOne({
                    _id: loan._id,
                    borrowerId: userId,
                    status: { $in: ['ACTIVE', 'DEFAULTED'] }
                }).select('remainingAmount status lenderId').lean();

                if (!currentLoan || currentLoan.remainingAmount <= 0) {
                    break;
                }

                const repayThisAttempt = Math.min(repayBudget, currentLoan.remainingAmount);
                if (repayThisAttempt <= 0) {
                    break;
                }

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

                if (loanUpdate.modifiedCount === 0) {
                    continue;
                }

                loanRepayment = repayThisAttempt;
                netIncome -= loanRepayment;

                // Transfer to lender only after successful optimistic write.
                await User.findOneAndUpdate(
                    { userId: currentLoan.lenderId },
                    { $inc: { coins: loanRepayment } },
                    { upsert: true }
                );

                // If the loan is fully repaid, free the slave and process carrot backfire.
                if (newStatus === 'PAID') {
                    const freedSlave = await User.findOne({ userId });
                    if (freedSlave?.activeCarrot?.expiresAt > Date.now() && freedSlave.activeCarrot.amount > 0) {
                        const burnedAmount = freedSlave.activeCarrot.amount;
                        const ownerId = freedSlave.activeCarrot.ownerId;
                        const ownerMention = ownerId ? `<@${ownerId}>` : "Someone";
                        log += `\n🔥 **CARROT BURNED!** ${ownerMention} lost **${burnedAmount.toLocaleString('en-US')}c** — their slave escaped mid-carrot! Should've done the math! (¬_¬)`;
                    }

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

    // ==================== FINAL PAYOUT & VAULT CAP ====================
    let finalIncome = netIncome;
    let overflow = 0;

    if (finalIncome > 0) {
        // WALLET_CAP computed at top of function — reusing here
        if (user.coins + finalIncome > WALLET_CAP) {
            overflow = (user.coins + finalIncome) - WALLET_CAP;
            finalIncome = Math.max(0, finalIncome - overflow);
            log += `\n🛑 **Wallet Full:** ${overflow.toLocaleString('en-US')} coins vanished! (Cap: ${WALLET_CAP.toLocaleString('en-US')})`;
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

    // --- STEP 9: GLOBAL TRACKING ---
    try {
        const targetStats = await ServerStats.findOne({}).sort({ lastReset: -1 }).select('_id').lean();
        if (targetStats?._id) {
            await ServerStats.updateOne(
                { _id: targetStats._id },
                { $inc: { weeklyCoinCount: totalAmount } }
            );
        }
    } catch (e) {
        console.error("Stats update failed... T-This isn't my fault! >///<", e);
    }

    // ==================== GENERATE LOG ====================
    // Append details to the log string we defined at the start
    // Prestige bonus log — show decay info only when actually decayed (don't clutter every payout)
    if (rawPrestigeBonus > 0) {
        if (decayFactor < 1) {
            const pct = Math.round(walletFill * 100);
            log += `\n🌟 **Prestige Bonus:** +${bonus.toLocaleString('en-US')} Coins *(wallet ${pct}% full — reduced from ${rawPrestigeBonus.toLocaleString('en-US')})*`;
        } else {
            log += `\n🌟 **Prestige Bonus:** +${bonus.toLocaleString('en-US')} Coins`;
        }
    }

    // Amulet bonus log — same pattern as prestige
    if (rawAmuletBonus > 0) {
        if (decayFactor < 1) {
            log += `\n🥇 **Golden Amulet:** +${goldenAmuletBonus.toLocaleString('en-US')} Coins *(reduced — wallet near cap)*`;
        } else {
            log += `\n🥇 **Golden Amulet:** +${goldenAmuletBonus.toLocaleString('en-US')} Coins`;
        }
    }

    if (slaveTax > 0) log += `\n⛓️ **Slave Tax:** -${slaveTax} Coins (to Master)`;
    if (loanRepayment > 0) log += `\n💸 **Loan Repay:** -${loanRepayment} Coins`;
    // Rich tax — updated message acknowledges it now hits the full payout not just base
    if (taxBurn > 0) log += `\n🔥 **Rich Tax:** -${taxBurn.toLocaleString('en-US')} Coins (on full payout — you earned too much)`;

    return log;
}

module.exports = { distributeIncome };

