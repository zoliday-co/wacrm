import { PublicCallback } from '@/components/travel/public-callback';
export default async function Page({ params }: { params: Promise<{ token: string }> }) { const { token } = await params; return <PublicCallback token={token} />; }
