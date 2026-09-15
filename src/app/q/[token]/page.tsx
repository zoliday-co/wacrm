import { PublicTravellerQuote } from '@/components/travel/public-traveller-quote';
export default async function Page({ params }: { params: Promise<{ token: string }> }) { const { token } = await params; return <PublicTravellerQuote token={token} />; }
