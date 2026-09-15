// ============================================================
// Travel lead lifecycle: ingestion (bot → contact → deal → lead),
// status transitions (lead ↔ deal stage kept in sync), and
// assignment. Supplier matching / RFQ creation lives in rfq.ts
// and is invoked by the route after ingestion so this module
// stays free of send-side concerns.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Deal, PipelineStage } from '@/types';
import type { TravelLead, TravelLeadStatus } from '@/types/travel';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { isUniqueViolation } from '@/lib/contacts/dedupe';
import { LEAD_EVENT_TYPES, LEAD_STATUS_LABEL } from './constants';
import { recordLeadEvent } from './events';
import { badRequest, notFound } from './errors';
import { ensureTravelPipeline, dealStatusForLead, stageIdForStatus } from './pipeline';
import { getTravelSettings } from './settings';
import { insertRequirementVersion, pickRequirement } from './requirements';
import type { QualifiedLeadPayload } from './qualified-payload';
import { notifyUser } from './notifications';
import { durationLabel } from './format';
import { toMinor, fromMinor } from './money';

export interface IngestResult {
  lead: TravelLead;
  created: boolean;
  contactCreated: boolean;
}

/**
 * Idempotent ingestion. A repeated `bot_session_id` returns the
 * existing lead with `created: false` and writes nothing.
 */
