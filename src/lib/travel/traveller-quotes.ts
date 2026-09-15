// ============================================================
// Traveller (B2C) quotes: create versions from a chosen supplier
// quote + markup, approval guardrails, send over WhatsApp with a
// share link, and acceptance (agent-side or from the public
// share page) which creates the booking.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { GstTaxableBase, Itinerary, MarkupType, SupplierQuote, TravellerQuote, TravelLead } from '@/types/travel';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { LEAD_EVENT_TYPES } from './constants';
import { recordLeadEvent } from './events';
import { badRequest, notFound, TravelError } from './errors';
import { computeQuote, marginLevel } from './financials';
import { formatMoney, toMinor } from './money';
import { getTravelSettings } from './settings';
import { generateTravelToken, hashTravelToken, looksLikeTravelToken, tokenState } from './tokens';
import { travellerQuoteUrl } from './public-url';
import { renderTravellerQuoteMessage } from './rfq-message';
import { sendTravelWhatsApp } from './whatsapp';
import { getLead, setLeadStatus } from './leads';
import { notifyAdmins, notifyLeadOwners } from './notifications';
import { createBookingFromQuote } from './bookings';
import { fmtDate } from './format';

export interface TravellerQuoteInput {
  supplier_quote_id: string | null;
  /** Override the supplier cost (e.g. manual / no supplier quote). */
  supplier_cost?: string | number | null;
  markup_type: MarkupType;
  markup_value: string | number;
  discount_amount?: string | number | null;
  discount_reason?: string | null;
  gst_rate?: string | number | null;
  gst_taxable_base?: GstTaxableBase | null;
  title?: string | null;
  inclusions?: string | null;
  exclusions?: string | null;
  cancellation_policy?: string | null;
  notes?: string | null;
  valid_until?: string | null;
  revision_reason?: string | null;
}

export function parseTravellerQuoteInput(raw: unknown): TravellerQuoteInput {
  if (typeof raw !== 'object' || raw === null) throw badRequest('Invalid quote');
  const s = raw as Record<string, unknown>;
  const num = (v: unknown): string | number | null => (v === null || v === undefined || v === '' ? null : typeof v === 'number' ? v : String(v));
  const text = (v: unknown, max = 4000): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const markupType: MarkupType = s.markup_type === 'fixed' ? 'fixed' : 'percent';
  const markupValue = num(s.markup_value);
  if (markupValue === null) throw badRequest('markup_value is required');
  return {
    supplier_quote_id: typeof s.supplier_quote_id === 'string' && s.supplier_quote_id ? s.supplier_quote_id : null,
    supplier_cost: num(s.supplier_cost),
    markup_type: markupType,
    markup_value: markupValue,
    discount_amount: num(s.discount_amount),
    discount_reason: text(s.discount_reason, 500),
    gst_rate: num(s.gst_rate),
    gst_taxable_base: s.gst_taxable_base === 'markup' ? 'markup' : s.gst_taxable_base === 'selling_price' ? 'selling_price' : null,
    title: text(s.title, 200),
    inclusions: text(s.inclusions),
    exclusions: text(s.exclusions),
    cancellation_policy: text(s.cancellation_policy),
    notes: text(s.notes),
    valid_until: typeof s.valid_until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.valid_until) ? s.valid_until : null,
    revision_reason: text(s.revision_reason, 500),
  };
}

