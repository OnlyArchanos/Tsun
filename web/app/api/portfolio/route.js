import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getModels } from '@/lib/models';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.discordId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { Portfolio, Stock, User } = await getModels();
    const ownerId = session.user.discordId;

    const holdings = await Portfolio.find({ ownerId, shares: { $gt: 0 } }).lean();

    if (holdings.length === 0) {
      return NextResponse.json({ holdings: [], totalEquity: 0, totalInvested: 0, totalPnl: 0 });
    }

    // Fetch all relevant stocks and users in batch
    const targetIds = holdings.map((h) => h.targetUserId);
    const [stocks, users] = await Promise.all([
      Stock.find({ userId: { $in: targetIds } }).lean(),
      User.find({ userId: { $in: targetIds } }).select('userId equippedTitle prestige displayName avatarUrl').lean(),
    ]);

    const stockMap = {};
    for (const s of stocks) stockMap[s.userId] = s;
    const userMap = {};
    for (const u of users) userMap[u.userId] = u;

    let totalEquity = 0;
    let totalInvested = 0;

    const enriched = holdings.map((h) => {
      const stock = stockMap[h.targetUserId];
      const price = stock?.currentPrice || 0;
      const value = h.shares * price;
      const pnl = value - h.totalInvested;
      const pnlPct = h.totalInvested > 0 ? (pnl / h.totalInvested) * 100 : 0;

      totalEquity += value;
      totalInvested += h.totalInvested;

      const u = userMap[h.targetUserId];
      return {
        targetUserId: h.targetUserId,
        displayName: u?.displayName || h.targetUserId,
        avatarUrl: u?.avatarUrl || null,
        shares: h.shares,
        totalInvested: h.totalInvested,
        currentPrice: price,
        value,
        pnl,
        pnlPct,
        user: u || null,
      };
    });

    return NextResponse.json({
      holdings: enriched,
      totalEquity,
      totalInvested,
      totalPnl: totalEquity - totalInvested,
    });
  } catch (err) {
    console.error('[API /portfolio] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
