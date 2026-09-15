// GET /api/travel/leads/[id]/timeline?messages=1

import { travelRoute, query } from '@/lib/travel/route';
import { getLead } from '@/lib/travel/leads';
import { getLeadTimeline } from '@/lib/travel/timeline';

export const GET = travelRoute('viewer', async (ctx, request) => {
  const lead = await getLead(ctx.supabase, ctx.accountId, ctx.params.id);
  const q = query(request);
  const entries = await getLeadTimeline(ctx.supabase, ctx.accountId, lead, {
    includeMessages: q.get('messages') !== '0',
    limit: Number(q.get('limit') ?? 200),
  });
  // `timeline` is the public response key consumed by the lead detail UI.
  // Keep `entries` as a compatibility alias for early API clients.
  return { timeline: entries, entries };
});
