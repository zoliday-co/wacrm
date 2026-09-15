// GET /api/travel/rfqs?status=&lead_id=

import { travelRoute, query } from '@/lib/travel/route';
import { listRfqs } from '@/lib/travel/rfq';

export const GET = travelRoute('viewer', async (ctx, request) => {
  const q = query(request);
  return { rfqs: await listRfqs(ctx.supabase, ctx.accountId, { status: q.get('status'), leadId: q.get('lead_id'), limit: Number(q.get('limit') ?? 100) }) };
});
