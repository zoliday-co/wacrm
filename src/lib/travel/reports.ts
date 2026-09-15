// ============================================================
// Reporting + dashboard aggregation.
//
// Aggregation is done in TypeScript over account-scoped rows so
// it runs under RLS (no security-definer views) and stays unit-
// testable: the `aggregate*` functions are pure and take plain
// row arrays; `loadReport` fetches and calls them.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Booking, SupplierQuote, TravelLead, TravelLeadStatus } from '@/types/travel';
import { OPEN_LEAD_STATUSES } from './constants';
import { add, fromMinor, ratioPercent, toMinor, type Minor } from './money';

export interface DateRange {
  from: string; // ISO
  to: string; // ISO
}

export function defaultRange(now = new Date()): DateRange {
  const from = new Date(now.getTime() - 30 * 86_400_000);
  return { from: from.toISOString(), to: now.toISOString() };
}

// ------------------------------------------------------------
// Funnel
// ------------------------------------------------------------

export interface FunnelReport {
  stages: { key: string; label: string; count: number; pct_of_first: string; pct_of_prev: string }[];
}

type LeadRow = Pick<TravelLead, 'id' | 'status' | 'created_at' | 'campaign_id' | 'campaign_name' | 'destination_primary' | 'assigned_agent_id' | 'source_type'>;

export function aggregateFunnel(input: {
  leads: LeadRow[];
  rfqLeadIds: Set<string>;
  quotedLeadIds: Set<string>;
  callbackLeadIds: Set<string>;
  calledLeadIds: Set<string>;
  bookedLeadIds: Set<string>;
  enquiries?: number;
}): FunnelReport {
  const leadIds = new Set(input.leads.map((l) => l.id));
  const counts = [
    { key: 'enquiries', label: 'WhatsApp enquiries', count: input.enquiries ?? input.leads.length },
    { key: 'qualified', label: 'Bot-qualified leads', count: input.leads.length },
    { key: 'rfq_sent', label: 'RFQs sent', count: [...input.rfqLeadIds].filter((id) => leadIds.has(id)).length },
    { key: 'quotes_received', label: 'Quotes received', count: [...input.quotedLeadIds].filter((id) => leadIds.has(id)).length },
    { key: 'callbacks', label: 'Callbacks requested', count: [...input.callbackLeadIds].filter((id) => leadIds.has(id)).length },
    { key: 'calls', label: 'Human calls', count: [...input.calledLeadIds].filter((id) => leadIds.has(id)).length },
    { key: 'bookings', label: 'Bookings', count: [...input.bookedLeadIds].filter((id) => leadIds.has(id)).length },
  ];
  const first = counts[0].count;
  return {
    stages: counts.map((c, i) => ({
      ...c,
      pct_of_first: pct(c.count, first),
      pct_of_prev: pct(c.count, i === 0 ? c.count : counts[i - 1].count),
    })),
  };
}

// ------------------------------------------------------------
// Group reports (campaign / destination / agent)
// ------------------------------------------------------------

export interface GroupRow {
  key: string;
  label: string;
  leads: number;
  qualified: number;
  calls: number;
  bookings: number;
  conversion_pct: string;
  revenue: string;
  gross_profit: string;
  avg_margin_pct: string;
}

type BookingRow = Pick<Booking, 'id' | 'travel_lead_id' | 'selling_price_before_tax' | 'gross_profit' | 'traveller_total' | 'status' | 'created_at' | 'selected_supplier_id' | 'supplier_cost'>;

