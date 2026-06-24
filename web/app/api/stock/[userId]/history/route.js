import { NextResponse } from 'next/server';
import { getModels } from '@/lib/models';

export async function GET(request, { params }) {
  try {
    const { userId } = await params;
    const { StockHistory } = await getModels();
    const { searchParams } = new URL(request.url);
    const range = searchParams.get('range') || '24h';

    let since;
    const now = Date.now();
    if (range === '7d') {
      since = new Date(now - 7 * 24 * 60 * 60 * 1000);
    } else if (range === '30d') {
      since = new Date(now - 30 * 24 * 60 * 60 * 1000);
    } else {
      // default 24h
      since = new Date(now - 24 * 60 * 60 * 1000);
    }

    const history = await StockHistory.find({
      userId,
      timestamp: { $gte: since },
    })
      .sort({ timestamp: 1 })
      .lean();

    return NextResponse.json(history);
  } catch (err) {
    console.error('[API /stock/:userId/history] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
