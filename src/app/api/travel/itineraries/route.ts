import { travelRoute, query } from '@/lib/travel/route';
import { listItineraries } from '@/lib/travel/itineraries';

export const GET = travelRoute('viewer', async (ctx, request) => ({ itineraries: await listItineraries(ctx.supabase, ctx.accountId, query(request).get('lead_id')) }));
