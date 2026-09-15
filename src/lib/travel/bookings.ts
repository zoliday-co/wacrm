// ============================================================
// Bookings + payments.
//
// `createBookingFromQuote` snapshots every financial figure from
// the ACCEPTED traveller quote (and the selected supplier quote,
// requirement and itinerary) into the booking row. Reports read
// bookings, never re-derive from quotes that may change later.
// Balances are maintained by DB triggers on the payment tables
// (migration 047); this module only inserts payment rows and
// re-reads.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Booking,
  BookingStatus,
  CustomerPayment,
  CustomerPaymentStatus,
  Itinerary,
  PaymentMethod,
  SupplierPayment,
  SupplierPaymentStatus,
  SupplierQuote,
  TravellerQuote,
  TravelLead,
} from '@/types/travel';
import { LEAD_EVENT_TYPES } from './constants';
import { recordLeadEvent } from './events';
import { badRequest, notFound } from './errors';
import { bookingFinancialView } from './financials';
import { formatMoney, fromMinor, toMinor } from './money';
import { pickRequirement } from './requirements';
import { getLead, setLeadStatus } from './leads';
import { createTask } from './tasks';

const PAYMENT_METHODS: PaymentMethod[] = ['UPI', 'BANK_TRANSFER', 'PAYMENT_GATEWAY', 'CASH', 'CARD', 'OTHER'];

/**
 * Create the booking for an accepted traveller quote. Idempotent:
 * the partial unique index on bookings.traveller_quote_id means a
 * second call returns the existing booking.
 */
