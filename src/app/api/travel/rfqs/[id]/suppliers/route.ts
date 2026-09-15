// POST /api/travel/rfqs/[id]/suppliers — { supplier_id, send?: boolean } add a supplier to a live RFQ

import { travelRoute, readJson } from '@/lib/travel/route';
import { addSupplierToRfq } from '@/lib/travel/rfq';
import { badRequest } from '@/lib/travel/errors';

export const POST = travelRoute('agent', async (ctx, request) => {
  const body = await readJson(request);
  if (typeof body.supplier_id !== 'string') throw badRequest('supplier_id is required');
  const recipient = await addSupplierToRfq(ctx.supabase, ctx.accountId, ctx.params.id, body.supplier_id, {
    actorUserId: ctx.userId,
    send: body.send !== false,
    request,
  });
  return { recipient };
});