export async function ingestQualifiedLead(
  db: SupabaseClient,
  accountId: string,
  payload: QualifiedLeadPayload,
  opts: { actorUserId?: string | null; actorType?: 'bot' | 'agent' } = {}
): Promise<IngestResult> {
  const actorType = opts.actorType ?? 'bot';

  // ---- 0. idempotency ------------------------------------------
  if (payload.bot_session_id) {
    const { data: existing } = await db
      .from('travel_leads')
      .select('*')
      .eq('account_id', accountId)
      .eq('bot_session_id', payload.bot_session_id)
      .maybeSingle();
    if (existing) {
      console.log('[travel/ingest] duplicate bot_session_id, returning existing lead', {
        accountId,
        leadId: existing.id,
      });
      return { lead: existing as TravelLead, created: false, contactCreated: false };
    }
  }

  // ---- 1–3. phone → contact → conversation ----------------------
  // Same helper the public API uses: normalises the phone, dedupes
  // the contact, finds the single conversation per contact.
  const resolved = await resolveConversationByPhone(
    db,
    accountId,
    payload.traveller.phone,
    payload.traveller.name
  );
  const auditUserId = opts.actorUserId ?? (await resolveAuditUserId(db, accountId));
  const settings = await getTravelSettings(db, accountId);

  // ---- 4. deal in the Oliday pipeline ---------------------------
  const { pipelineId, stages } = await ensureTravelPipeline(db, accountId, auditUserId);
  const stageId = stageIdForStatus(stages, 'QUALIFIED') ?? stages[0]?.id;
  if (!stageId) throw new Error('Travel pipeline has no stages');

  const trip = payload.trip;
  const title = dealTitle(payload.traveller.name, trip.destination_primary, trip.nights ?? null);
  const { data: deal, error: dealErr } = await db
    .from('deals')
    .insert({
      account_id: accountId,
      user_id: auditUserId,
      pipeline_id: pipelineId,
      stage_id: stageId,
      contact_id: resolved.contactId,
      conversation_id: resolved.conversationId,
      title,
      value: trip.budget_amount ? fromMinor(toMinor(trip.budget_amount)) : 0,
      currency: settings.currency,
      status: 'open',
      notes: trip.qualification_summary ?? null,
    })
    .select('id')
    .single();
  if (dealErr || !deal) throw new Error(`Failed to create deal: ${dealErr?.message ?? 'unknown'}`);

  // ---- 5–7. travel lead (status QUALIFIED) ----------------------
  const leadRow = {
    account_id: accountId,
    deal_id: deal.id,
    contact_id: resolved.contactId,
    conversation_id: payload.conversation_id ?? resolved.conversationId,
    bot_session_id: payload.bot_session_id || null,
    source_type: payload.source.type,
    campaign_id: payload.source.campaign_id,
    campaign_name: payload.source.campaign_name,
    adset_id: payload.source.adset_id,
    ad_id: payload.source.ad_id,
    ad_name: payload.source.ad_name,
    referral_data: payload.source.referral_data,
    traveller_name: payload.traveller.name,
    ...pickRequirement(trip as Record<string, unknown>),
    qualification_summary: trip.qualification_summary ?? null,
    status: 'QUALIFIED' as TravelLeadStatus,
    current_requirement_version: 1,
    created_by: opts.actorUserId ?? null,
    next_action_text: 'Match suppliers and send RFQ',
  };

  const { data: inserted, error: leadErr } = await db
    .from('travel_leads')
    .insert(leadRow)
    .select('*')
    .single();

  if (leadErr || !inserted) {
    if (isUniqueViolation(leadErr) && payload.bot_session_id) {
      // Concurrent duplicate webhook won the race: drop our deal and
      // hand back the winner.
      await db.from('deals').delete().eq('id', deal.id);
      const { data: winner } = await db
        .from('travel_leads')
        .select('*')
        .eq('account_id', accountId)
        .eq('bot_session_id', payload.bot_session_id)
        .maybeSingle();
      if (winner) return { lead: winner as TravelLead, created: false, contactCreated: false };
    }
    throw new Error(`Failed to create travel lead: ${leadErr?.message ?? 'unknown'}`);
  }
  let lead = inserted as TravelLead;

  const version = await insertRequirementVersion(db, accountId, lead.id, 1, trip, {
    change_reason: 'Qualified by WhatsApp bot',
    created_by: opts.actorUserId ?? null,
  });
  const { data: withVersion } = await db
    .from('travel_leads')
    .update({ current_requirement_version_id: version.id })
    .eq('id', lead.id)
    .select('*')
    .single();
  if (withVersion) lead = withVersion as TravelLead;

  // Back-reference from the conversation so the inbox can jump here.
  await db
    .from('conversations')
    .update({ travel_lead_id: lead.id })
    .eq('id', lead.conversation_id ?? resolved.conversationId)
    .eq('account_id', accountId);

  // ---- 8. timeline ----------------------------------------------
  await recordLeadEvent(db, {
    accountId,
    leadId: lead.id,
    type: LEAD_EVENT_TYPES.LEAD_CREATED,
    actorType,
    actorUserId: opts.actorUserId ?? null,
    title:
      payload.source.type === 'meta_whatsapp_ad'
        ? `Traveller entered through Meta campaign${payload.source.campaign_name ? ` "${payload.source.campaign_name}"` : ''}`
        : `Lead created (${payload.source.type})`,
    details: {
      source: payload.source,
      contact_created: resolved.contactCreated,
      conversation_id: lead.conversation_id,
    },
  });
  await recordLeadEvent(db, {
    accountId,
    leadId: lead.id,
    type: LEAD_EVENT_TYPES.LEAD_QUALIFIED,
    actorType,
    actorUserId: opts.actorUserId ?? null,
    title: actorType === 'bot' ? 'Lead qualified by WhatsApp bot' : 'Lead qualified',
    details: { bot_session_id: payload.bot_session_id, summary: trip.qualification_summary },
    trigger: {
      automation: 'travel_lead_qualified',
      webhook: 'travel.lead.qualified',
      contactId: resolved.contactId,
      conversationId: lead.conversation_id,
      payload: { destination: trip.destination_primary, nights: trip.nights ?? null },
    },
  });

  console.log('[travel/ingest] lead created', {
    accountId,
    leadId: lead.id,
    dealId: deal.id,
    contactId: resolved.contactId,
    destination: trip.destination_primary,
  });

  return { lead, created: true, contactCreated: resolved.contactCreated };
}

function dealTitle(name: string | null, destination: string, nights: number | null): string {
  const who = name?.trim() || 'Traveller';
  const dur = nights != null ? ` ${durationLabel({ nights, days: nights + 1 })}` : '';
  return `${who} — ${destination}${dur}`;
}

// ------------------------------------------------------------
// Status transitions
// ------------------------------------------------------------

export interface StatusChangeOpts {
  actorUserId?: string | null;
  actorType?: 'system' | 'agent' | 'bot' | 'traveller' | 'supplier';
  reason?: string | null;
  nextAction?: { text: string | null; at?: string | null } | null;
  /** Skip the event when the status is unchanged (default true). */
  quietIfSame?: boolean;
}