export async function createBookingFromQuote(
  db: SupabaseClient,
  accountId: string,
  quote: TravellerQuote,
  opts: { actorUserId: string | null; actorType?: 'agent' | 'traveller' | 'system' }
): Promise<{ booking: Booking; created: boolean }> {
  const { data: existing } = await db.from('bookings').select('*').eq('traveller_quote_id', quote.id).eq('account_id', accountId).maybeSingle();
  if (existing) return { booking: existing as Booking, created: false };

  const lead = await getLead(db, accountId, quote.travel_lead_id);
  let supplierQuote: SupplierQuote | null = null;
  if (quote.supplier_quote_id) {
    const { data } = await db.from('supplier_quotes').select('*, items:supplier_quote_items(*)').eq('id', quote.supplier_quote_id).maybeSingle();
    supplierQuote = (data as SupplierQuote | null) ?? null;
  }
  // Latest FINAL itinerary (or the one linked to the quote, or newest draft).
  const { data: itins } = await db
    .from('itineraries')
    .select('*, days:itinerary_days(*)')
    .eq('travel_lead_id', lead.id)
    .eq('account_id', accountId)
    .order('version', { ascending: false });
  const itineraries = (itins ?? []) as Itinerary[];
  const itinerary =
    itineraries.find((i) => i.traveller_quote_id === quote.id) ??
    itineraries.find((i) => i.status === 'FINAL') ??
    itineraries[0] ??
    null;

  const { data: numberRow, error: numErr } = await db.rpc('next_booking_number', { p_account_id: accountId, p_prefix: 'OLI' });
  if (numErr || !numberRow) throw new Error(`Failed to allocate booking number: ${numErr?.message ?? 'unknown'}`);
  const bookingNumber = String(numberRow);

  const financialSnapshot = {
    traveller_quote: {
      id: quote.id,
      version: quote.version,
      supplier_cost: quote.supplier_cost,
      markup_type: quote.markup_type,
      markup_value: quote.markup_value,
      markup_amount: quote.markup_amount,
      discount_amount: quote.discount_amount,
      selling_price_before_tax: quote.selling_price_before_tax,
      gst_rate: quote.gst_rate,
      gst_taxable_base: quote.gst_taxable_base,
      gst_taxable_amount: quote.gst_taxable_amount,
      gst_amount: quote.gst_amount,
      traveller_total: quote.traveller_total,
      gross_profit: quote.gross_profit,
      margin_pct: quote.margin_pct,
    },
    snapshot_at: new Date().toISOString(),
  };

  const { data: booking, error } = await db
    .from('bookings')
    .insert({
      account_id: accountId,
      booking_number: bookingNumber,
      travel_lead_id: lead.id,
      contact_id: lead.contact_id,
      deal_id: lead.deal_id,
      selected_supplier_id: supplierQuote?.supplier_id ?? null,
      supplier_quote_id: supplierQuote?.id ?? null,
      traveller_quote_id: quote.id,
      itinerary_id: itinerary?.id ?? null,
      traveller_name: lead.traveller_name,
      destination_primary: lead.destination_primary,
      travel_start_date: lead.travel_start_date,
      travel_end_date: lead.travel_end_date,
      nights: lead.nights,
      adults: lead.adults,
      children: lead.children,
      infants: lead.infants,
      status: 'CONFIRMED',
      currency: quote.currency,
      supplier_cost: quote.supplier_cost,
      markup_amount: quote.markup_amount,
      discount_amount: quote.discount_amount,
      selling_price_before_tax: quote.selling_price_before_tax,
      gst_rate: quote.gst_rate,
      gst_taxable_amount: quote.gst_taxable_amount,
      gst_amount: quote.gst_amount,
      traveller_total: quote.traveller_total,
      gross_profit: quote.gross_profit,
      margin_pct: quote.margin_pct,
      financial_snapshot: financialSnapshot,
      itinerary_snapshot: itinerary,
      requirement_snapshot: pickRequirement(lead as unknown as Record<string, unknown>),
      supplier_quote_snapshot: supplierQuote,
      created_by: opts.actorUserId,
    })
    .select('*')
    .single();
  if (error || !booking) {
    if (/duplicate key|23505/.test(error?.message ?? '')) {
      const { data: raced } = await db.from('bookings').select('*').eq('traveller_quote_id', quote.id).maybeSingle();
      if (raced) return { booking: raced as Booking, created: false };
    }
    throw new Error(`Failed to create booking: ${error?.message ?? 'unknown'}`);
  }
  const created = booking as Booking;

  // Supplier quote → SELECTED; siblings on the same RFQ → REJECTED.
  if (supplierQuote) {
    await db.from('supplier_quotes').update({ status: 'SELECTED' }).eq('id', supplierQuote.id);
    await db.from('rfq_suppliers').update({ status: 'SELECTED' }).eq('id', supplierQuote.rfq_supplier_id);
    await db
      .from('supplier_quotes')
      .update({ status: 'REJECTED' })
      .eq('rfq_id', supplierQuote.rfq_id)
      .neq('id', supplierQuote.id)
      .in('status', ['SUBMITTED', 'SHORTLISTED']);
    await db.from('rfq_suppliers').update({ status: 'REJECTED' }).eq('rfq_id', supplierQuote.rfq_id).neq('id', supplierQuote.rfq_supplier_id).in('status', ['RESPONDED', 'SENT', 'PENDING']);
    await db.from('rfqs').update({ status: 'CLOSED', closed_at: new Date().toISOString() }).eq('id', supplierQuote.rfq_id);
    await recordLeadEvent(db, {
      accountId,
      leadId: lead.id,
      type: LEAD_EVENT_TYPES.SUPPLIER_SELECTED,
      actorType: opts.actorType ?? 'system',
      actorUserId: opts.actorUserId,
      title: `Supplier selected for booking (${formatMoney(supplierQuote.total_supplier_cost)})`,
      details: { supplier_id: supplierQuote.supplier_id, supplier_quote_id: supplierQuote.id },
    });
  }
  if (itinerary) await db.from('itineraries').update({ status: 'FINAL' }).eq('id', itinerary.id);

  await setLeadStatus(db, accountId, lead.id, 'BOOKING_CONFIRMED', {
    actorType: opts.actorType ?? 'system',
    actorUserId: opts.actorUserId,
    nextAction: { text: 'Collect advance payment' },
  });
  if (lead.deal_id) {
    await db.from('deals').update({ value: created.traveller_total, status: 'won' }).eq('id', lead.deal_id);
  }

  await recordLeadEvent(db, {
    accountId,
    leadId: lead.id,
    type: LEAD_EVENT_TYPES.BOOKING_CREATED,
    actorType: opts.actorType ?? 'system',
    actorUserId: opts.actorUserId,
    title: `Booking ${bookingNumber} created — ${formatMoney(created.traveller_total)}`,
    details: { booking_id: created.id, booking_number: bookingNumber, traveller_total: created.traveller_total, gross_profit: created.gross_profit },
    trigger: {
      automation: 'booking_created',
      webhook: 'travel.booking.created',
      contactId: lead.contact_id,
      conversationId: lead.conversation_id,
      payload: { booking_id: created.id, booking_number: bookingNumber, traveller_total: created.traveller_total },
    },
  });

  await createTask(db, accountId, {
    travelLeadId: lead.id,
    bookingId: created.id,
    title: `Collect advance payment — ${bookingNumber}`,
    taskType: 'PAYMENT',
    assignedTo: lead.assigned_agent_id,
    priority: 'HIGH',
    dueAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
    sourceKey: `booking-advance:${created.id}`,
    createdBy: opts.actorUserId,
    logEvent: false,
  });

  console.log('[travel/booking] created', { accountId, bookingId: created.id, bookingNumber, leadId: lead.id });
  return { booking: created, created: true };
}

