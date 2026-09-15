import { resolveItineraryToken } from '@/lib/travel/itinerary-sharing';
import { renderItineraryPdf } from '@/lib/travel/itinerary-pdf';
import { travelErrorResponse } from '@/lib/travel/errors';

type Context = { params: Promise<{ token: string }> };

export async function GET(_request: Request, { params }: Context) {
  try {
    const { token } = await params;
    const view = await resolveItineraryToken(token);
    const pdf = await renderItineraryPdf(view);
    const filename = `${view.destination?.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'oliday'}-itinerary.pdf`;
    return new Response(Buffer.from(pdf), {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'private, no-store',
      },
    });
  } catch (error) {
    return travelErrorResponse(error);
  }
}
