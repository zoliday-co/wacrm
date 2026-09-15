// ============================================================
// Traveller side of the automated phase:
//
//   quotes arrive → threshold / deadline → "quotes ready" WhatsApp
//   with a callback link → traveller picks a slot → callback
//   request + task + agent notification → human takes over.
//
// The public callback page talks ONLY to these functions via the
// opaque token (travel_access_tokens, kind='callback'); it never
// touches Supabase directly.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { CallbackRequest, CallbackWindow, Rfq, TravelLead } from '@/types/travel';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { LEAD_EVENT_TYPES } from './constants';
import { recordLeadEvent } from './events';
import { badRequest, notFound, TravelError } from './errors';
import { getTravelSettings } from './settings';
import { generateTravelToken, hashTravelToken, looksLikeTravelToken, tokenState } from './tokens';
import { callbackUrl } from './public-url';
import { quotesReadyTemplateParams, renderQuotesReadyMessage } from './rfq-message';
import { sendTravelWhatsApp } from './whatsapp';
import { getLead, setLeadStatus } from './leads';
import { notifyLeadOwners } from './notifications';
import { createTask } from './tasks';

// ------------------------------------------------------------
// Quotes-ready notification
// ------------------------------------------------------------

/**
 * Called after every supplier quote submission and on RFQ expiry.
 * Sends the traveller notification once per RFQ when either the
 * configured minimum is reached or the deadline has passed with
 * at least one quote. Idempotent via rfqs.traveller_notified_at.
 */
export async function maybeNotifyTravellerQuotesReady(
  db: SupabaseClient,
  accountId: string,
  rfqId: string,
  opts: { deadlineReached?: boolean; request?: Request | null } = {}
): Promise<boolean> {
  const { data: rfqRow } = await db.from('rfqs').select('*').eq('id', rfqId).eq('account_id', accountId).maybeSingle();
  if (!rfqRow) return false;
  const rfq = rfqRow as Rfq;
  if (rfq.traveller_notified_at) return false;

  const settings = await getTravelSettings(db, accountId);
  if (!settings.auto_notify_traveller) return false;

  const { count } = await db
    .from('supplier_quotes')
    .select('id', { count: 'exact', head: true })
    .eq('rfq_id', rfqId)
    .in('status', ['SUBMITTED', 'SHORTLISTED', 'SELECTED']);
  const received = count ?? 0;
  if (received === 0) return false;

  const thresholdMet = received >= settings.min_quotes_before_notification;
  const allResponded = rfq.recipient_count > 0 && received >= rfq.recipient_count;
  if (!thresholdMet && !allResponded && !opts.deadlineReached) return false;

  const result = await notifyTravellerQuotesReady(db, accountId, rfq.travel_lead_id, {
    rfqId,
    request: opts.request ?? null,
    actorUserId: null,
    reason: thresholdMet ? 'minimum quotes reached' : allResponded ? 'all suppliers responded' : 'deadline reached',
  });
  return result.ok;
}

export interface NotifyResult {
  ok: boolean;
  error?: string;
  callbackUrl?: string;
}

/**
 * Send the "quotes ready" message with a fresh callback link and
 * move the lead to QUOTES_AVAILABLE. On send failure the lead
 * STILL moves to QUOTES_AVAILABLE (the quotes exist) and a
 * `traveller_notify_failed` event + next-action tells the agent
 * to reach out manually / retry.
 */