export async function getBooking(db: SupabaseClient, accountId: string, bookingId: string): Promise<Booking> {
  const { data } = await db
    .from('bookings')
    .select('*, supplier:suppliers(id, name, company_name, phone, whatsapp_phone), contact:contacts(id, name, phone), customer_payments(*), supplier_payments(*), items:booking_items(*)')
    .eq('id', bookingId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (!data) throw notFound('Booking');
  const b = data as Booking;
  b.customer_payments = (b.customer_payments ?? []).sort((a, c) => (a.payment_date < c.payment_date ? 1 : -1));
  b.supplier_payments = (b.supplier_payments ?? []).sort((a, c) => (a.created_at < c.created_at ? 1 : -1));
  return b;
}

export interface BookingFilters {
  status?: BookingStatus | 'open' | 'all';
  from?: string | null;
  to?: string | null;
  q?: string | null;
  limit?: number;
}

export async function listBookings(db: SupabaseClient, accountId: string, f: BookingFilters): Promise<Booking[]> {
  let q = db
    .from('bookings')
    .select('*, supplier:suppliers(id, name)')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .limit(Math.min(500, f.limit ?? 200));
  if (f.status && f.status !== 'all') {
    if (f.status === 'open') q = q.not('status', 'in', '("COMPLETED","CANCELLED")');
    else q = q.eq('status', f.status);
  }
  if (f.from) q = q.gte('travel_start_date', f.from);
  if (f.to) q = q.lte('travel_start_date', f.to);
  if (f.q) q = q.or(`traveller_name.ilike.%${f.q}%,booking_number.ilike.%${f.q}%,destination_primary.ilike.%${f.q}%`);
  const { data } = await q;
  return (data ?? []) as Booking[];
}

/** Bookings overlapping a date range — feeds the trip calendar. */
export async function listBookingsForCalendar(db: SupabaseClient, accountId: string, from: string, to: string): Promise<Booking[]> {
  const { data } = await db
    .from('bookings')
    .select('id, booking_number, traveller_name, destination_primary, travel_start_date, travel_end_date, nights, adults, children, status, traveller_total, customer_balance, supplier:suppliers(id, name)')
    .eq('account_id', accountId)
    .neq('status', 'CANCELLED')
    .not('travel_start_date', 'is', null)
    .lte('travel_start_date', to)
    .or(`travel_end_date.gte.${from},travel_end_date.is.null`)
    .order('travel_start_date');
  return (data ?? []) as unknown as Booking[];
}

export async function setBookingStatus(
  db: SupabaseClient,
  accountId: string,
  bookingId: string,
  status: BookingStatus,
  opts: { actorUserId: string | null; reason?: string | null }
): Promise<Booking> {
  const booking = await getBooking(db, accountId, bookingId);
  if (booking.status === 'CANCELLED') throw badRequest('Booking is cancelled');
  const patch: Record<string, unknown> = { status };
  if (status === 'COMPLETED') patch.completed_at = new Date().toISOString();
  if (status === 'CANCELLED') {
    patch.cancelled_at = new Date().toISOString();
    patch.cancellation_reason = opts.reason ?? null;
  }
  const { data, error } = await db.from('bookings').update(patch).eq('id', bookingId).select('*').single();
  if (error || !data) throw new Error(`Failed to update booking: ${error?.message}`);
  if (booking.travel_lead_id) {
    await recordLeadEvent(db, {
      accountId,
      leadId: booking.travel_lead_id,
      type: status === 'CANCELLED' ? LEAD_EVENT_TYPES.BOOKING_CANCELLED : LEAD_EVENT_TYPES.BOOKING_STATUS,
      actorType: opts.actorUserId ? 'agent' : 'system',
      actorUserId: opts.actorUserId,
      title: `Booking ${booking.booking_number} → ${status.replace(/_/g, ' ').toLowerCase()}${opts.reason ? ` (${opts.reason})` : ''}`,
      details: { booking_id: bookingId, reason: opts.reason ?? null },
      oldValue: booking.status,
      newValue: status,
    });
  }
  return data as Booking;
}

// ------------------------------------------------------------
// Payments
// ------------------------------------------------------------

export interface CustomerPaymentInput {
  amount: string;
  payment_method: PaymentMethod;
  transaction_reference?: string | null;
  payment_status?: CustomerPaymentStatus;
  payment_date?: string | null;
  notes?: string | null;
}

export function parseCustomerPaymentInput(raw: unknown): CustomerPaymentInput {
  if (typeof raw !== 'object' || raw === null) throw badRequest('Invalid payment');
  const s = raw as Record<string, unknown>;
  const amount = toMinor(typeof s.amount === 'number' ? s.amount : String(s.amount ?? ''));
  if (amount <= 0n) throw badRequest('Amount must be greater than zero');
  const method = PAYMENT_METHODS.includes(s.payment_method as PaymentMethod) ? (s.payment_method as PaymentMethod) : 'UPI';
  const statuses: CustomerPaymentStatus[] = ['PENDING', 'RECEIVED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED'];
  const status = statuses.includes(s.payment_status as CustomerPaymentStatus) ? (s.payment_status as CustomerPaymentStatus) : 'RECEIVED';
  return {
    amount: fromMinor(amount),
    payment_method: method,
    transaction_reference: typeof s.transaction_reference === 'string' ? s.transaction_reference.trim().slice(0, 200) || null : null,
    payment_status: status,
    payment_date: typeof s.payment_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.payment_date) ? s.payment_date : null,
    notes: typeof s.notes === 'string' ? s.notes.trim().slice(0, 2000) || null : null,
  };
}

