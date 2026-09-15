// ============================================================
// Supplier quotes.
//
// Public side (token-gated, service role, no PII to the supplier):
//   resolveSupplierToken → supplierFormData → submitSupplierQuote
// Agent side (RLS client):
//   setSupplierQuoteStatus (shortlist / select / reject), listing.
//
// Revisions append a new supplier_quotes row (version+1) and flip
// the previous one to REVISED. Nothing is overwritten.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Rfq,
  RfqSupplier,
  Supplier,
  SupplierQuote,
  SupplierQuoteItem,
  SupplierQuoteItemCategory,
  SupplierQuoteStatus,
  TravelLead,
} from '@/types/travel';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { SUPPLIER_QUOTE_ITEM_CATEGORIES } from '@/types/travel';
import { LEAD_EVENT_TYPES } from './constants';
import { recordLeadEvent } from './events';
import { badRequest, notFound, TravelError } from './errors';
import { computeSupplierQuoteTotals } from './financials';
import { fromMinor, toMinor, formatMoney } from './money';
import { hashTravelToken, looksLikeTravelToken, tokenState } from './tokens';
import { requirementForRfq, refreshRfqStatus } from './rfq';
import { maybeNotifyTravellerQuotesReady } from './callbacks';
import { notifyLeadOwners } from './notifications';
import type { TripSummaryFields } from './format';

export interface SupplierTokenContext {
  rfqSupplier: RfqSupplier;
  rfq: Rfq;
  supplier: Supplier;
  lead: TravelLead;
  requirement: TripSummaryFields;
  latestQuote: SupplierQuote | null;
}

/**
 * Validate a supplier quote token. Rejects malformed, unknown,
 * expired and revoked tokens with distinct (public-safe) messages.
 * Also refuses tokens whose RFQ is closed/cancelled.
 */
export async function resolveSupplierToken(token: string): Promise<SupplierTokenContext> {
  if (!looksLikeTravelToken(token, 'supplier_quote')) {
    throw new TravelError('invalid_token', 'This quote link is not valid', 404);
  }
  const admin = supabaseAdmin();
  const { data: rs } = await admin
    .from('rfq_suppliers')
    .select('*, supplier:suppliers(*), rfq:rfqs(*)')
    .eq('quote_token_hash', hashTravelToken(token))
    .maybeSingle();
  if (!rs) throw new TravelError('invalid_token', 'This quote link is not valid', 404);
  const state = tokenState(rs);
  if (state === 'revoked') throw new TravelError('revoked_token', 'This quote link has been withdrawn', 410);
  if (state === 'expired') throw new TravelError('expired_token', 'This quote link has expired. Please ask Oliday for a fresh link.', 410);
  const row = rs as RfqSupplier & { supplier: Supplier | null; rfq: Rfq | null };
  if (!row.supplier || !row.rfq) throw new TravelError('invalid_token', 'This quote link is not valid', 404);
  if (['CLOSED', 'CANCELLED'].includes(row.rfq.status)) {
    throw new TravelError('rfq_closed', 'This request for quotation is closed', 410);
  }
  const { data: lead } = await admin.from('travel_leads').select('*').eq('id', row.rfq.travel_lead_id).maybeSingle();
  if (!lead) throw notFound('Lead');
  const requirement = await requirementForRfq(admin, row.rfq.account_id, row.rfq, lead as TravelLead);
  let latestQuote: SupplierQuote | null = null;
  if (row.latest_quote_id) {
    const { data: q } = await admin.from('supplier_quotes').select('*').eq('id', row.latest_quote_id).maybeSingle();
    latestQuote = (q as SupplierQuote | null) ?? null;
  }
  if (!row.opened_at) {
    await admin.from('rfq_suppliers').update({ opened_at: new Date().toISOString() }).eq('id', row.id);
  }
  return { rfqSupplier: row, rfq: row.rfq, supplier: row.supplier, lead: lead as TravelLead, requirement, latestQuote };
}

