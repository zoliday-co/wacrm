import { travelRoute, readJson } from '@/lib/travel/route';
import { updateDestination } from '@/lib/travel/suppliers';

export const PATCH = travelRoute('admin', async (ctx, request) => ({ destination: await updateDestination(ctx.supabase, ctx.accountId, ctx.params.id, await readJson(request)) }));
