// POST /api/travel/leads/[id]/rfqs — { supplier_ids?: string[], send?: boolean, notes? }
//   Creates RFQ V(n+1) from the lead's current requirement (auto-matched unless ids given).

import { travelRoute, readJson } from '@/lib/travel/route';
import { createRfqForLead } from '@/lib/travel/rfq';

export const POST = travelRoute('agent', async (ctx, request) => {
  const body = await readJson(request);
  const supplierIds = Array.isArray(body.supplier_ids) ? body.supplier_ids.filter((s): s is string => typeof s === 'string') : undefined;
  const result = await createRfqForLead(ctx.supabase, ctx.accountId, ctx.params.id, {
    actorUserId: ctx.userId,
    supplierIds,
    send: typeof body.send === 'boolean' ? body.send : undefined,
    notes: typeof body.notes === 'string' ? body.notes.slice(0, 2000) : null,
    request,
  });
  return { rfq: result.rfq, matched_count: result.matchedCount, send_results: result.sendResults };
});