/** What the supplier form is allowed to see — trip needs only, no traveller identity. */
export function supplierFormData(ctx: SupplierTokenContext) {
  const r = ctx.requirement;
  return {
    supplier_name: ctx.supplier.primary_contact_name || ctx.supplier.name,
    rfq_version: ctx.rfq.version,
    deadline: ctx.rfq.expires_at,
    currency: 'INR',
    requirement: {
      destination: r.destination_primary,
      destinations: r.destinations ?? [],
      departure_city: r.departure_city,
      travel_start_date: r.travel_start_date,
      travel_end_date: r.travel_end_date,
      travel_month: r.travel_month,
      dates_flexible: r.dates_flexible,
      flexibility_days: r.flexibility_days,
      nights: r.nights,
      days: r.days,
      adults: r.adults,
      children: r.children,
      infants: r.infants,
      child_ages: r.child_ages ?? [],
      room_count: r.room_count,
      room_configuration: r.room_configuration,
      hotel_category: r.hotel_category,
      meal_plan: r.meal_plan,
      hotel_preferences: r.hotel_preferences ?? [],
      vehicle_type: r.vehicle_type,
      pickup_location: r.pickup_location,
      drop_location: r.drop_location,
      activities: r.activities ?? [],
      special_requests: r.special_requests,
    },
    existing_quote: ctx.latestQuote
      ? {
          version: ctx.latestQuote.version,
          status: ctx.latestQuote.status,
          total_supplier_cost: ctx.latestQuote.total_supplier_cost,
          submitted_at: ctx.latestQuote.submitted_at,
          hotel_cost: ctx.latestQuote.hotel_cost,
          transport_cost: ctx.latestQuote.transport_cost,
          activities_cost: ctx.latestQuote.activities_cost,
          other_cost: ctx.latestQuote.other_cost,
          supplier_tax_amount: ctx.latestQuote.supplier_tax_amount,
          hotel_details: ctx.latestQuote.hotel_details,
          transport_details: ctx.latestQuote.transport_details,
          activity_details: ctx.latestQuote.activity_details,
          inclusions: ctx.latestQuote.inclusions,
          exclusions: ctx.latestQuote.exclusions,
          cancellation_policy: ctx.latestQuote.cancellation_policy,
          valid_until: ctx.latestQuote.valid_until,
          supplier_notes: ctx.latestQuote.supplier_notes,
        }
      : null,
    can_revise: ctx.latestQuote ? !['SELECTED', 'REJECTED'].includes(ctx.latestQuote.status) : true,
  };
}

// ------------------------------------------------------------
// Submission
// ------------------------------------------------------------

export interface SupplierQuoteInput {
  hotel_cost: string;
  transport_cost: string;
  activities_cost: string;
  other_cost: string;
  supplier_tax_amount: string;
  hotel_details: { name: string; location?: string; room_category?: string; nights?: number; meal_plan?: string }[];
  transport_details: { vehicle?: string; notes?: string };
  activity_details: { name: string; notes?: string }[];
  inclusions: string | null;
  exclusions: string | null;
  cancellation_policy: string | null;
  valid_until: string | null;
  supplier_notes: string | null;
  items: { category: SupplierQuoteItemCategory; description: string; day_number: number | null; quantity: string; unit_cost: string; amount: string }[];
}

export function parseSupplierQuoteInput(raw: unknown): SupplierQuoteInput {
  if (typeof raw !== 'object' || raw === null) throw badRequest('Invalid quote');
  const s = raw as Record<string, unknown>;
  const money = (v: unknown, field: string): string => {
    if (v === null || v === undefined || v === '') return '0.00';
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[,₹\s]/g, ''));
    if (!Number.isFinite(n) || n < 0) throw badRequest(`${field} must be a non-negative amount`);
    if (n > 99_999_999) throw badRequest(`${field} is too large`);
    return fromMinor(toMinor(n));
  };
  const text = (v: unknown, max = 4000): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

  const hotel_cost = money(s.hotel_cost, 'Hotel cost');
  const transport_cost = money(s.transport_cost, 'Transport cost');
  const activities_cost = money(s.activities_cost, 'Activities cost');
  const other_cost = money(s.other_cost, 'Other cost');
  const supplier_tax_amount = money(s.supplier_tax_amount, 'Tax');
  const totals = computeSupplierQuoteTotals({ hotelCost: hotel_cost, transportCost: transport_cost, activitiesCost: activities_cost, otherCost: other_cost, supplierTaxAmount: supplier_tax_amount });
  if (toMinor(totals.total_supplier_cost) <= 0n) throw badRequest('Quote total must be greater than zero');

  const hotels = Array.isArray(s.hotel_details)
    ? s.hotel_details
        .filter((h): h is Record<string, unknown> => typeof h === 'object' && h !== null)
        .map((h) => ({
          name: text(h.name, 200) ?? '',
          location: text(h.location, 200) ?? undefined,
          room_category: text(h.room_category, 200) ?? undefined,
          nights: typeof h.nights === 'number' ? Math.max(0, Math.round(h.nights)) : undefined,
          meal_plan: text(h.meal_plan, 50) ?? undefined,
        }))
        .filter((h) => h.name)
        .slice(0, 20)
    : [];
  const transport = typeof s.transport_details === 'object' && s.transport_details !== null ? (s.transport_details as Record<string, unknown>) : {};
  const activities = Array.isArray(s.activity_details)
    ? s.activity_details
        .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
        .map((a) => ({ name: text(a.name, 200) ?? '', notes: text(a.notes, 500) ?? undefined }))
        .filter((a) => a.name)
        .slice(0, 50)
    : [];
  const items = Array.isArray(s.items)
    ? s.items
        .filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null)
        .map((i) => {
          const category = (SUPPLIER_QUOTE_ITEM_CATEGORIES as readonly string[]).includes(String(i.category)) ? (i.category as SupplierQuoteItemCategory) : 'OTHER';
          const quantity = money(i.quantity ?? 1, 'Quantity');
          const unit = money(i.unit_cost, 'Unit cost');
          const amount = i.amount !== undefined && i.amount !== '' ? money(i.amount, 'Amount') : fromMinor((toMinor(quantity) * toMinor(unit)) / 100n);
          return { category, description: text(i.description, 300) ?? '', day_number: typeof i.day_number === 'number' ? Math.round(i.day_number) : null, quantity, unit_cost: unit, amount };
        })
        .filter((i) => i.description)
        .slice(0, 100)
    : [];
  const validUntil = typeof s.valid_until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.valid_until) ? s.valid_until : null;

  return {
    hotel_cost,
    transport_cost,
    activities_cost,
    other_cost,
    supplier_tax_amount,
    hotel_details: hotels,
    transport_details: { vehicle: text(transport.vehicle, 200) ?? undefined, notes: text(transport.notes, 1000) ?? undefined },
    activity_details: activities,
    inclusions: text(s.inclusions),
    exclusions: text(s.exclusions),
    cancellation_policy: text(s.cancellation_policy),
    valid_until: validUntil,
    supplier_notes: text(s.supplier_notes),
    items,
  };
}

