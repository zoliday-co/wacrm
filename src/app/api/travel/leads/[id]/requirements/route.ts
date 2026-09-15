// GET  /api/travel/leads/[id]/requirements — all versions
// POST /api/travel/leads/[id]/requirements — { ...fields, reason, create_rfq?: boolean }
//   Appends a new requirement version; optionally spins up RFQ V(n+1) at once.

import { travelRoute, readJson } from '@/lib/travel/route';
import { listRequirementVersions, reviseRequirement, sanitizeRequirementInput } from '@/lib/travel/requirements';
import { createRfqForLead } from '@/lib/travel/rfq';
import { setLeadStatus } from '@/lib/travel/leads';

export const GET = travelRoute('viewer', async (ctx) => {
  return { versions: await listRequirementVersions(ctx.supabase, ctx.accountId, ctx.params.id) };
});

export const POST = travelRoute('agent', async (ctx, request) => {
  const body = await readJson(request);
  const patch = sanitizeRequirementInput(body);
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : null;
  const { version, lead } = await reviseRequirement(ctx.supabase, ctx.accountId, ctx.params.id, patch, { reason, actorUserId: ctx.userId });

  let rfq = null;
  if (body.create_rfq === true) {
    await setLeadStatus(ctx.supabase, ctx.accountId, lead.id, 'REQUOTE', { actorType: 'agent', actorUserId: ctx.userId, reason: 'Requirement revised' });
    const supplierIds = Array.isArray(body.supplier_ids) ? body.supplier_ids.filter((s): s is string => typeof s === 'string') : undefined;
    const result = await createRfqForLead(ctx.supabase, ctx.accountId, lead.id, { actorUserId: ctx.userId, request, supplierIds, send: body.send !== false });
    rfq = result.rfq;
  } else if (!['BOOKING_CONFIRMED', 'LOST'].includes(lead.status)) {
    await setLeadStatus(ctx.supabase, ctx.accountId, lead.id, 'REQUOTE', { actorType: 'agent', actorUserId: ctx.userId, reason: 'Requirement revised', nextAction: { text: `Send RFQ V${lead.current_requirement_version} for revised requirement` } });
  }
  return { version, lead, rfq };
});
