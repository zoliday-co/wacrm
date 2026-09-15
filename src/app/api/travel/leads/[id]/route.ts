// GET   /api/travel/leads/[id] — the full lead detail payload
// PATCH /api/travel/leads/[id] — { assigned_agent_id } | { status, reason } | { next_action_text, next_action_at }

import { travelRoute, readJson } from '@/lib/travel/route';
import { getLeadDetail } from '@/lib/travel/lead-detail';
import { assignLead, setLeadStatus, getLead } from '@/lib/travel/leads';
import { badRequest } from '@/lib/travel/errors';
import { TRAVEL_LEAD_STATUSES, type TravelLeadStatus } from '@/types/travel';

export const GET = travelRoute('viewer', async (ctx) => {
  return getLeadDetail(ctx.supabase, ctx.accountId, ctx.params.id, ctx.userId);
});

export const PATCH = travelRoute('agent', async (ctx, request) => {
  const body = await readJson(request);
  const leadId = ctx.params.id;
  let lead = await getLead(ctx.supabase, ctx.accountId, leadId);

  if ('assigned_agent_id' in body) {
    const agent = body.assigned_agent_id;
    if (agent !== null && typeof agent !== 'string') throw badRequest('assigned_agent_id must be a user id or null');
    lead = await assignLead(ctx.supabase, ctx.accountId, leadId, (agent as string | null) ?? null, ctx.userId);
  }
  if (typeof body.status === 'string') {
    if (!(TRAVEL_LEAD_STATUSES as readonly string[]).includes(body.status)) throw badRequest('Unknown status');
    lead = await setLeadStatus(ctx.supabase, ctx.accountId, leadId, body.status as TravelLeadStatus, {
      actorType: 'agent',
      actorUserId: ctx.userId,
      reason: typeof body.reason === 'string' ? body.reason.slice(0, 500) : null,
    });
  }
  if ('next_action_text' in body || 'next_action_at' in body) {
    const patch: Record<string, unknown> = {};
    if ('next_action_text' in body) patch.next_action_text = typeof body.next_action_text === 'string' ? body.next_action_text.slice(0, 300) : null;
    if ('next_action_at' in body) patch.next_action_at = typeof body.next_action_at === 'string' && body.next_action_at ? new Date(body.next_action_at).toISOString() : null;
    const { data } = await ctx.supabase.from('travel_leads').update(patch).eq('id', leadId).eq('account_id', ctx.accountId).select('*').single();
    if (data) lead = data;
  }
  if (typeof body.traveller_name === 'string') {
    const { data } = await ctx.supabase.from('travel_leads').update({ traveller_name: body.traveller_name.trim().slice(0, 200) }).eq('id', leadId).eq('account_id', ctx.accountId).select('*').single();
    if (data) lead = data;
  }
  return { lead };
});