/** Supplier submits (or revises) their quote through the public form. */
export async function submitSupplierQuote(token: string, raw: unknown, request?: Request | null): Promise<SupplierQuote> {
  const ctx = await resolveSupplierToken(token);
  const input = parseSupplierQuoteInput(raw);
  const admin = supabaseAdmin();
  const accountId = ctx.rfq.account_id;

  if (ctx.latestQuote && ['SELECTED', 'REJECTED'].includes(ctx.latestQuote.status)) {
    throw new TravelError('quote_locked', 'This quote has already been decided and cannot be revised', 409);
  }

  const totals = computeSupplierQuoteTotals({
    hotelCost: input.hotel_cost,
    transportCost: input.transport_cost,
    activitiesCost: input.activities_cost,
    otherCost: input.other_cost,
    supplierTaxAmount: input.supplier_tax_amount,
  });
  const version = (ctx.latestQuote?.version ?? 0) + 1;
  const now = new Date();
  const responseSeconds = ctx.rfqSupplier.sent_at ? Math.max(0, Math.round((now.getTime() - new Date(ctx.rfqSupplier.sent_at).getTime()) / 1000)) : null;

  const { data: quote, error } = await admin
    .from('supplier_quotes')
    .insert({
      account_id: accountId,
      rfq_id: ctx.rfq.id,
      rfq_supplier_id: ctx.rfqSupplier.id,
      supplier_id: ctx.supplier.id,
      travel_lead_id: ctx.lead.id,
      version,
      currency: 'INR',
      hotel_cost: input.hotel_cost,
      transport_cost: input.transport_cost,
      activities_cost: input.activities_cost,
      other_cost: input.other_cost,
      subtotal: totals.subtotal,
      supplier_tax_amount: input.supplier_tax_amount,
      total_supplier_cost: totals.total_supplier_cost,
      hotel_details: input.hotel_details,
      transport_details: input.transport_details,
      activity_details: input.activity_details,
      inclusions: input.inclusions,
      exclusions: input.exclusions,
      cancellation_policy: input.cancellation_policy,
      valid_until: input.valid_until,
      supplier_notes: input.supplier_notes,
      status: 'SUBMITTED',
      submitted_at: now.toISOString(),
      response_seconds: version === 1 ? responseSeconds : null,
    })
    .select('*')
    .single();
  if (error || !quote) throw new Error(`Failed to save quote: ${error?.message ?? 'unknown'}`);
  const saved = quote as SupplierQuote;

  if (input.items.length) {
    await admin.from('supplier_quote_items').insert(
      input.items.map((it, i) => ({ account_id: accountId, supplier_quote_id: saved.id, ...it, sort_order: i }))
    );
  }

  if (ctx.latestQuote) {
    await admin.from('supplier_quotes').update({ status: 'REVISED' }).eq('id', ctx.latestQuote.id);
  }
  await admin
    .from('rfq_suppliers')
    .update({ status: 'RESPONDED', responded_at: ctx.rfqSupplier.responded_at ?? now.toISOString(), latest_quote_id: saved.id })
    .eq('id', ctx.rfqSupplier.id);

  await recordLeadEvent(admin, {
    accountId,
    leadId: ctx.lead.id,
    type: version === 1 ? LEAD_EVENT_TYPES.SUPPLIER_QUOTE_RECEIVED : LEAD_EVENT_TYPES.SUPPLIER_QUOTE_REVISED,
    actorType: 'supplier',
    title: `${ctx.supplier.name} ${version === 1 ? 'submitted' : `revised (v${version})`} ${formatMoney(saved.total_supplier_cost)}`,
    details: { supplier_id: ctx.supplier.id, supplier_quote_id: saved.id, rfq_id: ctx.rfq.id, version, total: saved.total_supplier_cost },
    trigger: {
      automation: 'supplier_quote_received',
      webhook: 'travel.supplier_quote.received',
      contactId: ctx.lead.contact_id,
      conversationId: ctx.lead.conversation_id,
      payload: { supplier_id: ctx.supplier.id, total_supplier_cost: saved.total_supplier_cost },
    },
  });

  await refreshRfqStatus(admin, accountId, ctx.rfq.id, null);

  await notifyLeadOwners({
    accountId,
    assignedAgentId: ctx.lead.assigned_agent_id,
    type: 'travel_supplier_quote_received',
    title: `${ctx.supplier.name} quoted ${formatMoney(saved.total_supplier_cost)} for ${ctx.lead.traveller_name ?? 'traveller'}`,
    body: ctx.lead.destination_primary,
    travelLeadId: ctx.lead.id,
    conversationId: ctx.lead.conversation_id,
    contactId: ctx.lead.contact_id,
  });

  console.log('[travel/supplier-quote] submitted', { accountId, leadId: ctx.lead.id, quoteId: saved.id, version, total: saved.total_supplier_cost });

  // Threshold / all-responded → traveller notification (idempotent).
  try {
    await maybeNotifyTravellerQuotesReady(admin, accountId, ctx.rfq.id, { request: request ?? null });
  } catch (err) {
    console.error('[travel/supplier-quote] traveller notification check failed:', err instanceof Error ? err.message : err);
  }

  return saved;
}

