// PATCH /api/travel/supplier-quotes/[id] — { status: 'SHORTLISTED' | 'REJECTED' | 'SUBMITTED', internal_notes? }

import { travelRoute, readJson } from '@/lib/travel/route';
import { setSupplierQuoteStatus } from '@/lib/travel/supplier-quotes';
import { badRequest } from '@/lib/travel/errors';

export const PATCH = travelRoute('agent', async (ctx, request) => {
  const body = await readJson(request);
  const status = body.status;
  if (status !== 'SHORTLISTED' && status !== 'REJECTED' && status !== 'SUBMITTED') throw badRequest('status must be SHORTLISTED, REJECTED or SUBMITTED');
  const quote = await setSupplierQuoteStatus(ctx.supabase, ctx.accountId, ctx.params.id, status, {
    actorUserId: ctx.userId,
    internalNotes: typeof body.internal_notes === 'string' ? body.internal_notes.slice(0, 4000) : undefined,
  });
  return { quote };
});
