import { travelRoute, readJson } from '@/lib/travel/route';
import { completeCallback } from '@/lib/travel/callbacks';
import { badRequest } from '@/lib/travel/errors';

export const PATCH = travelRoute('agent', async (ctx, request) => {
  const body = await readJson(request);
  if (body.status !== 'COMPLETED' && body.status !== 'MISSED' && body.status !== 'CANCELLED') throw badRequest('Unknown callback status');
  return { callback: await completeCallback(ctx.supabase, ctx.accountId, ctx.params.id, body.status, ctx.userId) };
});