export async function createTravellerQuote(
  db: SupabaseClient,
  accountId: string,
  leadId: string,
  input: TravellerQuoteInput,
  actorUserId: string | null
): Promise<TravellerQuote> {
  const lead = await getLead(db, accountId, leadId);
  const settings = await getTravelSettings(db, accountId);

  let supplierQuote: SupplierQuote | null = null;
  if (input.supplier_quote_id) {
    const { data } = await db.from('supplier_quotes').select('*').eq('id', input.supplier_quote_id).eq('account_id', accountId).eq('travel_lead_id', leadId).maybeSingle();
    if (!data) throw notFound('Supplier quote');
    supplierQuote = data as SupplierQuote;
  }
  const supplierCost = input.supplier_cost ?? supplierQuote?.total_supplier_cost ?? null;
  if (supplierCost === null) throw badRequest('Choose a supplier quote or enter a supplier cost');

  const breakdown = computeQuote({
    supplierCost,
    markupType: input.markup_type,
    markupValue: input.markup_value,
    discountAmount: input.discount_amount ?? 0,
    gstRate: input.gst_rate ?? settings.gst_rate,
    gstTaxableBase: input.gst_taxable_base ?? settings.gst_taxable_base,
  });
  const level = marginLevel(breakdown.margin_pct, settings.margin_warning_pct, settings.margin_approval_pct);

  const { data: prev } = await db.from('traveller_quotes').select('id, version, status').eq('travel_lead_id', leadId).eq('account_id', accountId).order('version', { ascending: false });
  const version = ((prev?.[0]?.version as number | undefined) ?? 0) + 1;
  // Older DRAFT/SENT versions become REVISED (history kept).
  const supersede = (prev ?? []).filter((p) => ['DRAFT', 'SENT', 'VIEWED'].includes(p.status as string)).map((p) => p.id as string);
  if (supersede.length) await db.from('traveller_quotes').update({ status: 'REVISED' }).in('id', supersede);

  const validUntil = input.valid_until ?? new Date(Date.now() + settings.traveller_quote_validity_days * 86_400_000).toISOString().slice(0, 10);

  const { data, error } = await db
    .from('traveller_quotes')
    .insert({
      account_id: accountId,
      travel_lead_id: leadId,
      supplier_quote_id: supplierQuote?.id ?? null,
      version,
      title: input.title ?? `${lead.destination_primary ?? 'Trip'} package`,
      currency: settings.currency,
      ...breakdown,
      discount_reason: input.discount_reason ?? null,
      inclusions: input.inclusions ?? supplierQuote?.inclusions ?? null,
      exclusions: input.exclusions ?? supplierQuote?.exclusions ?? null,
      cancellation_policy: input.cancellation_policy ?? supplierQuote?.cancellation_policy ?? null,
      notes: input.notes ?? null,
      revision_reason: input.revision_reason ?? null,
      status: 'DRAFT',
      approval_status: level === 'approval_required' ? 'pending' : 'not_required',
      valid_until: validUntil,
      created_by: actorUserId,
    })
    .select('*')
    .single();
  if (error || !data) throw new Error(`Failed to create traveller quote: ${error?.message ?? 'unknown'}`);
  const quote = data as TravellerQuote;

  if (supplierQuote && supplierQuote.status === 'SUBMITTED') {
    await db.from('supplier_quotes').update({ status: 'SHORTLISTED' }).eq('id', supplierQuote.id);
  }

  await recordLeadEvent(db, {
    accountId,
    leadId,
    type: version === 1 ? LEAD_EVENT_TYPES.TRAVELLER_QUOTE_GENERATED : LEAD_EVENT_TYPES.TRAVELLER_QUOTE_REVISED,
    actorType: 'agent',
    actorUserId,
    title: `Quote V${version} ${version === 1 ? 'generated' : 'revised'}: ${formatMoney(quote.traveller_total)} (margin ${quote.margin_pct}%)${input.revision_reason ? ` — ${input.revision_reason}` : ''}`,
    details: {
      traveller_quote_id: quote.id,
      version,
      supplier_quote_id: supplierQuote?.id ?? null,
      supplier_cost: quote.supplier_cost,
      markup_amount: quote.markup_amount,
      discount_amount: quote.discount_amount,
      gst_amount: quote.gst_amount,
      traveller_total: quote.traveller_total,
      gross_profit: quote.gross_profit,
      margin_pct: quote.margin_pct,
      margin_level: level,
      reason: input.revision_reason ?? null,
    },
  });
  if (toMinor(quote.discount_amount) > 0n) {
    await recordLeadEvent(db, {
      accountId,
      leadId,
      type: LEAD_EVENT_TYPES.DISCOUNT_CHANGED,
      actorType: 'agent',
      actorUserId,
      title: `Discount ${formatMoney(quote.discount_amount)} on quote V${version}${input.discount_reason ? ` — ${input.discount_reason}` : ''}`,
      details: { traveller_quote_id: quote.id, discount_amount: quote.discount_amount, reason: input.discount_reason ?? null },
    });
  }
  if (level === 'approval_required') {
    await recordLeadEvent(db, {
      accountId,
      leadId,
      type: LEAD_EVENT_TYPES.QUOTE_APPROVAL_REQUESTED,
      actorType: 'system',
      title: `Quote V${version} needs approval — margin ${quote.margin_pct}% is below ${settings.margin_approval_pct}%`,
      details: { traveller_quote_id: quote.id },
    });
    await notifyAdmins({
      accountId,
      type: 'travel_quote_approval_requested',
      title: `Low-margin quote needs approval (${quote.margin_pct}%) — ${lead.traveller_name ?? 'traveller'}`,
      body: `${formatMoney(quote.traveller_total)} for ${lead.destination_primary ?? 'trip'}`,
      travelLeadId: leadId,
      actorUserId,
    });
  }
  if (['QUOTES_AVAILABLE', 'CALLBACK_REQUESTED', 'HUMAN_FOLLOWUP', 'REQUOTE'].includes(lead.status)) {
    await setLeadStatus(db, accountId, leadId, 'NEGOTIATION', { actorType: 'agent', actorUserId, nextAction: { text: `Send quote V${version} to traveller` } });
  }
  return quote;
}