export async function recordCustomerPayment(
  db: SupabaseClient,
  accountId: string,
  bookingId: string,
  input: CustomerPaymentInput,
  actorUserId: string | null
): Promise<{ payment: CustomerPayment; booking: Booking }> {
  const booking = await getBooking(db, accountId, bookingId);
  if (booking.status === 'CANCELLED') throw badRequest('Booking is cancelled');
  const { data, error } = await db
    .from('customer_payments')
    .insert({
      account_id: accountId,
      booking_id: bookingId,
      amount: input.amount,
      currency: booking.currency,
      payment_method: input.payment_method,
      transaction_reference: input.transaction_reference ?? null,
      payment_status: input.payment_status ?? 'RECEIVED',
      payment_date: input.payment_date ?? new Date().toISOString().slice(0, 10),
      notes: input.notes ?? null,
      created_by: actorUserId,
    })
    .select('*')
    .single();
  if (error || !data) throw new Error(`Failed to record payment: ${error?.message}`);
  const payment = data as CustomerPayment;
  const fresh = await getBooking(db, accountId, bookingId);
  if (booking.travel_lead_id) {
    await recordLeadEvent(db, {
      accountId,
      leadId: booking.travel_lead_id,
      type: LEAD_EVENT_TYPES.CUSTOMER_PAYMENT_RECEIVED,
      actorType: 'agent',
      actorUserId,
      title: `Customer payment ${payment.payment_status.toLowerCase()}: ${formatMoney(payment.amount)} via ${payment.payment_method}`,
      details: { booking_id: bookingId, payment_id: payment.id, amount: payment.amount, balance: fresh.customer_balance },
      trigger: { webhook: 'travel.payment.recorded', contactId: booking.contact_id, payload: { kind: 'customer', amount: payment.amount, booking_id: bookingId } },
    });
  }
  // Close the "collect advance" task once money arrives.
  if (payment.payment_status === 'RECEIVED') {
    await db
      .from('travel_tasks')
      .update({ status: 'DONE', completed_at: new Date().toISOString() })
      .eq('account_id', accountId)
      .eq('source_key', `booking-advance:${bookingId}`)
      .in('status', ['OPEN', 'IN_PROGRESS']);
  }
  return { payment, booking: fresh };
}