export function aggregateByGroup(
  leads: LeadRow[],
  bookings: BookingRow[],
  callsByLead: Map<string, number>,
  keyOf: (l: LeadRow) => { key: string; label: string } | null
): GroupRow[] {
  const groups = new Map<string, { label: string; leadIds: Set<string> }>();
  for (const l of leads) {
    const k = keyOf(l);
    if (!k) continue;
    const g = groups.get(k.key) ?? { label: k.label, leadIds: new Set<string>() };
    g.leadIds.add(l.id);
    groups.set(k.key, g);
  }
  const bookingsByLead = new Map<string, BookingRow[]>();
  for (const b of bookings) {
    if (!b.travel_lead_id || b.status === 'CANCELLED') continue;
    const arr = bookingsByLead.get(b.travel_lead_id) ?? [];
    arr.push(b);
    bookingsByLead.set(b.travel_lead_id, arr);
  }
  const rows: GroupRow[] = [];
  for (const [key, g] of groups) {
    let revenue: Minor = 0n;
    let profit: Minor = 0n;
    let bookingCount = 0;
    let calls = 0;
    for (const id of g.leadIds) {
      calls += callsByLead.get(id) ?? 0;
      for (const b of bookingsByLead.get(id) ?? []) {
        bookingCount += 1;
        revenue = add(revenue, toMinor(b.selling_price_before_tax));
        profit = add(profit, toMinor(b.gross_profit));
      }
    }
    rows.push({
      key,
      label: g.label,
      leads: g.leadIds.size,
      qualified: g.leadIds.size,
      calls,
      bookings: bookingCount,
      conversion_pct: pct(bookingCount, g.leadIds.size),
      revenue: fromMinor(revenue),
      gross_profit: fromMinor(profit),
      avg_margin_pct: ratioPercent(profit, revenue),
    });
  }
  return rows.sort((a, b) => b.leads - a.leads);
}

// ------------------------------------------------------------
// Supplier performance
// ------------------------------------------------------------

export interface SupplierPerfRow {
  supplier_id: string;
  name: string;
  rfqs: number;
  responses: number;
  response_rate_pct: string;
  avg_response_hours: string | null;
  quotes_selected: number;
  selection_rate_pct: string;
  bookings: number;
  total_booking_value: string;
  avg_booking_cost: string;
  rating: string | null;
}

export function aggregateSuppliers(
  suppliers: { id: string; name: string; rating: string | null }[],
  rfqSuppliers: { supplier_id: string; status: string }[],
  quotes: Pick<SupplierQuote, 'supplier_id' | 'status' | 'response_seconds' | 'version'>[],
  bookings: BookingRow[]
): SupplierPerfRow[] {
  return suppliers
    .map((s) => {
      const rs = rfqSuppliers.filter((r) => r.supplier_id === s.id);
      const asked = rs.filter((r) => r.status !== 'PENDING').length;
      const responded = rs.filter((r) => ['RESPONDED', 'SELECTED', 'REJECTED'].includes(r.status)).length;
      const sq = quotes.filter((q) => q.supplier_id === s.id);
      const firstVersions = sq.filter((q) => q.version === 1 && q.response_seconds != null);
      const avgSeconds = firstVersions.length ? firstVersions.reduce((a, q) => a + (q.response_seconds ?? 0), 0) / firstVersions.length : null;
      const selected = sq.filter((q) => q.status === 'SELECTED').length;
      const bk = bookings.filter((b) => b.selected_supplier_id === s.id && b.status !== 'CANCELLED');
      const value = bk.reduce((acc, b) => add(acc, toMinor(b.supplier_cost)), 0n as Minor);
      return {
        supplier_id: s.id,
        name: s.name,
        rfqs: asked,
        responses: responded,
        response_rate_pct: pct(responded, asked),
        avg_response_hours: avgSeconds == null ? null : (avgSeconds / 3600).toFixed(1),
        quotes_selected: selected,
        selection_rate_pct: pct(selected, responded),
        bookings: bk.length,
        total_booking_value: fromMinor(value),
        avg_booking_cost: bk.length ? fromMinor(value / BigInt(bk.length)) : '0.00',
        rating: s.rating,
      };
    })
    .sort((a, b) => b.rfqs - a.rfqs);
}

// ------------------------------------------------------------
// Dashboard summary
// ------------------------------------------------------------

export interface DashboardSummary {
  cards: {
    new_qualified: number;
    awaiting_quotes: number;
    quotes_ready: number;
    callbacks_today: number;
    overdue_followups: number;
    bookings_this_month: number;
    revenue_this_month: string;
    gross_profit_this_month: string;
  };
  todays_calls: { task_id: string; lead_id: string | null; title: string; due_at: string | null; traveller_name: string | null; destination: string | null; assigned_to: string | null }[];
  needs_attention: { lead_id: string; traveller_name: string | null; destination: string | null; status: TravelLeadStatus; reason: string; next_action_text: string | null; last_activity_at: string }[];
  upcoming_trips: { booking_id: string; booking_number: string; traveller_name: string | null; destination: string | null; travel_start_date: string | null; nights: number | null; customer_balance: string }[];
  recent_supplier_quotes: { quote_id: string; lead_id: string; supplier_name: string; total: string; submitted_at: string; traveller_name: string | null; destination: string | null }[];
  funnel: FunnelReport;
}

