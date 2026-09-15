// GET  /api/travel/leads/[id]/itineraries — versions (+ a skeleton when none exist)
// POST /api/travel/leads/[id]/itineraries — create a version, or edit a DRAFT when itinerary_id is set

import { travelRoute, readJson } from '@/lib/travel/route';
import { listItineraries, parseItineraryInput, saveItinerary, skeletonDays } from '@/lib/travel/itineraries';
import { getLead } from '@/lib/travel/leads';

export const GET = travelRoute('viewer', async (ctx) => {
  const lead = await getLead(ctx.supabase, ctx.accountId, ctx.params.id);
  const itineraries = await listItineraries(ctx.supabase, ctx.accountId, lead.id);
  return { itineraries, skeleton: skeletonDays(lead) };
});

export const POST = travelRoute('agent', async (ctx, request) => {
  const input = parseItineraryInput(await readJson(request));
  const itinerary = await saveItinerary(ctx.supabase, ctx.accountId, ctx.params.id, input, ctx.userId);
  return { itinerary };
});
