import { NextResponse } from 'next/server';
import { getModels } from '@/lib/models';

export const dynamic = 'force-dynamic';

export async function GET(request, { params }) {
  try {
    const { userId } = await params;
    const { Stock, Portfolio, User } = await getModels();

    const stock = await Stock.findOne({ userId }).lean();
    if (!stock) {
      return NextResponse.json({ error: 'Stock not found' }, { status: 404 });
    }

    // Get top 5 holders by shares
    const topHolders = await Portfolio.find({ targetUserId: userId, shares: { $gt: 0 } })
      .sort({ shares: -1 })
      .limit(5)
      .lean();

    // Enrich holders with user display data
    const holderIds = topHolders.map((h) => h.ownerId);
    const holderUsers = await User.find({ userId: { $in: holderIds } })
      .select('userId equippedTitle prestige displayName avatarUrl')
      .lean();
    const holderMap = {};
    for (const u of holderUsers) {
      holderMap[u.userId] = u;
    }

    const holders = topHolders.map((h) => {
      const u = holderMap[h.ownerId];
      return {
        ownerId: h.ownerId,
        displayName: u?.displayName || h.ownerId,
        avatarUrl: u?.avatarUrl || null,
        shares: h.shares,
        totalInvested: h.totalInvested,
        user: u || null,
      };
    });

    // Get the stock owner's user data
    const owner = await User.findOne({ userId })
      .select('userId equippedTitle prestige displayName avatarUrl')
      .lean();

    const changePct =
      stock.previousClose > 0
        ? ((stock.currentPrice - stock.previousClose) / stock.previousClose) * 100
        : 0;

    return NextResponse.json({
      ...stock,
      displayName: owner?.displayName || stock.userId,
      avatarUrl: owner?.avatarUrl || null,
      changePct,
      owner: owner || null,
      topHolders: holders,
    });
  } catch (err) {
    console.error('[API /stock/:userId] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
