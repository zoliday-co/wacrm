// ============================================================
// RFQ engine: create an RFQ from the lead's CURRENT requirement
// version, pick recipients (auto-matched or agent-chosen), mint
// one opaque quote token per recipient, send the WhatsApp RFQ,
// and keep RFQ status / counts in step. Also: reminders + expiry
// (driven by the cron).
//
// Send failures never lose data: the recipient row keeps
// `send_error` + `send_attempts`, the timeline gets an
// `rfq_send_failed` event, and the agent can retry from the UI.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Rfq, RfqSupplier, Supplier, TravelLead } from '@/types/travel';
import { LEAD_EVENT_TYPES } from './constants';
import { recordLeadEvent } from './events';
import { badRequest, notFound } from './errors';
import { getTravelSettings } from './settings';
import { matchSuppliersForLead } from './matching';
import { generateTravelToken } from './tokens';
import { supplierQuoteUrl } from './public-url';
import { renderRfqMessage, renderRfqReminder, rfqTemplateParams } from './rfq-message';
import { resolveSupplierConversation, sendTravelWhatsApp, type TravelSendResult } from './whatsapp';
import { getLead, setLeadStatus } from './leads';
import { pickRequirement } from './requirements';
import type { TripSummaryFields } from './format';

export interface CreateRfqOptions {
  actorUserId: string | null;
  /** Explicit recipients; when omitted the matcher picks them. */
  supplierIds?: string[];
  /** Send WhatsApp now (default: travel_settings.auto_send_rfq). */
  send?: boolean;
  request?: Request | null;
  notes?: string | null;
}

export interface CreateRfqResult {
  rfq: Rfq;
  recipients: RfqSupplier[];
  matchedCount: number;
  sendResults: Record<string, TravelSendResult>;
}

