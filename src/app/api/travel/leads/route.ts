// GET  /api/travel/leads — list (filters: status, assigned, q, destination, limit, offset)
// POST /api/travel/leads — agent creates a lead by hand (no bot)

import { travelRoute, readJson, query } from '@/lib/travel/route';
import { listLeads, ingestQualifiedLead } from '@/lib/travel/leads';
import { parseQualifiedLeadPayload } from '@/lib/travel/qualified-payload';
import { createRfqForLead } from '@/lib/travel/rfq';
import { badRequest } from '@/lib/travel/errors';
import type { TravelLeadStatus } from '@/types/travel';

export const GET = travelRoute('viewer', async (ctx, request) => {
  const q = query(request);
  const result = await listLeads(
    ctx.supabase,
    ctx.accountId,
    {
      status: (q.get('status') as TravelLeadStatus | 'open' | 'all' | null) ?? 'open',
      assigned: q.get('assigned'),
      q: q.get('q'),
      destination: q.get('destination'),
      limit: Number(q.get('limit') ?? 50),
      offset: Number(q.get('offset') ?? 0),
    },
    ctx.userId
  );
  return result;
});

export const POST = travelRoute('agent', async (ctx, request) => {
  const body = await readJson(request);
  const parsed = parseQualifiedLeadPayload({
    bot_session_id: `manual:${crypto.randomUUID()}`,
    ...body,
    source: { type: 'manual', ...((body.source as Record<string, unknown>) ?? {}) },
  });
  if (!parsed.ok) throw badRequest(parsed.error);
  const { lead } = await ingestQualifiedLead(ctx.supabase, ctx.accountId, parsed.value, { actorUserId: ctx.userId, actorType: 'agent' });
  if (body.send_rfq === true) {
    try {
      await createRfqForLead(ctx.supabase, ctx.accountId, lead.id, { actorUserId: ctx.userId, request });
    } catch (err) {
      console.error('[travel/leads] manual RFQ failed:', err instanceof Error ? err.message : err);
    }
  }
  return { lead };
});
