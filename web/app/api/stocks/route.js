import { NextResponse } from 'next/server';
import { getModels } from '@/lib/models';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  try {
    const { Stock, User } = await getModels();
    const { searchParams } = new URL(request.url);
    const sort = searchParams.get('sort');

    let sortQuery = { currentPrice: -1 }; // default: price desc
    if (sort === 'gainers') {
      // Will sort in-memory after computing change %
      sortQuery = {};
    } else if (sort === 'losers') {
      sortQuery = {};
    }

    const stocks = await Stock.find({}).lean();

    // Enrich with user display data
    const userIds = stocks.map((s) => s.userId);
    const users = await User.find({ userId: { $in: userIds } })
      .select('userId equippedTitle prestige displayName avatarUrl')
      .lean();
    const userMap = {};
    for (const u of users) {
      userMap[u.userId] = u;
    }

    let results = stocks.map((s) => {
      const changePct =
        s.previousClose > 0
          ? ((s.currentPrice - s.previousClose) / s.previousClose) * 100
          : 0;
      const u = userMap[s.userId];
      return {
        userId: s.userId,
        displayName: u?.displayName || s.userId,
        avatarUrl: u?.avatarUrl || null,
        currentPrice: s.currentPrice,
        previousClose: s.previousClose,
        sharesOutstanding: s.sharesOutstanding,
        dailyHigh: s.dailyHigh,
        dailyLow: s.dailyLow,
        allTimeHigh: s.allTimeHigh,
        volume24h: s.volume24h,
        changePct,
        user: u || null,
      };
    });

    // Sort based on query param
    if (sort === 'gainers') {
      results.sort((a, b) => b.changePct - a.changePct);
    } else if (sort === 'losers') {
      results.sort((a, b) => a.changePct - b.changePct);
    } else {
      // default: price desc
      results.sort((a, b) => b.currentPrice - a.currentPrice);
    }

    return NextResponse.json(results);
  } catch (err) {
    console.error('[API /stocks] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