// ------------------------------------------------------------
// Agent side
// ------------------------------------------------------------

export async function listSupplierQuotesForLead(db: SupabaseClient, accountId: string, leadId: string): Promise<SupplierQuote[]> {
  const { data } = await db
    .from('supplier_quotes')
    .select('*, supplier:suppliers(id, name, company_name, rating, preferred, supplier_type), items:supplier_quote_items(*)')
    .eq('account_id', accountId)
    .eq('travel_lead_id', leadId)
    .order('submitted_at', { ascending: false });
  return (data ?? []) as SupplierQuote[];
}

export async function setSupplierQuoteStatus(
  db: SupabaseClient,
  accountId: string,
  quoteId: string,
  status: Extract<SupplierQuoteStatus, 'SHORTLISTED' | 'REJECTED' | 'SUBMITTED'>,
  opts: { actorUserId: string | null; internalNotes?: string | null }
): Promise<SupplierQuote> {
  const { data: q } = await db.from('supplier_quotes').select('*, supplier:suppliers(name)').eq('id', quoteId).eq('account_id', accountId).maybeSingle();
  if (!q) throw notFound('Supplier quote');
  const quote = q as SupplierQuote & { supplier: { name: string } | null };
  if (quote.status === 'SELECTED') throw badRequest('This quote is already selected for a booking');
  const patch: Record<string, unknown> = { status };
  if (opts.internalNotes !== undefined) patch.internal_notes = opts.internalNotes;
  const { data, error } = await db.from('supplier_quotes').update(patch).eq('id', quoteId).select('*').single();
  if (error || !data) throw new Error(`Failed to update quote: ${error?.message}`);
  if (status === 'REJECTED') {
    await db.from('rfq_suppliers').update({ status: 'REJECTED' }).eq('id', quote.rfq_supplier_id);
  }
  await recordLeadEvent(db, {
    accountId,
    leadId: quote.travel_lead_id,
    type: LEAD_EVENT_TYPES.SUPPLIER_QUOTE_STATUS,
    actorType: 'agent',
    actorUserId: opts.actorUserId,
    title: `${quote.supplier?.name ?? 'Supplier'} quote ${status.toLowerCase()}`,
    details: { supplier_quote_id: quoteId, supplier_id: quote.supplier_id },
    oldValue: quote.status,
    newValue: status,
  });
  return data as SupplierQuote;
}

/** Items for a quote (agent side). */
export async function listSupplierQuoteItems(db: SupabaseClient, accountId: string, quoteId: string): Promise<SupplierQuoteItem[]> {
  const { data } = await db.from('supplier_quote_items').select('*').eq('account_id', accountId).eq('supplier_quote_id', quoteId).order('sort_order');
  return (data ?? []) as SupplierQuoteItem[];
}