export async function approveTravellerQuote(db: SupabaseClient, accountId: string, quoteId: string, approve: boolean, actorUserId: string): Promise<TravellerQuote> {
  const { data: q } = await db.from('traveller_quotes').select('*').eq('id', quoteId).eq('account_id', accountId).maybeSingle();
  if (!q) throw notFound('Traveller quote');
  const { data, error } = await db
    .from('traveller_quotes')
    .update({ approval_status: approve ? 'approved' : 'rejected', approved_by: actorUserId, approved_at: new Date().toISOString() })
    .eq('id', quoteId)
    .select('*')
    .single();
  if (error || !data) throw new Error(`Failed to update approval: ${error?.message}`);
  await recordLeadEvent(db, {
    accountId,
    leadId: (q as TravellerQuote).travel_lead_id,
    type: LEAD_EVENT_TYPES.QUOTE_APPROVED,
    actorType: 'agent',
    actorUserId,
    title: `Quote V${(q as TravellerQuote).version} ${approve ? 'approved' : 'approval rejected'}`,
    details: { traveller_quote_id: quoteId },
  });
  return data as TravellerQuote;
}

/** Mint a share token and WhatsApp the quote link to the traveller. */
export async function sendTravellerQuote(
  db: SupabaseClient,
  accountId: string,
  quoteId: string,
  opts: { actorUserId: string | null; request?: Request | null }
): Promise<{ quote: TravellerQuote; url: string; sent: boolean; error?: string }> {
  const { data: q } = await db.from('traveller_quotes').select('*').eq('id', quoteId).eq('account_id', accountId).maybeSingle();
  if (!q) throw notFound('Traveller quote');
  const quote = q as TravellerQuote;
  if (['ACCEPTED', 'REJECTED', 'EXPIRED', 'REVISED'].includes(quote.status)) throw badRequest(`Quote V${quote.version} is ${quote.status.toLowerCase()} and cannot be sent`);
  if (quote.approval_status === 'pending') throw new TravelError('approval_required', 'This quote needs admin approval before it can be sent', 409);
  if (quote.approval_status === 'rejected') throw new TravelError('approval_rejected', 'This quote was not approved', 409);

  const lead = await getLead(db, accountId, quote.travel_lead_id);
  const settings = await getTravelSettings(db, accountId);
  const admin = supabaseAdmin();

  const t = generateTravelToken('traveller_quote', Math.max(24, settings.traveller_quote_validity_days * 24 + 24));
  const { error: tokErr } = await admin.from('travel_access_tokens').insert({
    account_id: accountId,
    kind: 'traveller_quote',
    token_hash: t.hash,
    travel_lead_id: lead.id,
    subject_id: quote.id,
    expires_at: t.expiresAt,
  });
  if (tokErr) throw new Error(`Failed to mint quote token: ${tokErr.message}`);
  const url = travellerQuoteUrl(t.token, opts.request);

  let sent = false;
  let errorMsg: string | undefined;
  if (lead.conversation_id) {
    const res = await sendTravelWhatsApp({
      db,
      accountId,
      conversationId: lead.conversation_id,
      text: renderTravellerQuoteMessage({
        travellerName: lead.traveller_name,
        destination: lead.destination_primary,
        total: formatMoney(quote.traveller_total, quote.currency),
        validUntil: quote.valid_until ? fmtDate(quote.valid_until) : null,
        quoteUrl: url,
        version: quote.version,
      }),
    });
    sent = res.ok;
    if (!res.ok) errorMsg = `${res.code}: ${res.error}`;
    await db
      .from('traveller_quotes')
      .update(res.ok ? { status: 'SENT', sent_at: new Date().toISOString(), sent_message_id: res.messageId, send_error: null } : { status: 'SENT', sent_at: new Date().toISOString(), send_error: errorMsg })
      .eq('id', quoteId);
  } else {
    errorMsg = 'Lead has no WhatsApp conversation';
    await db.from('traveller_quotes').update({ status: 'SENT', sent_at: new Date().toISOString(), send_error: errorMsg }).eq('id', quoteId);
  }

  await recordLeadEvent(db, {
    accountId,
    leadId: lead.id,
    type: sent ? LEAD_EVENT_TYPES.TRAVELLER_QUOTE_SENT : LEAD_EVENT_TYPES.TRAVELLER_QUOTE_SEND_FAILED,
    actorType: 'agent',
    actorUserId: opts.actorUserId,
    title: sent ? `Quote V${quote.version} sent to traveller (${formatMoney(quote.traveller_total)})` : `Quote V${quote.version} link created but WhatsApp send failed — ${errorMsg}`,
    details: { traveller_quote_id: quote.id, url_issued: true, error: errorMsg ?? null },
    trigger: sent
      ? { automation: 'traveller_quote_sent', webhook: 'travel.traveller_quote.sent', contactId: lead.contact_id, conversationId: lead.conversation_id, payload: { traveller_quote_id: quote.id, traveller_total: quote.traveller_total } }
      : undefined,
  });
  await setLeadStatus(db, accountId, lead.id, 'NEGOTIATION', { actorType: 'agent', actorUserId: opts.actorUserId, nextAction: { text: 'Waiting for traveller to accept quote', at: quote.valid_until ? `${quote.valid_until}T18:00:00+05:30` : null } });

  const { data: fresh } = await db.from('traveller_quotes').select('*').eq('id', quoteId).single();
  return { quote: fresh as TravellerQuote, url, sent, error: errorMsg };
}

