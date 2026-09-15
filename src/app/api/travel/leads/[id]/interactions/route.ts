// GET  /api/travel/leads/[id]/interactions
// POST /api/travel/leads/[id]/interactions — call log / note / meeting (+ optional next_follow_up_at, set_status)

import { travelRoute, readJson } from '@/lib/travel/route';
import { createInteraction, listInteractions, parseInteractionInput } from '@/lib/travel/interactions';

export const GET = travelRoute('viewer', async (ctx) => {
  return { interactions: await listInteractions(ctx.supabase, ctx.accountId, ctx.params.id) };
});

export const POST = travelRoute('agent', async (ctx, request) => {
  const input = parseInteractionInput(await readJson(request));
  const interaction = await createInteraction(ctx.supabase, ctx.accountId, ctx.params.id, input, ctx.userId);
  return { interaction };
});
