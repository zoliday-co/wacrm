import { travelRoute, query } from '@/lib/travel/route';
import { listTasks } from '@/lib/travel/tasks';
export const GET = travelRoute('viewer', async (ctx, request) => {
  const q = query(request);
  const status = q.get('status');
  return { tasks: await listTasks(ctx.supabase, ctx.accountId, { status: status === 'done' || status === 'all' ? status : 'open', scope: q.get('scope') === 'mine' ? 'mine' : 'all', leadId: q.get('lead_id'), bookingId: q.get('booking_id'), dueBefore: q.get('due_before'), limit: Number(q.get('limit') ?? 200) }, ctx.userId) };
});
