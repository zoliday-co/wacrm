import { travelRoute } from '@/lib/travel/route';
import { getItinerary } from '@/lib/travel/itineraries';
import { getLead } from '@/lib/travel/leads';
import { publicItineraryView } from '@/lib/travel/itinerary-sharing';
import { renderItineraryPdf } from '@/lib/travel/itinerary-pdf';

export const GET = travelRoute('viewer', async (ctx) => {
  const itinerary = await getItinerary(ctx.supabase, ctx.accountId, ctx.params.id);
  const lead = await getLead(ctx.supabase, ctx.accountId, itinerary.travel_lead_id);
  const pdf = await renderItineraryPdf(publicItineraryView(itinerary, lead));
  const filename = `${slug(itinerary.title)}-v${itinerary.version}.pdf`;
  return new Response(Buffer.from(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, no-store',
    },
  });
});

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'oliday-itinerary';
}
