// POST /api/travel/traveller-quotes/[id] — { action: 'send' | 'accept' | 'reject' | 'approve' | 'decline_approval', reason? }

import { travelRoute, readJson } from '@/lib/travel/route';
import { acceptTravellerQuote, approveTravellerQuote, rejectTravellerQuote, sendTravellerQuote } from '@/lib/travel/traveller-quotes';
import { badRequest } from '@/lib/travel/errors';
import { hasMinRole } from '@/lib/auth/roles';
import { ForbiddenError } from '@/lib/auth/account';

export const POST = travelRoute('agent', async (ctx, request) => {
  const body = await readJson(request);
  const id = ctx.params.id;
  switch (body.action) {
    case 'send':
      return sendTravellerQuote(ctx.supabase, ctx.accountId, id, { actorUserId: ctx.userId, request });
    case 'accept':
      return acceptTravellerQuote(ctx.supabase, ctx.accountId, id, { actorUserId: ctx.userId, actorType: 'agent' });
    case 'reject':
      return { quote: await rejectTravellerQuote(ctx.supabase, ctx.accountId, id, { actorUserId: ctx.userId, actorType: 'agent', reason: typeof body.reason === 'string' ? body.reason.slice(0, 500) : null }) };
    case 'approve':
    case 'decline_approval':
      if (!hasMinRole(ctx.role, 'admin')) throw new ForbiddenError('Only admins can approve low-margin quotes');
      return { quote: await approveTravellerQuote(ctx.supabase, ctx.accountId, id, body.action === 'approve', ctx.userId) };
    default:
      throw badRequest('Unknown action');
  }
});
