// POST /api/travel/leads/[id]/notify — manually (re)send the "quotes ready" WhatsApp + callback link

import { travelRoute } from '@/lib/travel/route';
import { notifyTravellerQuotesReady } from '@/lib/travel/callbacks';

export const POST = travelRoute('agent', async (ctx, request) => {
  const result = await notifyTravellerQuotesReady(ctx.supabase, ctx.accountId, ctx.params.id, {
    actorUserId: ctx.userId,
    request,
    reason: 'sent manually by agent',
  });
  return result;
});