export async function createRfqForLead(
  db: SupabaseClient,
  accountId: string,
  leadId: string,
  opts: CreateRfqOptions
): Promise<CreateRfqResult> {
  const lead = await getLead(db, accountId, leadId);
  const settings = await getTravelSettings(db, accountId);

  // Recipients
  let supplierIds = opts.supplierIds ?? [];
  let matchedCount = 0;
  if (!opts.supplierIds) {
    const match = await matchSuppliersForLead(
      db,
      accountId,
      { destination_primary: lead.destination_primary, destinations: lead.destinations },
      settings.max_suppliers_per_rfq
    );
    supplierIds = match.suppliers.map((s) => s.id);
    matchedCount = supplierIds.length;
    if (match.resolvedDestination && !lead.destination_id) {
      await db.from('travel_leads').update({ destination_id: match.resolvedDestination.id }).eq('id', leadId);
    }
  } else {
    // Validate agent-supplied ids belong to this account.
    const { data: valid } = await db
      .from('suppliers')
      .select('id')
      .eq('account_id', accountId)
      .in('id', supplierIds);
    supplierIds = (valid ?? []).map((v) => v.id as string);
  }

  // Version = previous max + 1; close any open RFQ for the lead.
  const { data: prev } = await db
    .from('rfqs')
    .select('id, version, status')
    .eq('travel_lead_id', leadId)
    .eq('account_id', accountId)
    .order('version', { ascending: false });
  const version = ((prev?.[0]?.version as number | undefined) ?? 0) + 1;
  const openIds = (prev ?? []).filter((r) => ['DRAFT', 'SENT', 'PARTIALLY_RESPONDED'].includes(r.status as string)).map((r) => r.id as string);
  if (openIds.length) {
    await db.from('rfqs').update({ status: 'CLOSED', closed_at: new Date().toISOString() }).in('id', openIds);
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + settings.rfq_deadline_hours * 3_600_000).toISOString();
  const { data: rfqRow, error } = await db
    .from('rfqs')
    .insert({
      account_id: accountId,
      travel_lead_id: leadId,
      requirement_version_id: lead.current_requirement_version_id,
      version,
      status: 'DRAFT',
      recipient_count: supplierIds.length,
      expires_at: expiresAt,
      notes: opts.notes ?? null,
      created_by: opts.actorUserId,
    })
    .select('*')
    .single();
  if (error || !rfqRow) throw new Error(`Failed to create RFQ: ${error?.message ?? 'unknown'}`);
  const rfq = rfqRow as Rfq;

  const recipients: RfqSupplier[] = [];
  for (const supplierId of supplierIds) {
    const r = await insertRecipient(db, accountId, rfq, supplierId, settings.supplier_quote_token_ttl_hours);
    if (r) recipients.push(r.row);
  }

  await recordLeadEvent(db, {
    accountId,
    leadId,
    type: LEAD_EVENT_TYPES.RFQ_GENERATED,
    actorType: opts.actorUserId ? 'agent' : 'system',
    actorUserId: opts.actorUserId,
    title: `RFQ V${version} created for ${recipients.length} ${recipients.length === 1 ? 'supplier' : 'suppliers'}`,
    details: {
      rfq_id: rfq.id,
      version,
      requirement_version_id: lead.current_requirement_version_id,
      supplier_ids: recipients.map((r) => r.supplier_id),
      auto_matched: !opts.supplierIds,
      matched_count: matchedCount,
    },
  });

  console.log('[travel/rfq] created', { accountId, leadId, rfqId: rfq.id, version, recipients: recipients.length });

  const shouldSend = opts.send ?? settings.auto_send_rfq;
  let sendResults: Record<string, TravelSendResult> = {};
  if (shouldSend && recipients.length) {
    sendResults = await sendRfq(db, accountId, rfq.id, { actorUserId: opts.actorUserId, request: opts.request ?? null });
  } else if (recipients.length === 0) {
    await recordLeadEvent(db, {
      accountId,
      leadId,
      type: LEAD_EVENT_TYPES.RFQ_SEND_FAILED,
      title: 'No suppliers matched this destination — add suppliers manually',
      details: { rfq_id: rfq.id, destination: lead.destination_primary },
    });
    await setLeadStatus(db, accountId, leadId, 'QUALIFIED', {
      actorType: 'system',
      nextAction: { text: 'No suppliers matched — add suppliers to the RFQ' },
    });
  }

  const fresh = await getRfq(db, accountId, rfq.id);
  return { rfq: fresh, recipients: fresh.rfq_suppliers ?? recipients, matchedCount, sendResults };
}

interface InsertedRecipient {
  row: RfqSupplier;
  /** Plaintext token — only ever used to build the outgoing link. */
  token: string;
}

async function insertRecipient(
  db: SupabaseClient,
  accountId: string,
  rfq: Rfq,
  supplierId: string,
  ttlHours: number
): Promise<InsertedRecipient | null> {
  const t = generateTravelToken('supplier_quote', ttlHours);
  const { data, error } = await db
    .from('rfq_suppliers')
    .insert({
      account_id: accountId,
      rfq_id: rfq.id,
      supplier_id: supplierId,
      status: 'PENDING',
      quote_token_hash: t.hash,
      quote_token_expires_at: t.expiresAt,
    })
    .select('*')
    .single();
  if (error || !data) {
    console.error('[travel/rfq] recipient insert failed:', error?.message);
    return null;
  }
  // Stash the plaintext in memory for the immediate send only.
  pendingTokens.set(data.id as string, t.token);
  return { row: data as RfqSupplier, token: t.token };
}

/** Plaintext tokens minted in this process, keyed by rfq_supplier id,
 *  consumed by the first send. A retry/reminder rotates the token. */
const pendingTokens = new Map<string, string>();

