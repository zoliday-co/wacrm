// ============================================================
// Human interactions: call logs, notes, meetings. Each write is
// also a timeline event, and a `next_follow_up_at` schedules a
// follow-up task so negotiation context is never lost.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { InteractionType, LeadInteraction } from '@/types/travel';
import { LEAD_EVENT_TYPES } from './constants';
import { recordLeadEvent } from './events';
import { badRequest } from './errors';
import { getLead, setLeadStatus } from './leads';
import { scheduleFollowUp } from './tasks';

export interface InteractionInput {
  interaction_type: InteractionType;
  summary: string;
  details?: string | null;
  outcome?: string | null;
  duration_seconds?: number | null;
  occurred_at?: string | null;
  next_follow_up_at?: string | null;
  /** Move the lead to this status after logging (e.g. HUMAN_FOLLOWUP / LOST). */
  set_status?: string | null;
}

const TYPES: InteractionType[] = ['CALL', 'NOTE', 'FOLLOW_UP', 'MEETING', 'SYSTEM'];

export function parseInteractionInput(raw: unknown): InteractionInput {
  if (typeof raw !== 'object' || raw === null) throw badRequest('Invalid interaction');
  const s = raw as Record<string, unknown>;
  const type = TYPES.includes(s.interaction_type as InteractionType) ? (s.interaction_type as InteractionType) : 'NOTE';
  const summary = typeof s.summary === 'string' ? s.summary.trim().slice(0, 500) : '';
  if (!summary) throw badRequest('Summary is required');
  const text = (v: unknown, max = 8000) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const iso = (v: unknown) => {
    if (typeof v !== 'string' || !v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  return {
    interaction_type: type === 'SYSTEM' ? 'NOTE' : type,
    summary,
    details: text(s.details),
    outcome: text(s.outcome, 500),
    duration_seconds: typeof s.duration_seconds === 'number' && s.duration_seconds >= 0 ? Math.round(s.duration_seconds) : null,
    occurred_at: iso(s.occurred_at),
    next_follow_up_at: iso(s.next_follow_up_at),
    set_status: typeof s.set_status === 'string' ? s.set_status : null,
  };
}

export async function createInteraction(
  db: SupabaseClient,
  accountId: string,
  leadId: string,
  input: InteractionInput,
  actorUserId: string | null
): Promise<LeadInteraction> {
  const lead = await getLead(db, accountId, leadId);
  const { data, error } = await db
    .from('lead_interactions')
    .insert({
      account_id: accountId,
      travel_lead_id: leadId,
      interaction_type: input.interaction_type,
      agent_id: actorUserId,
      summary: input.summary,
      details: input.details ?? null,
      outcome: input.outcome ?? null,
      duration_seconds: input.duration_seconds ?? null,
      occurred_at: input.occurred_at ?? new Date().toISOString(),
      next_follow_up_at: input.next_follow_up_at ?? null,
    })
    .select('*')
    .single();
  if (error || !data) throw new Error(`Failed to save interaction: ${error?.message}`);
  const row = data as LeadInteraction;

  await recordLeadEvent(db, {
    accountId,
    leadId,
    type: input.interaction_type === 'CALL' ? LEAD_EVENT_TYPES.CUSTOMER_CALLED : LEAD_EVENT_TYPES.NOTE_ADDED,
    actorType: 'agent',
    actorUserId,
    title: input.interaction_type === 'CALL' ? `Called traveller — ${input.summary}` : `${labelFor(input.interaction_type)}: ${input.summary}`,
    details: { interaction_id: row.id, outcome: input.outcome ?? null, next_follow_up_at: input.next_follow_up_at ?? null },
  });

  if (input.next_follow_up_at) {
    await scheduleFollowUp(db, accountId, leadId, {
      dueAt: input.next_follow_up_at,
      title: `Follow up: ${input.summary}`.slice(0, 200),
      note: input.details ?? null,
      assignedTo: lead.assigned_agent_id ?? actorUserId,
      actorUserId,
    });
  }

  // A logged call during the automated phase means a human has taken
  // over — reflect that on the pipeline unless the caller chose a status.
  const nextStatus = input.set_status && isStatus(input.set_status) ? input.set_status : null;
  if (nextStatus) {
    await setLeadStatus(db, accountId, leadId, nextStatus, { actorType: 'agent', actorUserId, reason: input.outcome ?? null });
  } else if (input.interaction_type === 'CALL' && ['QUOTES_AVAILABLE', 'CALLBACK_REQUESTED', 'RFQ_SENT', 'AWAITING_SUPPLIER_QUOTES', 'QUALIFIED'].includes(lead.status)) {
    await setLeadStatus(db, accountId, leadId, 'HUMAN_FOLLOWUP', { actorType: 'agent', actorUserId });
    await db.from('callback_requests').update({ status: 'COMPLETED', completed_at: new Date().toISOString() }).eq('travel_lead_id', leadId).in('status', ['REQUESTED', 'SCHEDULED']);
    await db.from('travel_tasks').update({ status: 'DONE', completed_at: new Date().toISOString() }).eq('travel_lead_id', leadId).eq('task_type', 'CALLBACK').in('status', ['OPEN', 'IN_PROGRESS']);
  }
  return row;
}

export async function listInteractions(db: SupabaseClient, accountId: string, leadId: string): Promise<LeadInteraction[]> {
  const { data } = await db
    .from('lead_interactions')
    .select('*, agent:profiles!lead_interactions_agent_id_fkey(user_id, full_name)')
    .eq('account_id', accountId)
    .eq('travel_lead_id', leadId)
    .order('occurred_at', { ascending: false });
  if (data) return data as LeadInteraction[];
  const { data: plain } = await db.from('lead_interactions').select('*').eq('account_id', accountId).eq('travel_lead_id', leadId).order('occurred_at', { ascending: false });
  return (plain ?? []) as LeadInteraction[];
}

function labelFor(t: InteractionType): string {
  return t === 'NOTE' ? 'Note' : t === 'MEETING' ? 'Meeting' : t === 'FOLLOW_UP' ? 'Follow-up' : 'Call';
}

const STATUSES = new Set(['BOT_QUALIFYING', 'QUALIFIED', 'RFQ_SENT', 'AWAITING_SUPPLIER_QUOTES', 'QUOTES_AVAILABLE', 'CALLBACK_REQUESTED', 'HUMAN_FOLLOWUP', 'REQUOTE', 'NEGOTIATION', 'BOOKING_CONFIRMED', 'LOST']);
function isStatus(v: string): v is import('@/types/travel').TravelLeadStatus {
  return STATUSES.has(v);
}
