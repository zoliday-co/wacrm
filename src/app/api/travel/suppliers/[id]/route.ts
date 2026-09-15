import { travelRoute, readJson } from '@/lib/travel/route';
import { getSupplier, softDeleteSupplier, updateSupplier } from '@/lib/travel/suppliers';

export const GET = travelRoute('viewer', async (ctx) => ({ supplier: await getSupplier(ctx.supabase, ctx.accountId, ctx.params.id) }));
export const PATCH = travelRoute('agent', async (ctx, request) => ({ supplier: await updateSupplier(ctx.supabase, ctx.accountId, ctx.params.id, await readJson(request)) }));
export const DELETE = travelRoute('admin', async (ctx) => { await softDeleteSupplier(ctx.supabase, ctx.accountId, ctx.params.id); return { ok: true }; });
