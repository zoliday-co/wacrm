import { travelRoute, readJson } from '@/lib/travel/route';
import { badRequest } from '@/lib/travel/errors';
import { getItinerary, setItineraryStatus } from '@/lib/travel/itineraries';

export const GET = travelRoute('viewer', async (ctx) => ({
  itinerary: await getItinerary(ctx.supabase, ctx.accountId, ctx.params.id),
}));

export const POST = travelRoute('agent', async (ctx, request) => {
  const body = await readJson(request);
  if (!['DRAFT', 'FINAL', 'ARCHIVED'].includes(String(body.status))) throw badRequest('Invalid itinerary status');
  return {
    itinerary: await setItineraryStatus(
      ctx.supabase,
      ctx.accountId,
      ctx.params.id,
      body.status as 'DRAFT' | 'FINAL' | 'ARCHIVED',
      ctx.userId
    ),
  };
});