export async function notifyTravellerQuotesReady(
  db: SupabaseClient,
  accountId: string,
  leadId: string,
  opts: { rfqId?: string | null; request?: Request | null; actorUserId: string | null; reason?: string | null }
): Promise<NotifyResult> {
  const lead = await getLead(db, accountId, leadId);
  const settings = await getTravelSettings(db, accountId);
  const admin = supabaseAdmin();

  // Fresh callback token (previous ones stay valid until expiry).
  const t = generateTravelToken('callback', settings.callback_token_ttl_hours);
  const { error: tokErr } = await admin.from('travel_access_tokens').insert({
    account_id: accountId,
    kind: 'callback',
    token_hash: t.hash,
    travel_lead_id: leadId,
    subject_id: opts.rfqId ?? null,
    expires_at: t.expiresAt,
  });
  if (tokErr) throw new Error(`Failed to mint callback token: ${tokErr.message}`);
  const url = callbackUrl(t.token, opts.request);

  await setLeadStatus(db, accountId, leadId, 'QUOTES_AVAILABLE', {
    actorType: opts.actorUserId ? 'agent' : 'system',
    actorUserId: opts.actorUserId,
    reason: opts.reason ?? null,
    nextAction: { text: 'Waiting for traveller to pick a call slot' },
  });

  let result: NotifyResult;
  if (!lead.conversation_id) {
    result = { ok: false, error: 'Lead has no WhatsApp conversation', callbackUrl: url };
  } else {
    const msgInput = { travellerName: lead.traveller_name, destination: lead.destination_primary, callbackUrl: url };
    const send = await sendTravelWhatsApp({
      db,
      accountId,
      conversationId: lead.conversation_id,
      text: renderQuotesReadyMessage(msgInput),
      template: settings.traveller_quotes_ready_template_name
        ? {
            name: settings.traveller_quotes_ready_template_name,
            language: settings.traveller_quotes_ready_template_language,
            params: quotesReadyTemplateParams(msgInput),
          }
        : null,
    });
    result = send.ok ? { ok: true, callbackUrl: url } : { ok: false, error: `${send.code}: ${send.error}`, callbackUrl: url };
  }

  if (opts.rfqId) {
    await db.from('rfqs').update({ traveller_notified_at: new Date().toISOString() }).eq('id', opts.rfqId);
  }

  if (result.ok) {
    await recordLeadEvent(db, {
      accountId,
      leadId,
      type: LEAD_EVENT_TYPES.TRAVELLER_NOTIFIED,
      actorType: opts.actorUserId ? 'agent' : 'system',
      actorUserId: opts.actorUserId,
      title: 'Traveller notified that packages are ready',
      details: { rfq_id: opts.rfqId ?? null, reason: opts.reason ?? null },
      trigger: {
        automation: 'minimum_supplier_quotes_received',
        webhook: 'travel.quotes.ready',
        contactId: lead.contact_id,
        conversationId: lead.conversation_id,
        payload: { rfq_id: opts.rfqId ?? null },
      },
    });
  } else {
    await recordLeadEvent(db, {
      accountId,
      leadId,
      type: LEAD_EVENT_TYPES.TRAVELLER_NOTIFY_FAILED,
      actorType: 'system',
      title: `Traveller notification failed — ${result.error}`,
      details: { rfq_id: opts.rfqId ?? null, error: result.error, callback_url_issued: true },
    });
    await db
      .from('travel_leads')
      .update({ next_action_text: 'Quotes ready but WhatsApp notification failed — contact traveller manually' })
      .eq('id', leadId);
    await notifyLeadOwners({
      accountId,
      assignedAgentId: lead.assigned_agent_id,
      type: 'travel_quotes_ready',
      title: `Quotes ready for ${lead.traveller_name ?? 'traveller'} — notification failed`,
      body: result.error,
      travelLeadId: leadId,
      conversationId: lead.conversation_id,
      contactId: lead.contact_id,
    });
  }
  console.log('[travel/notify] quotes-ready', { accountId, leadId, ok: result.ok });
  return result;
}

// ------------------------------------------------------------
// Public callback page
// ------------------------------------------------------------

export interface CallbackContext {
  lead: TravelLead;
  tokenId: string;
}

/** Validate a callback token and load its lead (service role). */
export async function resolveCallbackToken(token: string): Promise<CallbackContext> {
  if (!looksLikeTravelToken(token, 'callback')) throw new TravelError('invalid_token', 'This link is not valid', 404);
  const admin = supabaseAdmin();
  const { data: row } = await admin
    .from('travel_access_tokens')
    .select('*')
    .eq('token_hash', hashTravelToken(token))
    .eq('kind', 'callback')
    .maybeSingle();
  if (!row) throw new TravelError('invalid_token', 'This link is not valid', 404);
  const state = tokenState(row);
  if (state === 'revoked') throw new TravelError('revoked_token', 'This link is no longer active', 410);
  if (state === 'expired') throw new TravelError('expired_token', 'This link has expired', 410);
  const { data: lead } = await admin.from('travel_leads').select('*').eq('id', row.travel_lead_id).maybeSingle();
  if (!lead) throw notFound('Lead');
  await admin
    .from('travel_access_tokens')
    .update({ last_used_at: new Date().toISOString(), first_used_at: row.first_used_at ?? new Date().toISOString(), use_count: (row.use_count as number) + 1 })
    .eq('id', row.id);
  return { lead: lead as TravelLead, tokenId: row.id as string };
}

