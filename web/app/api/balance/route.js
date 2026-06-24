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

    const { User } = await getModels();
    const user = await User.findOne({ userId: session.user.discordId }).lean();

    if (!user) {
      return NextResponse.json({ coins: 0, userId: session.user.discordId });
    }

    return NextResponse.json({ coins: user.coins, userId: user.userId });
  } catch (err) {
    console.error('[API /balance] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