/** Agent- or traveller-side acceptance → booking. Idempotent. */
export async function acceptTravellerQuote(
  db: SupabaseClient,
  accountId: string,
  quoteId: string,
  opts: { actorUserId: string | null; actorType: 'agent' | 'traveller' }
) {
  const { data: q } = await db.from('traveller_quotes').select('*').eq('id', quoteId).eq('account_id', accountId).maybeSingle();
  if (!q) throw notFound('Traveller quote');
  const quote = q as TravellerQuote;
  if (quote.status === 'ACCEPTED') {
    const { data: b } = await db.from('bookings').select('*').eq('traveller_quote_id', quoteId).maybeSingle();
    return { quote, booking: b, created: false };
  }
  if (['REJECTED', 'EXPIRED', 'REVISED'].includes(quote.status)) throw badRequest(`Quote V${quote.version} is ${quote.status.toLowerCase()} and cannot be accepted`);
  if (quote.approval_status === 'pending' || quote.approval_status === 'rejected') throw new TravelError('approval_required', 'Quote is awaiting approval', 409);

  const { data: accepted, error } = await db
    .from('traveller_quotes')
    .update({ status: 'ACCEPTED', accepted_at: new Date().toISOString() })
    .eq('id', quoteId)
    .select('*')
    .single();
  if (error || !accepted) throw new Error(`Failed to accept quote: ${error?.message}`);
  const acc = accepted as TravellerQuote;

  await recordLeadEvent(db, {
    accountId,
    leadId: acc.travel_lead_id,
    type: LEAD_EVENT_TYPES.TRAVELLER_QUOTE_ACCEPTED,
    actorType: opts.actorType,
    actorUserId: opts.actorUserId,
    title: `Traveller accepted quote V${acc.version} — ${formatMoney(acc.traveller_total)}`,
    details: { traveller_quote_id: acc.id, traveller_total: acc.traveller_total },
    trigger: { automation: 'traveller_quote_accepted', webhook: 'travel.traveller_quote.accepted', payload: { traveller_quote_id: acc.id } },
  });

  const { booking, created } = await createBookingFromQuote(db, accountId, acc, { actorUserId: opts.actorUserId, actorType: opts.actorType });
  if (opts.actorType === 'traveller') {
    const lead = await getLead(db, accountId, acc.travel_lead_id);
    await notifyLeadOwners({
      accountId,
      assignedAgentId: lead.assigned_agent_id,
      type: 'travel_quote_accepted',
      title: `${lead.traveller_name ?? 'Traveller'} accepted the package — ${booking.booking_number}`,
      body: formatMoney(acc.traveller_total),
      travelLeadId: lead.id,
      conversationId: lead.conversation_id,
      contactId: lead.contact_id,
    });
  }
  return { quote: acc, booking, created };
}