/** Traveller-safe view for the callback page (no internal ids beyond the lead's). */
export function callbackPublicView(lead: TravelLead) {
  return {
    traveller_first_name: (lead.traveller_name ?? '').split(/\s+/)[0] || null,
    destination: lead.destination_primary,
    nights: lead.nights,
    travel_month: lead.travel_month,
    status: lead.status,
    already_requested: lead.status === 'CALLBACK_REQUESTED',
  };
}

export interface CallbackInput {
  time_window: CallbackWindow;
  preferred_date?: string | null;
  preferred_time?: string | null;
  note?: string | null;
}

export function parseCallbackInput(raw: unknown): CallbackInput {
  if (typeof raw !== 'object' || raw === null) throw badRequest('Invalid request');
  const src = raw as Record<string, unknown>;
  const windows: CallbackWindow[] = ['NOW', 'MORNING', 'AFTERNOON', 'EVENING', 'SPECIFIC'];
  const tw = src.time_window;
  if (typeof tw !== 'string' || !windows.includes(tw as CallbackWindow)) throw badRequest('Choose a time');
  const date = typeof src.preferred_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(src.preferred_date) ? src.preferred_date : null;
  const time = typeof src.preferred_time === 'string' && /^\d{2}:\d{2}$/.test(src.preferred_time) ? src.preferred_time : null;
  if (tw === 'SPECIFIC' && (!date || !time)) throw badRequest('Pick a date and time');
  if (tw !== 'NOW' && tw !== 'SPECIFIC' && !date) throw badRequest('Pick a date');
  const note = typeof src.note === 'string' ? src.note.trim().slice(0, 500) : null;
  return { time_window: tw as CallbackWindow, preferred_date: date, preferred_time: time, note };
}

/** Compute a concrete scheduled_at from the traveller's choice (IST-local). */
export function scheduledAtFor(input: CallbackInput, now = new Date()): string {
  if (input.time_window === 'NOW') return now.toISOString();
  const date = input.preferred_date ?? now.toISOString().slice(0, 10);
  const time =
    input.time_window === 'SPECIFIC'
      ? input.preferred_time!
      : input.time_window === 'MORNING'
        ? '10:00'
        : input.time_window === 'AFTERNOON'
          ? '14:00'
          : '18:00';
  // Traveller times are Indian local time (domestic product).
  return new Date(`${date}T${time}:00+05:30`).toISOString();
}

