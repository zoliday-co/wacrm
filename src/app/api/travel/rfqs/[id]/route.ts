// GET   /api/travel/rfqs/[id]
// POST  /api/travel/rfqs/[id] — { action: 'send' } re-send to every PENDING recipient, { action: 'cancel' }

import { travelRoute, readJson } from '@/lib/travel/route';
import { getRfq, sendRfq } from '@/lib/travel/rfq';
import { badRequest } from '@/lib/travel/errors';

export const GET = travelRoute('viewer', async (ctx) => {
  return { rfq: await getRfq(ctx.supabase, ctx.accountId, ctx.params.id) };
});

export const POST = travelRoute('agent', async (ctx, request) => {
  const body = await readJson(request);
  if (body.action === 'send') {
    const results = await sendRfq(ctx.supabase, ctx.accountId, ctx.params.id, { actorUserId: ctx.userId, request });
    return { rfq: await getRfq(ctx.supabase, ctx.accountId, ctx.params.id), send_results: results };
  }
  if (body.action === 'cancel') {
    const now = new Date().toISOString();
    await ctx.supabase.from('rfqs').update({ status: 'CANCELLED', closed_at: now }).eq('id', ctx.params.id).eq('account_id', ctx.accountId);
    await ctx.supabase.from('rfq_suppliers').update({ quote_token_revoked_at: now }).eq('rfq_id', ctx.params.id).eq('account_id', ctx.accountId);
    return { rfq: await getRfq(ctx.supabase, ctx.accountId, ctx.params.id) };
  }
  throw badRequest('Unknown action');
});