export interface SupplierPaymentInput {
  amount: string;
  payment_method: PaymentMethod;
  transaction_reference?: string | null;
  status?: SupplierPaymentStatus;
  due_date?: string | null;
  paid_at?: string | null;
  notes?: string | null;
}

export function parseSupplierPaymentInput(raw: unknown): SupplierPaymentInput {
  if (typeof raw !== 'object' || raw === null) throw badRequest('Invalid payment');
  const s = raw as Record<string, unknown>;
  const amount = toMinor(typeof s.amount === 'number' ? s.amount : String(s.amount ?? ''));
  if (amount <= 0n) throw badRequest('Amount must be greater than zero');
  const method = PAYMENT_METHODS.includes(s.payment_method as PaymentMethod) ? (s.payment_method as PaymentMethod) : 'BANK_TRANSFER';
  const statuses: SupplierPaymentStatus[] = ['SCHEDULED', 'PAID', 'FAILED', 'CANCELLED'];
  const status = statuses.includes(s.status as SupplierPaymentStatus) ? (s.status as SupplierPaymentStatus) : 'PAID';
  return {
    amount: fromMinor(amount),
    payment_method: method,
    transaction_reference: typeof s.transaction_reference === 'string' ? s.transaction_reference.trim().slice(0, 200) || null : null,
    status,
    due_date: typeof s.due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.due_date) ? s.due_date : null,
    paid_at: status === 'PAID' ? new Date().toISOString() : null,
    notes: typeof s.notes === 'string' ? s.notes.trim().slice(0, 2000) || null : null,
  };
}

export async function recordSupplierPayment(
  db: SupabaseClient,
  accountId: string,
  bookingId: string,
  input: SupplierPaymentInput,
  actorUserId: string | null
): Promise<{ payment: SupplierPayment; booking: Booking }> {
  const booking = await getBooking(db, accountId, bookingId);
  if (booking.status === 'CANCELLED') throw badRequest('Booking is cancelled');
  const { data, error } = await db
    .from('supplier_payments')
    .insert({
      account_id: accountId,
      booking_id: bookingId,
      supplier_id: booking.selected_supplier_id,
      amount: input.amount,
      currency: booking.currency,
      payment_method: input.payment_method,
      transaction_reference: input.transaction_reference ?? null,
      status: input.status ?? 'PAID',
      due_date: input.due_date ?? null,
      paid_at: input.paid_at ?? null,
      notes: input.notes ?? null,
      created_by: actorUserId,
    })
    .select('*')
    .single();
  if (error || !data) throw new Error(`Failed to record supplier payment: ${error?.message}`);
  const payment = data as SupplierPayment;
  const fresh = await getBooking(db, accountId, bookingId);
  if (booking.travel_lead_id) {
    await recordLeadEvent(db, {
      accountId,
      leadId: booking.travel_lead_id,
      type: LEAD_EVENT_TYPES.SUPPLIER_PAYMENT_MADE,
      actorType: 'agent',
      actorUserId,
      title: `Supplier payment ${payment.status.toLowerCase()}: ${formatMoney(payment.amount)}`,
      details: { booking_id: bookingId, payment_id: payment.id, amount: payment.amount, supplier_balance: fresh.supplier_balance },
      trigger: { webhook: 'travel.payment.recorded', contactId: booking.contact_id, payload: { kind: 'supplier', amount: payment.amount, booking_id: bookingId } },
    });
  }
  if (payment.status === 'SCHEDULED' && payment.due_date) {
    await createTask(db, accountId, {
      travelLeadId: booking.travel_lead_id,
      bookingId,
      title: `Pay supplier ${formatMoney(payment.amount)} — ${booking.booking_number}`,
      taskType: 'PAYMENT',
      priority: 'HIGH',
      dueAt: `${payment.due_date}T09:00:00+05:30`,
      sourceKey: `supplier-payment:${payment.id}`,
      createdBy: actorUserId,
      logEvent: false,
    });
  }
  return { payment, booking: fresh };
}

