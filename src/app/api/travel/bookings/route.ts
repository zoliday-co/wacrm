import { travelRoute, query } from '@/lib/travel/route';
import { listBookings } from '@/lib/travel/bookings';
import type { BookingStatus } from '@/types/travel';

export const GET = travelRoute('viewer', async (ctx, request) => {
  const q = query(request);
  return { bookings: await listBookings(ctx.supabase, ctx.accountId, { status: (q.get('status') as BookingStatus | 'open' | 'all' | null) ?? 'open', from: q.get('from'), to: q.get('to'), q: q.get('q'), limit: Number(q.get('limit') ?? 200) }) };
});
