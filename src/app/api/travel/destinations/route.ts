import { travelRoute, readJson } from '@/lib/travel/route';
import { createDestination, destinationTree, listDestinations, seedDefaultDestinations } from '@/lib/travel/suppliers';

export const GET = travelRoute('viewer', async (ctx) => {
  const destinations = await listDestinations(ctx.supabase, ctx.accountId);
  return { destinations, tree: destinationTree(destinations) };
});
export const POST = travelRoute('admin', async (ctx, request) => {
  const body = await readJson(request);
  if (body.action === 'seed_defaults') return { created: await seedDefaultDestinations(ctx.supabase, ctx.accountId) };
  return { destination: await createDestination(ctx.supabase, ctx.accountId, body) };
});