/** Traveller submitted a slot: create request + task, move lead, notify agents. */
export async function createCallbackRequest(token: string, raw: unknown, request?: Request | null): Promise<CallbackRequest> {
  const { lead } = await resolveCallbackToken(token);
  const input = parseCallbackInput(raw);
  const admin = supabaseAdmin();
  const scheduledAt = scheduledAtFor(input);

  const { data: cb, error } = await admin
    .from('callback_requests')
    .insert({
      account_id: lead.account_id,
      travel_lead_id: lead.id,
      preferred_date: input.preferred_date,
      preferred_time: input.preferred_time,
      time_window: input.time_window,
      scheduled_at: scheduledAt,
      traveller_note: input.note,
      status: input.time_window === 'NOW' ? 'REQUESTED' : 'SCHEDULED',
      assigned_agent_id: lead.assigned_agent_id,
    })
    .select('*')
    .single();
  if (error || !cb) throw new Error(`Failed to create callback request: ${error?.message}`);
  const callback = cb as CallbackRequest;

  const when = describeCallback(callback);
  const task = await createTask(admin, lead.account_id, {
    travelLeadId: lead.id,
    title: `Call ${lead.traveller_name ?? 'traveller'} — ${when}`,
    description: input.note ?? null,
    taskType: 'CALLBACK',
    assignedTo: lead.assigned_agent_id,
    priority: input.time_window === 'NOW' ? 'URGENT' : 'HIGH',
    dueAt: scheduledAt,
    sourceKey: `callback:${callback.id}`,
    logEvent: false,
  });
  await admin.from('callback_requests').update({ task_id: task.id }).eq('id', callback.id);

  await setLeadStatus(admin, lead.account_id, lead.id, 'CALLBACK_REQUESTED', {
    actorType: 'traveller',
    nextAction: { text: `📞 Call ${when}`, at: scheduledAt },
  });

  await recordLeadEvent(admin, {
    accountId: lead.account_id,
    leadId: lead.id,
    type: LEAD_EVENT_TYPES.CALLBACK_REQUESTED,
    actorType: 'traveller',
    title: `Traveller requested call ${when}`,
    details: { callback_id: callback.id, time_window: input.time_window, scheduled_at: scheduledAt, note: input.note },
    trigger: {
      automation: 'traveller_callback_requested',
      webhook: 'travel.callback.requested',
      contactId: lead.contact_id,
      conversationId: lead.conversation_id,
      payload: { scheduled_at: scheduledAt, time_window: input.time_window },
    },
  });

  await notifyLeadOwners({
    accountId: lead.account_id,
    assignedAgentId: lead.assigned_agent_id,
    type: 'travel_callback_requested',
    title: `${lead.traveller_name ?? 'Traveller'} wants a call ${when}`,
    body: `${lead.destination_primary ?? ''}${input.note ? ` — "${input.note}"` : ''}`,
    travelLeadId: lead.id,
    conversationId: lead.conversation_id,
    contactId: lead.contact_id,
  });

  // Best-effort confirmation to the traveller (inside the 24h window
  // since they just interacted with the link — not guaranteed).
  if (lead.conversation_id && request !== undefined) {
    const settings = await getTravelSettings(admin, lead.account_id);
    if (settings.auto_notify_traveller) {
      await sendTravelWhatsApp({
        db: admin,
        accountId: lead.account_id,
        conversationId: lead.conversation_id,
        text:
          input.time_window === 'NOW'
            ? 'Thanks! Your Oliday travel expert will call you shortly.'
            : `Thanks! Your Oliday travel expert will call you ${when}.`,
      });
    }
  }

  console.log('[travel/callback] requested', { leadId: lead.id, callbackId: callback.id, window: input.time_window });
  return callback;
}

export function describeCallback(cb: Pick<CallbackRequest, 'time_window' | 'preferred_date' | 'preferred_time' | 'scheduled_at'>): string {
  if (cb.time_window === 'NOW') return 'now';
  const d = cb.scheduled_at ? new Date(cb.scheduled_at) : null;
  const dayLabel = d
    ? d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })
    : cb.preferred_date ?? '';
  if (cb.time_window === 'SPECIFIC' && cb.preferred_time) {
    const [h, m] = cb.preferred_time.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const hh = h % 12 || 12;
    return `${dayLabel} at ${hh}:${String(m).padStart(2, '0')} ${ampm}`;
  }
  const win = cb.time_window === 'MORNING' ? 'morning' : cb.time_window === 'AFTERNOON' ? 'afternoon' : 'evening';
  return `${dayLabel} (${win})`;
}

export async function completeCallback(
  db: SupabaseClient,
  accountId: string,
  callbackId: string,
  status: 'COMPLETED' | 'MISSED' | 'CANCELLED',
  actorUserId: string | null
): Promise<CallbackRequest> {
  const { data: cb } = await db.from('callback_requests').select('*').eq('id', callbackId).eq('account_id', accountId).maybeSingle();
  if (!cb) throw notFound('Callback request');
  const { data, error } = await db
    .from('callback_requests')
    .update({ status, completed_at: status === 'COMPLETED' ? new Date().toISOString() : null })
    .eq('id', callbackId)
    .select('*')
    .single();
  if (error || !data) throw new Error(`Failed to update callback: ${error?.message}`);
  if ((cb as CallbackRequest).task_id) {
    await db
      .from('travel_tasks')
      .update({ status: status === 'COMPLETED' ? 'DONE' : 'CANCELLED', completed_at: status === 'COMPLETED' ? new Date().toISOString() : null })
      .eq('id', (cb as CallbackRequest).task_id);
  }
  if (status === 'COMPLETED') {
    await recordLeadEvent(db, {
      accountId,
      leadId: (cb as CallbackRequest).travel_lead_id,
      type: LEAD_EVENT_TYPES.CALLBACK_COMPLETED,
      actorType: 'agent',
      actorUserId,
      title: 'Callback completed',
      details: { callback_id: callbackId },
    });
  }
  return data as CallbackRequest;
}
