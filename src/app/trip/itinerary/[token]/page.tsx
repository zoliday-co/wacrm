import { notFound } from 'next/navigation';
import { BrandedItinerary } from '@/components/travel/branded-itinerary';
import { resolveItineraryToken } from '@/lib/travel/itinerary-sharing';

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const view = await loadItinerary(token);
  if (!view) notFound();
  return <BrandedItinerary view={view} downloadUrl={`/api/public/travel/itinerary/${encodeURIComponent(token)}/download`} />;
}

async function loadItinerary(token: string) {
  try {
    return await resolveItineraryToken(token);
  } catch {
    return null;
  }
}