export async function listPayments(
  db: SupabaseClient,
  accountId: string,
  f: { kind?: 'customer' | 'supplier' | 'all'; from?: string | null; to?: string | null; limit?: number }
): Promise<{ customer: CustomerPayment[]; supplier: SupplierPayment[] }> {
  const limit = Math.min(500, f.limit ?? 200);
  const out = { customer: [] as CustomerPayment[], supplier: [] as SupplierPayment[] };
  if (f.kind !== 'supplier') {
    let q = db
      .from('customer_payments')
      .select('*, booking:bookings(id, booking_number, traveller_name)')
      .eq('account_id', accountId)
      .order('payment_date', { ascending: false })
      .limit(limit);
    if (f.from) q = q.gte('payment_date', f.from);
    if (f.to) q = q.lte('payment_date', f.to);
    const { data } = await q;
    out.customer = (data ?? []) as CustomerPayment[];
  }
  if (f.kind !== 'customer') {
    let q = db
      .from('supplier_payments')
      .select('*, booking:bookings(id, booking_number, traveller_name), supplier:suppliers(id, name)')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (f.from) q = q.gte('created_at', f.from);
    if (f.to) q = q.lte('created_at', `${f.to}T23:59:59Z`);
    const { data } = await q;
    out.supplier = (data ?? []) as SupplierPayment[];
  }
  return out;
}

/** The three-block financial view the booking page renders. */
export function bookingFinancials(b: Booking) {
  return bookingFinancialView(b);
}

/**
 * Cron: roll booking statuses by travel dates —
 * FULLY_PAID/CONFIRMED… → UPCOMING (7 days out) → ONGOING → COMPLETED.
 */
export async function rollBookingStatuses(admin: SupabaseClient, now = new Date()): Promise<number> {
  const today = now.toISOString().slice(0, 10);
  const soon = new Date(now.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
  let changed = 0;
  const { data: rows } = await admin
    .from('bookings')
    .select('id, account_id, travel_lead_id, booking_number, status, travel_start_date, travel_end_date')
    .not('status', 'in', '("CANCELLED","COMPLETED")')
    .not('travel_start_date', 'is', null);
  for (const b of rows ?? []) {
    const start = b.travel_start_date as string;
    const end = (b.travel_end_date as string | null) ?? start;
    let next: BookingStatus | null = null;
    if (end < today) next = 'COMPLETED';
    else if (start <= today) next = 'ONGOING';
    else if (start <= soon && ['FULLY_PAID'].includes(b.status as string)) next = 'UPCOMING';
    if (next && next !== b.status) {
      await admin.from('bookings').update({ status: next, completed_at: next === 'COMPLETED' ? now.toISOString() : null }).eq('id', b.id);
      changed += 1;
      if (b.travel_lead_id) {
        await recordLeadEvent(admin, {
          accountId: b.account_id as string,
          leadId: b.travel_lead_id as string,
          type: LEAD_EVENT_TYPES.BOOKING_STATUS,
          title: `Booking ${b.booking_number} → ${next.toLowerCase()}`,
          details: { booking_id: b.id },
          oldValue: b.status,
          newValue: next,
        });
      }
    }
  }
  return changed;
}

export type { TravelLead };