export async function setLeadStatus(
  db: SupabaseClient,
  accountId: string,
  leadId: string,
  status: TravelLeadStatus,
  opts: StatusChangeOpts = {}
): Promise<TravelLead> {
  const { data: current } = await db
    .from('travel_leads')
    .select('*')
    .eq('id', leadId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (!current) throw notFound('Lead');
  const lead = current as TravelLead;

  if (lead.status === status && (opts.quietIfSame ?? true) && !opts.nextAction) return lead;

  const patch: Record<string, unknown> = { status };
  if (status === 'LOST') {
    patch.lost_reason = opts.reason ?? null;
    patch.closed_at = new Date().toISOString();
  }
  if (status === 'BOOKING_CONFIRMED') patch.closed_at = new Date().toISOString();
  if (opts.nextAction !== undefined) {
    patch.next_action_text = opts.nextAction?.text ?? null;
    patch.next_action_at = opts.nextAction?.at ?? null;
  }

  const { data: updated, error } = await db
    .from('travel_leads')
    .update(patch)
    .eq('id', leadId)
    .eq('account_id', accountId)
    .select('*')
    .single();
  if (error || !updated) throw new Error(`Failed to update lead status: ${error?.message}`);

  await syncDealStage(db, accountId, lead.deal_id, status);

  if (lead.status !== status) {
    await recordLeadEvent(db, {
      accountId,
      leadId,
      type: LEAD_EVENT_TYPES.STATUS_CHANGED,
      actorType: opts.actorType ?? 'system',
      actorUserId: opts.actorUserId ?? null,
      title: `Stage → ${LEAD_STATUS_LABEL[status]}${opts.reason ? ` (${opts.reason})` : ''}`,
      details: { reason: opts.reason ?? null },
      oldValue: lead.status,
      newValue: status,
    });
  }
  return updated as TravelLead;
}

async function syncDealStage(
  db: SupabaseClient,
  accountId: string,
  dealId: string | null,
  status: TravelLeadStatus
): Promise<void> {
  if (!dealId) return;
  const settings = await getTravelSettings(db, accountId);
  if (!settings.pipeline_id) return;
  const { data: stages } = await db
    .from('pipeline_stages')
    .select('*')
    .eq('pipeline_id', settings.pipeline_id);
  const stageId = stageIdForStatus((stages ?? []) as PipelineStage[], status);
  const patch: Partial<Deal> & Record<string, unknown> = { status: dealStatusForLead(status) };
  if (stageId) patch.stage_id = stageId;
  const { error } = await db.from('deals').update(patch).eq('id', dealId).eq('account_id', accountId);
  if (error) console.error('[travel/leads] deal stage sync failed:', error.message);
}

// ------------------------------------------------------------
// Assignment
// ------------------------------------------------------------

export async function assignLead(
  db: SupabaseClient,
  accountId: string,
  leadId: string,
  agentUserId: string | null,
  actorUserId: string | null
): Promise<TravelLead> {
  const { data: current } = await db
    .from('travel_leads')
    .select('*')
    .eq('id', leadId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (!current) throw notFound('Lead');
  const lead = current as TravelLead;

  let agentName: string | null = null;
  let profileId: string | null = null;
  if (agentUserId) {
    const { data: profile } = await db
      .from('profiles')
      .select('id, full_name, account_id')
      .eq('user_id', agentUserId)
      .maybeSingle();
    if (!profile || profile.account_id !== accountId) throw badRequest('Agent is not a member of this account');
    agentName = profile.full_name as string;
    profileId = profile.id as string;
  }

  const { data: updated, error } = await db
    .from('travel_leads')
    .update({ assigned_agent_id: agentUserId, assigned_at: agentUserId ? new Date().toISOString() : null })
    .eq('id', leadId)
    .eq('account_id', accountId)
    .select('*')
    .single();
  if (error || !updated) throw new Error(`Failed to assign lead: ${error?.message}`);

  if (lead.deal_id) {
    await db.from('deals').update({ assigned_to: profileId }).eq('id', lead.deal_id).eq('account_id', accountId);
  }
  // Keep open tasks / callbacks with the lead.
  if (agentUserId) {
    await db
      .from('travel_tasks')
      .update({ assigned_to: agentUserId })
      .eq('travel_lead_id', leadId)
      .in('status', ['OPEN', 'IN_PROGRESS'])
      .is('assigned_to', null);
    await db
      .from('callback_requests')
      .update({ assigned_agent_id: agentUserId })
      .eq('travel_lead_id', leadId)
      .in('status', ['REQUESTED', 'SCHEDULED'])
      .is('assigned_agent_id', null);
  }

  await recordLeadEvent(db, {
    accountId,
    leadId,
    type: LEAD_EVENT_TYPES.LEAD_ASSIGNED,
    actorType: actorUserId ? 'agent' : 'system',
    actorUserId,
    title: agentUserId ? `Assigned to ${agentName}` : 'Unassigned',
    oldValue: lead.assigned_agent_id,
    newValue: agentUserId,
  });

  if (agentUserId && agentUserId !== actorUserId) {
    await notifyUser({
      accountId,
      userId: agentUserId,
      type: 'travel_lead_assigned',
      title: `Lead assigned: ${lead.traveller_name ?? 'Traveller'} — ${lead.destination_primary ?? ''}`,
      body: lead.next_action_text,
      travelLeadId: leadId,
      conversationId: lead.conversation_id,
      contactId: lead.contact_id,
      actorUserId,
    });
  }

  return updated as TravelLead;
}

// ------------------------------------------------------------
// Reads
// ------------------------------------------------------------

export interface LeadListFilters {
  status?: TravelLeadStatus | 'open' | 'all';
  assigned?: string | 'me' | 'unassigned' | null;
  q?: string | null;
  destination?: string | null;
  limit?: number;
  offset?: number;
}

export async function listLeads(
  db: SupabaseClient,
  accountId: string,
  f: LeadListFilters,
  currentUserId: string
): Promise<{ leads: TravelLead[]; total: number }> {
  let q = db
    .from('travel_leads')
    .select('*, contact:contacts(id, name, phone), assigned_agent:profiles!travel_leads_assigned_agent_id_fkey(user_id, full_name, avatar_url)', { count: 'exact' })
    .eq('account_id', accountId)
    .order('last_activity_at', { ascending: false });

  if (f.status && f.status !== 'all') {
    if (f.status === 'open') q = q.not('status', 'in', '("BOOKING_CONFIRMED","LOST")');
    else q = q.eq('status', f.status);
  }
  if (f.assigned === 'me') q = q.eq('assigned_agent_id', currentUserId);
  else if (f.assigned === 'unassigned') q = q.is('assigned_agent_id', null);
  else if (f.assigned) q = q.eq('assigned_agent_id', f.assigned);
  if (f.destination) q = q.ilike('destination_primary', `%${f.destination}%`);
  if (f.q) q = q.or(`traveller_name.ilike.%${f.q}%,destination_primary.ilike.%${f.q}%,campaign_name.ilike.%${f.q}%`);

  const limit = Math.min(200, Math.max(1, f.limit ?? 50));
  const offset = Math.max(0, f.offset ?? 0);
  q = q.range(offset, offset + limit - 1);

  const { data, count, error } = await q;
  if (error) {
    // The profiles embed depends on PostgREST's schema cache; fall
    // back to a plain select if the relationship isn't visible yet.
    console.warn('[travel/leads] list embed failed, retrying plain:', error.message);
    const { data: plain, count: c2 } = await db
      .from('travel_leads')
      .select('*', { count: 'exact' })
      .eq('account_id', accountId)
      .order('last_activity_at', { ascending: false })
      .range(offset, offset + limit - 1);
    return { leads: (plain ?? []) as TravelLead[], total: c2 ?? 0 };
  }
  return { leads: (data ?? []) as TravelLead[], total: count ?? 0 };
}

export async function getLead(db: SupabaseClient, accountId: string, leadId: string): Promise<TravelLead> {
  const { data } = await db
    .from('travel_leads')
    .select('*')
    .eq('id', leadId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (!data) throw notFound('Lead');
  return data as TravelLead;
}
