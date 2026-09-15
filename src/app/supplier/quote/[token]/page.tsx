import { PublicSupplierQuote } from '@/components/travel/public-supplier-quote';
export default async function Page({ params }: { params: Promise<{ token: string }> }) { const { token } = await params; return <PublicSupplierQuote token={token} />; }
