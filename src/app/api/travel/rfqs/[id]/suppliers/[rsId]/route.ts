// DELETE /api/travel/rfqs/[id]/suppliers/[rsId] — remove (revokes the supplier's link)
// POST   /api/travel/rfqs/[id]/suppliers/[rsId] — { action: 'resend' | 'remind' }

import { travelRoute, readJson } from '@/lib/travel/route';
import { dispatchRfqSupplier, refreshRfqStatus, removeSupplierFromRfq } from '@/lib/travel/rfq';
import { badRequest } from '@/lib/travel/errors';

export const DELETE = travelRoute('agent', async (ctx) => {
  await removeSupplierFromRfq(ctx.supabase, ctx.accountId, ctx.params.id, ctx.params.rsId, { actorUserId: ctx.userId });
  return { ok: true };
});

export const POST = travelRoute('agent', async (ctx, request) => {
  const body = await readJson(request);
  if (body.action !== 'resend' && body.action !== 'remind') throw badRequest('Unknown action');
  const result = await dispatchRfqSupplier(ctx.supabase, ctx.accountId, ctx.params.rsId, {
    actorUserId: ctx.userId,
    request,
    reminder: body.action === 'remind',
  });
  await refreshRfqStatus(ctx.supabase, ctx.accountId, ctx.params.id, ctx.userId);
  return { result };
});
