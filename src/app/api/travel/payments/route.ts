import { travelRoute, query } from '@/lib/travel/route';
import { listPayments } from '@/lib/travel/bookings';

export const GET = travelRoute('viewer', async (ctx, request) => {
  const q = query(request);
  const kind = q.get('kind');
  return listPayments(ctx.supabase, ctx.accountId, { kind: kind === 'customer' || kind === 'supplier' ? kind : 'all', from: q.get('from'), to: q.get('to'), limit: Number(q.get('limit') ?? 200) });
});