export async function loadDashboard(db: SupabaseClient, accountId: string, now = new Date()): Promise<DashboardSummary> {
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart.getTime() + 86_400_000);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000).toISOString();

  const [leadsRes, tasksRes, bookingsMonthRes, upcomingRes, quotesRes, funnel] = await Promise.all([
    db.from('travel_leads').select('id, status, traveller_name, destination_primary, next_action_text, next_action_at, last_activity_at, assigned_agent_id, created_at').eq('account_id', accountId).in('status', OPEN_LEAD_STATUSES),
    db
      .from('travel_tasks')
      .select('id, travel_lead_id, title, due_at, assigned_to, task_type, status, travel_lead:travel_leads(traveller_name, destination_primary)')
      .eq('account_id', accountId)
      .in('status', ['OPEN', 'IN_PROGRESS'])
      .lte('due_at', todayEnd.toISOString())
      .order('due_at'),
    db.from('bookings').select('id, selling_price_before_tax, gross_profit, status').eq('account_id', accountId).gte('created_at', monthStart).neq('status', 'CANCELLED'),
    db
      .from('bookings')
      .select('id, booking_number, traveller_name, destination_primary, travel_start_date, nights, customer_balance')
      .eq('account_id', accountId)
      .not('status', 'in', '("CANCELLED","COMPLETED")')
      .gte('travel_start_date', todayStart.toISOString().slice(0, 10))
      .order('travel_start_date')
      .limit(8),
    db
      .from('supplier_quotes')
      .select('id, travel_lead_id, total_supplier_cost, submitted_at, supplier:suppliers(name), travel_lead:travel_leads(traveller_name, destination_primary)')
      .eq('account_id', accountId)
      .order('submitted_at', { ascending: false })
      .limit(8),
    loadFunnel(db, accountId, { from: thirtyDaysAgo, to: now.toISOString() }),
  ]);

  const leads = (leadsRes.data ?? []) as (Pick<TravelLead, 'id' | 'status' | 'traveller_name' | 'destination_primary' | 'next_action_text' | 'next_action_at' | 'last_activity_at' | 'assigned_agent_id' | 'created_at'>)[];
  const tasks = (tasksRes.data ?? []) as unknown as { id: string; travel_lead_id: string | null; title: string; due_at: string | null; assigned_to: string | null; task_type: string; travel_lead: { traveller_name: string | null; destination_primary: string | null } | null }[];

  const staleCutoff = now.getTime() - 48 * 3_600_000;
  const needsAttention = leads
    .map((l) => {
      let reason: string | null = null;
      if (l.status === 'CALLBACK_REQUESTED' && (!l.next_action_at || new Date(l.next_action_at).getTime() < now.getTime())) reason = 'Callback due';
      else if (l.status === 'QUOTES_AVAILABLE' && new Date(l.last_activity_at).getTime() < now.getTime() - 24 * 3_600_000) reason = 'Traveller not responded to quotes';
      else if (l.status === 'QUALIFIED' && new Date(l.last_activity_at).getTime() < now.getTime() - 2 * 3_600_000) reason = 'No RFQ sent';
      else if (l.status === 'REQUOTE') reason = 'Re-quote requested';
      else if (!l.assigned_agent_id && ['CALLBACK_REQUESTED', 'HUMAN_FOLLOWUP', 'NEGOTIATION'].includes(l.status)) reason = 'Unassigned';
      else if (new Date(l.last_activity_at).getTime() < staleCutoff) reason = 'No activity for 2 days';
      return reason ? { lead_id: l.id, traveller_name: l.traveller_name, destination: l.destination_primary, status: l.status, reason, next_action_text: l.next_action_text, last_activity_at: l.last_activity_at } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .slice(0, 12);

  const monthBookings = (bookingsMonthRes.data ?? []) as Pick<Booking, 'id' | 'selling_price_before_tax' | 'gross_profit' | 'status'>[];
  const revenue = monthBookings.reduce((a, b) => add(a, toMinor(b.selling_price_before_tax)), 0n as Minor);
  const profit = monthBookings.reduce((a, b) => add(a, toMinor(b.gross_profit)), 0n as Minor);

  return {
    cards: {
      new_qualified: leads.filter((l) => l.status === 'QUALIFIED').length,
      awaiting_quotes: leads.filter((l) => ['RFQ_SENT', 'AWAITING_SUPPLIER_QUOTES'].includes(l.status)).length,
      quotes_ready: leads.filter((l) => l.status === 'QUOTES_AVAILABLE').length,
      callbacks_today: tasks.filter((t) => t.task_type === 'CALLBACK' && t.due_at && new Date(t.due_at) >= todayStart && new Date(t.due_at) < todayEnd).length,
      overdue_followups: tasks.filter((t) => t.due_at && new Date(t.due_at).getTime() < now.getTime()).length,
      bookings_this_month: monthBookings.length,
      revenue_this_month: fromMinor(revenue),
      gross_profit_this_month: fromMinor(profit),
    },
    todays_calls: tasks
      .filter((t) => ['CALLBACK', 'CALL', 'FOLLOW_UP'].includes(t.task_type))
      .slice(0, 12)
      .map((t) => ({ task_id: t.id, lead_id: t.travel_lead_id, title: t.title, due_at: t.due_at, traveller_name: t.travel_lead?.traveller_name ?? null, destination: t.travel_lead?.destination_primary ?? null, assigned_to: t.assigned_to })),
    needs_attention: needsAttention,
    upcoming_trips: ((upcomingRes.data ?? []) as Pick<Booking, 'id' | 'booking_number' | 'traveller_name' | 'destination_primary' | 'travel_start_date' | 'nights' | 'customer_balance'>[]).map((b) => ({
      booking_id: b.id,
      booking_number: b.booking_number,
      traveller_name: b.traveller_name,
      destination: b.destination_primary,
      travel_start_date: b.travel_start_date,
      nights: b.nights,
      customer_balance: b.customer_balance,
    })),
    recent_supplier_quotes: ((quotesRes.data ?? []) as unknown as { id: string; travel_lead_id: string; total_supplier_cost: string; submitted_at: string; supplier: { name: string } | null; travel_lead: { traveller_name: string | null; destination_primary: string | null } | null }[]).map((q) => ({
      quote_id: q.id,
      lead_id: q.travel_lead_id,
      supplier_name: q.supplier?.name ?? 'Supplier',
      total: q.total_supplier_cost,
      submitted_at: q.submitted_at,
      traveller_name: q.travel_lead?.traveller_name ?? null,
      destination: q.travel_lead?.destination_primary ?? null,
    })),
    funnel,
  };
}

// ------------------------------------------------------------
// Loaders
// ------------------------------------------------------------

async function loadLeadsInRange(db: SupabaseClient, accountId: string, range: DateRange): Promise<LeadRow[]> {
  const { data } = await db
    .from('travel_leads')
    .select('id, status, created_at, campaign_id, campaign_name, destination_primary, assigned_agent_id, source_type')
    .eq('account_id', accountId)
    .gte('created_at', range.from)
    .lte('created_at', range.to)
    .limit(5000);
  return (data ?? []) as LeadRow[];
}

async function loadBookingsForLeads(db: SupabaseClient, accountId: string, leadIds: string[]): Promise<BookingRow[]> {
  if (!leadIds.length) return [];
  const out: BookingRow[] = [];
  for (let i = 0; i < leadIds.length; i += 500) {
    const { data } = await db
      .from('bookings')
      .select('id, travel_lead_id, selling_price_before_tax, gross_profit, traveller_total, status, created_at, selected_supplier_id, supplier_cost')
      .eq('account_id', accountId)
      .in('travel_lead_id', leadIds.slice(i, i + 500));
    out.push(...((data ?? []) as BookingRow[]));
  }
  return out;
}

async function idSet(
  db: SupabaseClient,
  table: string,
  accountId: string,
  column: string,
  extra?: { column: string; op: 'eq' | 'neq'; value: string }
): Promise<Set<string>> {
  let q = db.from(table).select(column).eq('account_id', accountId).limit(10000);
  if (extra) q = extra.op === 'eq' ? q.eq(extra.column, extra.value) : q.neq(extra.column, extra.value);
  const { data } = await q;
  return new Set(((data ?? []) as unknown as Record<string, string | null>[]).map((r) => r[column]).filter((v): v is string => !!v));
}

export async function loadFunnel(db: SupabaseClient, accountId: string, range: DateRange): Promise<FunnelReport> {
  const leads = await loadLeadsInRange(db, accountId, range);
  const [rfqLeadIds, quotedLeadIds, callbackLeadIds, calledLeadIds, bookedLeadIds, enquiriesRes] = await Promise.all([
    idSet(db, 'rfqs', accountId, 'travel_lead_id'),
    idSet(db, 'supplier_quotes', accountId, 'travel_lead_id'),
    idSet(db, 'callback_requests', accountId, 'travel_lead_id'),
    idSet(db, 'lead_interactions', accountId, 'travel_lead_id', { column: 'interaction_type', op: 'eq', value: 'CALL' }),
    idSet(db, 'bookings', accountId, 'travel_lead_id', { column: 'status', op: 'neq', value: 'CANCELLED' }),
    db.from('conversations').select('id', { count: 'exact', head: true }).eq('account_id', accountId).gte('created_at', range.from).lte('created_at', range.to),
  ]);
  return aggregateFunnel({ leads, rfqLeadIds, quotedLeadIds, callbackLeadIds, calledLeadIds, bookedLeadIds, enquiries: Math.max(enquiriesRes.count ?? 0, leads.length) });
}

export async function loadGroupReport(db: SupabaseClient, accountId: string, kind: 'campaigns' | 'destinations' | 'agents', range: DateRange): Promise<GroupRow[]> {
  const leads = await loadLeadsInRange(db, accountId, range);
  const leadIds = leads.map((l) => l.id);
  const [bookings, callsRes, membersRes] = await Promise.all([
    loadBookingsForLeads(db, accountId, leadIds),
    db.from('lead_interactions').select('travel_lead_id').eq('account_id', accountId).eq('interaction_type', 'CALL').gte('created_at', range.from).limit(10000),
    kind === 'agents' ? db.from('profiles').select('user_id, full_name').eq('account_id', accountId) : Promise.resolve({ data: [] as { user_id: string; full_name: string }[] }),
  ]);
  const callsByLead = new Map<string, number>();
  for (const c of callsRes.data ?? []) callsByLead.set(c.travel_lead_id as string, (callsByLead.get(c.travel_lead_id as string) ?? 0) + 1);
  const names = new Map(((membersRes.data ?? []) as { user_id: string; full_name: string }[]).map((m) => [m.user_id, m.full_name]));

  const keyOf = (l: LeadRow) => {
    if (kind === 'campaigns') {
      const key = l.campaign_id ?? l.campaign_name ?? (l.source_type === 'meta_whatsapp_ad' ? 'unknown_campaign' : `source:${l.source_type}`);
      return { key, label: l.campaign_name ?? (l.campaign_id ? `Campaign ${l.campaign_id}` : l.source_type === 'meta_whatsapp_ad' ? 'Meta (unattributed)' : l.source_type) };
    }
    if (kind === 'destinations') {
      const label = l.destination_primary ?? 'Unknown';
      return { key: label.toLowerCase(), label };
    }
    if (!l.assigned_agent_id) return { key: 'unassigned', label: 'Unassigned' };
    return { key: l.assigned_agent_id, label: names.get(l.assigned_agent_id) ?? 'Agent' };
  };
  return aggregateByGroup(leads, bookings, callsByLead, keyOf);
}

export async function loadSupplierReport(db: SupabaseClient, accountId: string, range: DateRange): Promise<SupplierPerfRow[]> {
  const [suppliersRes, rsRes, quotesRes, bookingsRes] = await Promise.all([
    db.from('suppliers').select('id, name, rating').eq('account_id', accountId).is('deleted_at', null),
    db.from('rfq_suppliers').select('supplier_id, status').eq('account_id', accountId).gte('created_at', range.from).lte('created_at', range.to).limit(10000),
    db.from('supplier_quotes').select('supplier_id, status, response_seconds, version').eq('account_id', accountId).gte('created_at', range.from).lte('created_at', range.to).limit(10000),
    db.from('bookings').select('id, travel_lead_id, selling_price_before_tax, gross_profit, traveller_total, status, created_at, selected_supplier_id, supplier_cost').eq('account_id', accountId).gte('created_at', range.from).lte('created_at', range.to).limit(10000),
  ]);
  return aggregateSuppliers(
    (suppliersRes.data ?? []) as { id: string; name: string; rating: string | null }[],
    (rsRes.data ?? []) as { supplier_id: string; status: string }[],
    (quotesRes.data ?? []) as Pick<SupplierQuote, 'supplier_id' | 'status' | 'response_seconds' | 'version'>[],
    (bookingsRes.data ?? []) as BookingRow[]
  );
}

function pct(a: number, b: number): string {
  if (!b) return '0.0';
  return ((a / b) * 100).toFixed(1);
}
