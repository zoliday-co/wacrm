import { travelRoute, query, readJson } from '@/lib/travel/route';
import { createSupplier, listSuppliers } from '@/lib/travel/suppliers';

export const GET = travelRoute('viewer', async (ctx, request) => {
  const q = query(request);
  return { suppliers: await listSuppliers(ctx.supabase, ctx.accountId, { q: q.get('q'), destinationId: q.get('destination_id'), includeInactive: q.get('all') === 'true' }) };
});

export const POST = travelRoute('agent', async (ctx, request) => ({
  supplier: await createSupplier(ctx.supabase, ctx.accountId, await readJson(request), ctx.userId),
}));