export async function rejectTravellerQuote(db: SupabaseClient, accountId: string, quoteId: string, opts: { actorUserId: string | null; actorType: 'agent' | 'traveller'; reason?: string | null }): Promise<TravellerQuote> {
  const { data: q } = await db.from('traveller_quotes').select('*').eq('id', quoteId).eq('account_id', accountId).maybeSingle();
  if (!q) throw notFound('Traveller quote');
  const quote = q as TravellerQuote;
  if (quote.status === 'ACCEPTED') throw badRequest('Quote already accepted');
  const { data, error } = await db.from('traveller_quotes').update({ status: 'REJECTED', rejected_at: new Date().toISOString() }).eq('id', quoteId).select('*').single();
  if (error || !data) throw new Error(`Failed to reject quote: ${error?.message}`);
  await recordLeadEvent(db, {
    accountId,
    leadId: quote.travel_lead_id,
    type: LEAD_EVENT_TYPES.TRAVELLER_QUOTE_REJECTED,
    actorType: opts.actorType,
    actorUserId: opts.actorUserId,
    title: `Quote V${quote.version} rejected${opts.reason ? ` — ${opts.reason}` : ''}`,
    details: { traveller_quote_id: quoteId, reason: opts.reason ?? null },
  });
  return data as TravellerQuote;
}

export async function listTravellerQuotes(db: SupabaseClient, accountId: string, leadId: string): Promise<TravellerQuote[]> {
  const { data } = await db
    .from('traveller_quotes')
    .select('*, supplier_quote:supplier_quotes(id, version, total_supplier_cost, supplier:suppliers(id, name))')
    .eq('account_id', accountId)
    .eq('travel_lead_id', leadId)
    .order('version', { ascending: false });
  return (data ?? []) as TravellerQuote[];
}

// ------------------------------------------------------------
// Public share page (/q/[token])
// ------------------------------------------------------------

export interface TravellerQuoteContext {
  quote: TravellerQuote;
  lead: TravelLead;
  itinerary: Itinerary | null;
  tokenId: string;
}

export async function resolveTravellerQuoteToken(token: string): Promise<TravellerQuoteContext> {
  if (!looksLikeTravelToken(token, 'traveller_quote')) throw new TravelError('invalid_token', 'This link is not valid', 404);
  const admin = supabaseAdmin();
  const { data: row } = await admin.from('travel_access_tokens').select('*').eq('token_hash', hashTravelToken(token)).eq('kind', 'traveller_quote').maybeSingle();
  if (!row) throw new TravelError('invalid_token', 'This link is not valid', 404);
  const state = tokenState(row);
  if (state === 'revoked') throw new TravelError('revoked_token', 'This link is no longer active', 410);
  if (state === 'expired') throw new TravelError('expired_token', 'This link has expired — please ask your travel expert for a fresh one', 410);
  const { data: quote } = await admin.from('traveller_quotes').select('*').eq('id', row.subject_id).maybeSingle();
  if (!quote) throw notFound('Quote');
  const { data: lead } = await admin.from('travel_leads').select('*').eq('id', row.travel_lead_id).maybeSingle();
  if (!lead) throw notFound('Lead');
  const { data: itins } = await admin
    .from('itineraries')
    .select('*, days:itinerary_days(*)')
    .eq('travel_lead_id', row.travel_lead_id)
    .order('version', { ascending: false });
  const list = (itins ?? []) as Itinerary[];
  const itinerary = list.find((i) => i.traveller_quote_id === quote.id) ?? list.find((i) => i.status === 'FINAL') ?? list[0] ?? null;
  if (itinerary?.days) itinerary.days.sort((a, b) => a.day_number - b.day_number);

  const q = quote as TravellerQuote;
  await admin.from('travel_access_tokens').update({ last_used_at: new Date().toISOString(), first_used_at: row.first_used_at ?? new Date().toISOString(), use_count: (row.use_count as number) + 1 }).eq('id', row.id);
  if (q.status === 'SENT') {
    await admin.from('traveller_quotes').update({ status: 'VIEWED', viewed_at: new Date().toISOString() }).eq('id', q.id);
    await recordLeadEvent(admin, {
      accountId: q.account_id,
      leadId: q.travel_lead_id,
      type: LEAD_EVENT_TYPES.TRAVELLER_QUOTE_VIEWED,
      actorType: 'traveller',
      title: `Traveller viewed quote V${q.version}`,
      details: { traveller_quote_id: q.id },
    });
    q.status = 'VIEWED';
  }
  return { quote: q, lead: lead as TravelLead, itinerary, tokenId: row.id as string };
}