/** Send (or re-send) the RFQ to every PENDING recipient. */
export async function sendRfq(
  db: SupabaseClient,
  accountId: string,
  rfqId: string,
  opts: { actorUserId: string | null; request?: Request | null; onlyRecipientId?: string }
): Promise<Record<string, TravelSendResult>> {
  const rfq = await getRfq(db, accountId, rfqId);
  const results: Record<string, TravelSendResult> = {};
  const targets = (rfq.rfq_suppliers ?? []).filter(
    (r) => (opts.onlyRecipientId ? r.id === opts.onlyRecipientId : r.status === 'PENDING')
  );
  for (const r of targets) {
    results[r.id] = await dispatchRfqSupplier(db, accountId, r.id, {
      request: opts.request ?? null,
      actorUserId: opts.actorUserId,
    });
  }
  await refreshRfqStatus(db, accountId, rfqId, opts.actorUserId);
  return results;
}

/**
 * Send the RFQ message to one recipient. Rotates the quote token
 * when no in-memory plaintext exists (retries after a restart).
 */
export async function dispatchRfqSupplier(
  db: SupabaseClient,
  accountId: string,
  rfqSupplierId: string,
  opts: { request?: Request | null; actorUserId: string | null; reminder?: boolean }
): Promise<TravelSendResult> {
  const { data: rsRow } = await db
    .from('rfq_suppliers')
    .select('*, supplier:suppliers(*), rfq:rfqs(*)')
    .eq('id', rfqSupplierId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (!rsRow) throw notFound('RFQ recipient');
  const rs = rsRow as RfqSupplier & { supplier: Supplier | null; rfq: Rfq };
  if (!rs.supplier) throw badRequest('Supplier missing');

  const lead = await getLead(db, accountId, rs.rfq.travel_lead_id);
  const requirement = await requirementForRfq(db, accountId, rs.rfq, lead);
  const settings = await getTravelSettings(db, accountId);

  // Token: reuse the just-minted plaintext, else rotate.
  let token = pendingTokens.get(rs.id);
  pendingTokens.delete(rs.id);
  if (!token) {
    const t = generateTravelToken('supplier_quote', settings.supplier_quote_token_ttl_hours);
    await db
      .from('rfq_suppliers')
      .update({ quote_token_hash: t.hash, quote_token_expires_at: t.expiresAt, quote_token_revoked_at: null })
      .eq('id', rs.id);
    token = t.token;
  }

  const conv = await resolveSupplierConversation(db, accountId, rs.supplier);
  const url = supplierQuoteUrl(token, opts.request);
  const msgInput = {
    supplierName: rs.supplier.primary_contact_name || rs.supplier.name,
    requirement,
    quoteUrl: url,
    deadlineIso: rs.rfq.expires_at,
    version: rs.rfq.version,
  };
  const text = opts.reminder ? renderRfqReminder(msgInput) : renderRfqMessage(msgInput);

  let result: TravelSendResult;
  if (!conv) {
    result = { ok: false, code: 'no_whatsapp_number', error: 'Supplier has no valid WhatsApp number' };
  } else {
    result = await sendTravelWhatsApp({
      db,
      accountId,
      conversationId: conv.conversationId,
      text,
      template:
        settings.supplier_rfq_template_name && !opts.reminder
          ? {
              name: settings.supplier_rfq_template_name,
              language: settings.supplier_rfq_template_language,
              params: rfqTemplateParams(msgInput),
            }
          : null,
    });
  }

  const now = new Date().toISOString();
  if (result.ok) {
    await db
      .from('rfq_suppliers')
      .update(
        opts.reminder
          ? { reminder_count: rs.reminder_count + 1, last_reminder_at: now, send_error: null }
          : { status: 'SENT', sent_at: rs.sent_at ?? now, sent_message_id: result.messageId, send_error: null, send_attempts: rs.send_attempts + 1 }
      )
      .eq('id', rs.id);
    await recordLeadEvent(db, {
      accountId,
      leadId: lead.id,
      type: opts.reminder ? LEAD_EVENT_TYPES.RFQ_REMINDER_SENT : LEAD_EVENT_TYPES.RFQ_SENT,
      actorType: opts.actorUserId ? 'agent' : 'system',
      actorUserId: opts.actorUserId,
      title: opts.reminder ? `Reminder sent to ${rs.supplier.name}` : `RFQ V${rs.rfq.version} sent to ${rs.supplier.name}`,
      details: { rfq_id: rs.rfq.id, rfq_supplier_id: rs.id, supplier_id: rs.supplier_id, via: result.via },
      trigger: opts.reminder
        ? undefined
        : { automation: 'travel_rfq_sent', webhook: 'travel.rfq.sent', contactId: lead.contact_id, conversationId: lead.conversation_id, payload: { supplier_id: rs.supplier_id, rfq_id: rs.rfq.id } },
    });
  } else {
    await db
      .from('rfq_suppliers')
      .update({ send_error: `${result.code}: ${result.error}`, send_attempts: rs.send_attempts + 1 })
      .eq('id', rs.id);
    await recordLeadEvent(db, {
      accountId,
      leadId: lead.id,
      type: LEAD_EVENT_TYPES.RFQ_SEND_FAILED,
      actorType: 'system',
      title: `RFQ send to ${rs.supplier.name} failed (${result.code})`,
      details: { rfq_id: rs.rfq.id, rfq_supplier_id: rs.id, supplier_id: rs.supplier_id, error: result.error, code: result.code },
    });
    console.error('[travel/rfq] dispatch failed', { rfqSupplierId: rs.id, code: result.code });
  }
  return result;
}

/** The requirement snapshot an RFQ was generated from (falls back to the lead). */
export async function requirementForRfq(
  db: SupabaseClient,
  accountId: string,
  rfq: Rfq,
  lead?: TravelLead
): Promise<TripSummaryFields> {
  if (rfq.requirement_version_id) {
    const { data } = await db
      .from('travel_requirement_versions')
      .select('*')
      .eq('id', rfq.requirement_version_id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (data) return pickRequirement(data as unknown as Record<string, unknown>) as TripSummaryFields;
  }
  const l = lead ?? (await getLead(db, accountId, rfq.travel_lead_id));
  return pickRequirement(l as unknown as Record<string, unknown>) as TripSummaryFields;
}

/** Recompute rfq.status / counts from its recipients and move the lead. */
export async function refreshRfqStatus(
  db: SupabaseClient,
  accountId: string,
  rfqId: string,
  actorUserId: string | null
): Promise<Rfq> {
  const rfq = await getRfq(db, accountId, rfqId);
  const recipients = rfq.rfq_suppliers ?? [];
  const sent = recipients.filter((r) => ['SENT', 'RESPONDED', 'SELECTED', 'REJECTED', 'DECLINED', 'EXPIRED'].includes(r.status));
  const responded = recipients.filter((r) => ['RESPONDED', 'SELECTED', 'REJECTED'].includes(r.status));
  let status = rfq.status;
  if (['CLOSED', 'CANCELLED'].includes(rfq.status)) {
    status = rfq.status;
  } else if (responded.length > 0 && responded.length >= sent.length && sent.length > 0) {
    status = 'RESPONDED';
  } else if (responded.length > 0) {
    status = 'PARTIALLY_RESPONDED';
  } else if (sent.length > 0) {
    status = 'SENT';
  } else {
    status = 'DRAFT';
  }
  const patch: Record<string, unknown> = {
    status,
    recipient_count: recipients.length,
    response_count: responded.length,
  };
  if (status !== 'DRAFT' && !rfq.sent_at) patch.sent_at = new Date().toISOString();
  await db.from('rfqs').update(patch).eq('id', rfqId);

  // Lead stage follows the RFQ while the lead is still in the automated phase.
  const lead = await getLead(db, accountId, rfq.travel_lead_id);
  if (['QUALIFIED', 'RFQ_SENT', 'AWAITING_SUPPLIER_QUOTES', 'REQUOTE'].includes(lead.status)) {
    if (status === 'SENT') {
      await setLeadStatus(db, accountId, lead.id, lead.status === 'REQUOTE' ? 'REQUOTE' : 'RFQ_SENT', {
        actorUserId,
        actorType: actorUserId ? 'agent' : 'system',
        nextAction: { text: `Waiting for ${sent.length} supplier ${sent.length === 1 ? 'quote' : 'quotes'}`, at: rfq.expires_at },
      });
      if (lead.status !== 'REQUOTE') {
        await setLeadStatus(db, accountId, lead.id, 'AWAITING_SUPPLIER_QUOTES', { actorType: 'system' });
      }
    }
  }
  return { ...rfq, ...patch } as Rfq;
}

export async function addSupplierToRfq(
  db: SupabaseClient,
  accountId: string,
  rfqId: string,
  supplierId: string,
  opts: { actorUserId: string | null; send?: boolean; request?: Request | null }
): Promise<RfqSupplier> {
  const rfq = await getRfq(db, accountId, rfqId);
  if (['CLOSED', 'CANCELLED'].includes(rfq.status)) throw badRequest('RFQ is closed');
  if ((rfq.rfq_suppliers ?? []).some((r) => r.supplier_id === supplierId)) throw badRequest('Supplier already on this RFQ');
  const { data: supplier } = await db.from('suppliers').select('id, name').eq('id', supplierId).eq('account_id', accountId).maybeSingle();
  if (!supplier) throw notFound('Supplier');
  const settings = await getTravelSettings(db, accountId);
  const inserted = await insertRecipient(db, accountId, rfq, supplierId, settings.supplier_quote_token_ttl_hours);
  if (!inserted) throw new Error('Failed to add supplier');
  await recordLeadEvent(db, {
    accountId,
    leadId: rfq.travel_lead_id,
    type: LEAD_EVENT_TYPES.RFQ_SUPPLIER_ADDED,
    actorType: 'agent',
    actorUserId: opts.actorUserId,
    title: `${supplier.name} added to RFQ V${rfq.version}`,
    details: { rfq_id: rfqId, supplier_id: supplierId },
  });
  if (opts.send ?? true) {
    await dispatchRfqSupplier(db, accountId, inserted.row.id, { request: opts.request, actorUserId: opts.actorUserId });
  }
  await refreshRfqStatus(db, accountId, rfqId, opts.actorUserId);
  const { data } = await db.from('rfq_suppliers').select('*, supplier:suppliers(*)').eq('id', inserted.row.id).single();
  return data as RfqSupplier;
}

export async function removeSupplierFromRfq(
  db: SupabaseClient,
  accountId: string,
  rfqId: string,
  rfqSupplierId: string,
  opts: { actorUserId: string | null }
): Promise<void> {
  const { data: rs } = await db
    .from('rfq_suppliers')
    .select('*, supplier:suppliers(name)')
    .eq('id', rfqSupplierId)
    .eq('rfq_id', rfqId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (!rs) throw notFound('RFQ recipient');
  if (rs.status === 'RESPONDED' || rs.status === 'SELECTED') {
    throw badRequest('Cannot remove a supplier that has already quoted — reject the quote instead');
  }
  // Revoke the token rather than deleting history: the row stays with
  // status REJECTED so reports keep the "was asked" count.
  await db
    .from('rfq_suppliers')
    .update({ status: 'REJECTED', quote_token_revoked_at: new Date().toISOString() })
    .eq('id', rfqSupplierId);
  const rfq = await getRfq(db, accountId, rfqId);
  await recordLeadEvent(db, {
    accountId,
    leadId: rfq.travel_lead_id,
    type: LEAD_EVENT_TYPES.RFQ_SUPPLIER_REMOVED,
    actorType: 'agent',
    actorUserId: opts.actorUserId,
    title: `${(rs as { supplier?: { name?: string } }).supplier?.name ?? 'Supplier'} removed from RFQ V${rfq.version}`,
    details: { rfq_id: rfqId, rfq_supplier_id: rfqSupplierId },
  });
  await refreshRfqStatus(db, accountId, rfqId, opts.actorUserId);
}

export async function getRfq(db: SupabaseClient, accountId: string, rfqId: string): Promise<Rfq> {
  const { data } = await db
    .from('rfqs')
    .select('*, rfq_suppliers(*, supplier:suppliers(*), latest_quote:supplier_quotes!rfq_suppliers_latest_quote_fkey(*))')
    .eq('id', rfqId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (!data) throw notFound('RFQ');
  return data as Rfq;
}

export async function listRfqs(
  db: SupabaseClient,
  accountId: string,
  f: { status?: string | null; leadId?: string | null; limit?: number }
): Promise<Rfq[]> {
  let q = db
    .from('rfqs')
    .select('*, rfq_suppliers(*, supplier:suppliers(id, name, preferred, rating)), travel_lead:travel_leads(id, traveller_name, destination_primary, status, nights, adults, children)')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .limit(Math.min(200, f.limit ?? 100));
  if (f.status && f.status !== 'all') q = q.eq('status', f.status);
  if (f.leadId) q = q.eq('travel_lead_id', f.leadId);
  const { data } = await q;
  return (data ?? []) as Rfq[];
}

/** Cron: supplier reminders + RFQ expiry. Runs with the service role. */
export async function runRfqMaintenance(admin: SupabaseClient, now = new Date()): Promise<{ reminders: number; expired: number }> {
  let reminders = 0;
  let expired = 0;

  const { data: openRfqs } = await admin
    .from('rfqs')
    .select('id, account_id, travel_lead_id, expires_at, status, version')
    .in('status', ['SENT', 'PARTIALLY_RESPONDED']);

  const settingsCache = new Map<string, Awaited<ReturnType<typeof getTravelSettings>>>();
  for (const rfq of (openRfqs ?? []) as Pick<Rfq, 'id' | 'account_id' | 'travel_lead_id' | 'expires_at' | 'status' | 'version'>[]) {
    let settings = settingsCache.get(rfq.account_id);
    if (!settings) {
      settings = await getTravelSettings(admin, rfq.account_id);
      settingsCache.set(rfq.account_id, settings);
    }
    const isExpired = rfq.expires_at ? new Date(rfq.expires_at).getTime() <= now.getTime() : false;

    const { data: pending } = await admin
      .from('rfq_suppliers')
      .select('id, sent_at, reminder_count, last_reminder_at')
      .eq('rfq_id', rfq.id)
      .eq('status', 'SENT');

    for (const r of pending ?? []) {
      if (isExpired) {
        await admin.from('rfq_suppliers').update({ status: 'EXPIRED', quote_token_revoked_at: now.toISOString() }).eq('id', r.id);
        continue;
      }
      if (settings.supplier_max_reminders <= 0) continue;
      if ((r.reminder_count as number) >= settings.supplier_max_reminders) continue;
      const anchor = new Date((r.last_reminder_at as string | null) ?? (r.sent_at as string | null) ?? now.toISOString());
      const dueAt = anchor.getTime() + settings.supplier_reminder_hours * 3_600_000;
      if (dueAt > now.getTime()) continue;
      try {
        const res = await dispatchRfqSupplier(admin, rfq.account_id, r.id as string, { actorUserId: null, reminder: true });
        if (res.ok) reminders += 1;
      } catch (err) {
        console.error('[travel/cron] reminder failed:', err instanceof Error ? err.message : err);
      }
    }

    if (isExpired) {
      expired += 1;
      await admin.from('rfqs').update({ status: 'CLOSED', closed_at: now.toISOString() }).eq('id', rfq.id);
      await recordLeadEvent(admin, {
        accountId: rfq.account_id,
        leadId: rfq.travel_lead_id,
        type: LEAD_EVENT_TYPES.RFQ_EXPIRED,
        title: `RFQ V${rfq.version} deadline reached`,
        details: { rfq_id: rfq.id },
      });
      // Deadline reached → notify the traveller with whatever arrived
      // (the "OR deadline reached" rule). Lazy import avoids a cycle.
      const { maybeNotifyTravellerQuotesReady } = await import('./callbacks');
      await maybeNotifyTravellerQuotesReady(admin, rfq.account_id, rfq.id, { deadlineReached: true });
    }
  }
  return { reminders, expired };
}
