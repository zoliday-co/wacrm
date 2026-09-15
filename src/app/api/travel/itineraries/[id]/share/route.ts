import { travelRoute } from '@/lib/travel/route';
import { shareItinerary } from '@/lib/travel/itinerary-sharing';

export const POST = travelRoute('agent', async (ctx, request) =>
  shareItinerary(ctx.supabase, ctx.accountId, ctx.params.id, {
    actorUserId: ctx.userId,
    request,
  })
);