/** Traveller-safe projection: price, GST, total, itinerary — never cost/markup/profit. */
export function travellerQuotePublicView(ctx: TravellerQuoteContext) {
  const { quote, lead, itinerary } = ctx;
  return {
    traveller_first_name: (lead.traveller_name ?? '').split(/\s+/)[0] || null,
    destination: lead.destination_primary,
    destinations: lead.destinations,
    nights: lead.nights,
    days: lead.days,
    travel_month: lead.travel_month,
    travel_start_date: lead.travel_start_date,
    travel_end_date: lead.travel_end_date,
    adults: lead.adults,
    children: lead.children,
    infants: lead.infants,
    hotel_category: lead.hotel_category,
    meal_plan: lead.meal_plan,
    vehicle_type: lead.vehicle_type,
    quote: {
      version: quote.version,
      title: quote.title,
      currency: quote.currency,
      price_before_tax: quote.selling_price_before_tax,
      gst_rate: quote.gst_rate,
      gst_amount: quote.gst_amount,
      total: quote.traveller_total,
      valid_until: quote.valid_until,
      inclusions: quote.inclusions,
      exclusions: quote.exclusions,
      cancellation_policy: quote.cancellation_policy,
      notes: quote.notes,
      status: quote.status,
    },
    itinerary: itinerary
      ? {
          title: itinerary.title,
          summary: itinerary.summary,
          hero_image_url: itinerary.hero_image_url,
          days: (itinerary.days ?? []).map((d) => ({
            day_number: d.day_number,
            date: d.date,
            title: d.title,
            description: d.description,
            hotel: d.hotel,
            meals: d.meals,
            transport: d.transport,
            activities: d.activities,
          })),
        }
      : null,
  };
}

export async function travellerQuoteAction(
  token: string,
  action: 'accept' | 'request_change' | 'talk_to_expert',
  note: string | null
) {
  const ctx = await resolveTravellerQuoteToken(token);
  const admin = supabaseAdmin();
  const { quote, lead } = ctx;
  if (action === 'accept') {
    if (quote.valid_until && quote.valid_until < new Date().toISOString().slice(0, 10)) {
      throw new TravelError('quote_expired', 'This quote has expired — please ask your travel expert for an updated one', 410);
    }
    const result = await acceptTravellerQuote(admin, quote.account_id, quote.id, { actorUserId: null, actorType: 'traveller' });
    return { status: 'accepted' as const, booking_number: result.booking?.booking_number ?? null };
  }
  const title = action === 'request_change' ? 'Traveller requested a change' : 'Traveller asked to talk to an expert';
  await recordLeadEvent(admin, {
    accountId: quote.account_id,
    leadId: lead.id,
    type: LEAD_EVENT_TYPES.TRAVELLER_CHANGE_REQUESTED,
    actorType: 'traveller',
    title: `${title}${note ? `: "${note}"` : ''}`,
    details: { traveller_quote_id: quote.id, action, note },
  });
  await setLeadStatus(admin, quote.account_id, lead.id, action === 'request_change' ? 'REQUOTE' : 'HUMAN_FOLLOWUP', {
    actorType: 'traveller',
    nextAction: { text: action === 'request_change' ? `Traveller wants a change on quote V${quote.version}` : 'Traveller wants to talk — call them' },
  });
  await notifyLeadOwners({
    accountId: quote.account_id,
    assignedAgentId: lead.assigned_agent_id,
    type: 'travel_callback_requested',
    title: `${lead.traveller_name ?? 'Traveller'}: ${title.toLowerCase()}`,
    body: note,
    travelLeadId: lead.id,
    conversationId: lead.conversation_id,
    contactId: lead.contact_id,
  });
  return { status: action === 'request_change' ? ('change_requested' as const) : ('expert_requested' as const) };
}
