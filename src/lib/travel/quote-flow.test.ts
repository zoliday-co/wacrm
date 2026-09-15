// ============================================================
// The money-carrying half of the lifecycle, end to end:
//   RFQ → secure supplier form → quotes → traveller quote →
//   acceptance → booking snapshot → payments.
//
// Covers the §64 cases for RFQs (generation, recipients, token
// security, expiry), supplier quotes (valid accepted, unauthorized
// rejected, revisions preserved) and bookings (one booking per
// accepted quote, supplier linked, financials snapshotted).
// ============================================================

import { describe, expect, it, vi, beforeEach } from 'vitest';

import { createFakeDb, baseSeed, type FakeDb } from './test-support';
import { parseQualifiedLeadPayload } from './qualified-payload';
import { generateTravelToken } from './tokens';

const adminRef: { db: FakeDb | null } = { db: null };
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => adminRef.db }));
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => adminRef.db }));
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined) }));

// Outbound WhatsApp is exercised by its own suite; here it always
// succeeds so the flow under test isn't gated on Meta.
const sendMock = vi.fn().mockResolvedValue({ ok: true, messageId: 'msg-1', whatsappMessageId: 'wamid-1', via: 'text' });
vi.mock('./whatsapp', () => ({
  sendTravelWhatsApp: (...args: unknown[]) => sendMock(...args),
  resolveSupplierConversation: vi.fn().mockResolvedValue({ conversationId: 'conv-supplier', contactId: 'contact-supplier' }),
}));

const { ingestQualifiedLead } = await import('./leads');
const { createRfqForLead } = await import('./rfq');
const { resolveSupplierToken, submitSupplierQuote, parseSupplierQuoteInput, listSupplierQuotesForLead } = await import('./supplier-quotes');
const { createTravellerQuote, acceptTravellerQuote } = await import('./traveller-quotes');
const { recordCustomerPayment, recordSupplierPayment, getBooking } = await import('./bookings');

const ACCOUNT = 'acct-1';

function seedWithSuppliers(): FakeDb {
  const seed = baseSeed(ACCOUNT);
  seed.destinations = [
    { id: 'dest-kerala', account_id: ACCOUNT, name: 'Kerala', slug: 'kerala', parent_id: null, aliases: [], active: true },
    { id: 'dest-munnar', account_id: ACCOUNT, name: 'Munnar', slug: 'munnar', parent_id: 'dest-kerala', aliases: [], active: true },
  ];
  seed.suppliers = [
    { id: 'sup-green', account_id: ACCOUNT, name: 'GreenLeaf Travels', status: 'ACTIVE', supplier_type: 'DMC', active: true, preferred: true, rating: '4.5', deleted_at: null, whatsapp_phone: '919000000001', phone: null, contact_id: null, metadata: {} },
    { id: 'sup-routes', account_id: ACCOUNT, name: 'Kerala Routes', status: 'ACTIVE', supplier_type: 'DMC', active: true, preferred: false, rating: '4.0', deleted_at: null, whatsapp_phone: '919000000002', phone: null, contact_id: null, metadata: {} },
    { id: 'sup-south', account_id: ACCOUNT, name: 'South DMC', status: 'ACTIVE', supplier_type: 'DMC', active: true, preferred: false, rating: '3.5', deleted_at: null, whatsapp_phone: '919000000003', phone: null, contact_id: null, metadata: {} },
    // Must never be matched: inactive.
    { id: 'sup-dormant', account_id: ACCOUNT, name: 'Dormant DMC', status: 'INACTIVE', supplier_type: 'DMC', active: false, preferred: true, rating: '5.0', deleted_at: null, whatsapp_phone: '919000000004', phone: null, contact_id: null, metadata: {} },
  ];
  seed.supplier_destinations = ['sup-green', 'sup-routes', 'sup-south', 'sup-dormant'].map((supplier_id, i) => ({
    id: `sd-${i}`,
    account_id: ACCOUNT,
    supplier_id,
    destination_id: 'dest-kerala',
    priority: 100,
    preferred: false,
    active: true,
    service_types: [],
  }));
  const db = createFakeDb({ seed });
  adminRef.db = db;
  return db;
}

async function makeLead(db: FakeDb, botSession = 'session-1') {
  const parsed = parseQualifiedLeadPayload({
    bot_session_id: botSession,
    traveller: { name: 'Vishal', phone: '919876543210' },
    source: { type: 'meta_whatsapp_ad', campaign_name: 'Kerala October' },
    trip: {
      destination: 'Kerala',
      destinations: ['Munnar'],
      nights: 5,
      days: 6,
      travellers: { adults: 4, children: 2, child_ages: [5, 8] },
      stay: { category: '4_star', meal_plan: 'CP' },
      transport: { vehicle_type: 'Innova', pickup: 'Kochi', drop: 'Kochi' },
      budget: { amount: 80000, type: 'total' },
      dates: { travel_month: 'October 2026', flexibility_days: 3 },
    },
  });
  if (!parsed.ok) throw new Error(parsed.error);
  const { lead } = await ingestQualifiedLead(db as never, ACCOUNT, parsed.value, { actorType: 'bot' });
  return lead;
}

/** The plaintext token for a recipient — mirrors what the send embeds in the link. */
function tokenFor(db: FakeDb, rfqSupplierId: string): string {
  const t = generateTravelToken('supplier_quote', 72);
  const row = db.rows('rfq_suppliers').find((r) => r.id === rfqSupplierId)!;
  row.quote_token_hash = t.hash;
  row.quote_token_expires_at = t.expiresAt;
  row.quote_token_revoked_at = null;
  return t.token;
}

const QUOTE = {
  hotel_cost: 32000,
  transport_cost: 18000,
  activities_cost: 8000,
  other_cost: 2000,
  supplier_tax_amount: 0,
  hotel_details: [{ name: 'Munnar Tea Resort', room_category: 'Deluxe' }],
  transport_details: { vehicle: 'Innova' },
  activity_details: [{ name: 'Houseboat' }],
  inclusions: 'Breakfast, sightseeing',
  exclusions: 'Airfare',
  cancellation_policy: '50% up to 7 days',
  supplier_notes: 'Best available',
  items: [],
};

describe('RFQ generation', () => {
  let db: FakeDb;
  beforeEach(() => {
    db = seedWithSuppliers();
    sendMock.mockClear();
  });

  it('matches active destination suppliers, mints one token each, and sends', async () => {
    const lead = await makeLead(db);
    const result = await createRfqForLead(db as never, ACCOUNT, lead.id, { actorUserId: null, send: true });

    expect(result.rfq.version).toBe(1);
    const recipients = db.rows('rfq_suppliers');
    // The inactive supplier is excluded even though it is "preferred".
    expect(recipients).toHaveLength(3);
    expect(recipients.map((r) => r.supplier_id).sort()).toEqual(['sup-green', 'sup-routes', 'sup-south']);
    // Preferred supplier ranks first.
    expect(recipients[0].supplier_id).toBe('sup-green');

    // Every recipient carries a distinct hashed token with an expiry —
    // never a plaintext one.
    const hashes = recipients.map((r) => r.quote_token_hash as string);
    expect(new Set(hashes).size).toBe(3);
    for (const r of recipients) {
      expect(r.quote_token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.quote_token_expires_at).toBeTruthy();
      expect(r.status).toBe('SENT');
    }
    expect(sendMock).toHaveBeenCalledTimes(3);

    // The RFQ is pinned to the requirement version it was built from.
    expect(result.rfq.requirement_version_id).toBe(lead.current_requirement_version_id);

    const stored = db.rows('travel_leads')[0];
    expect(stored.status).toBe('AWAITING_SUPPLIER_QUOTES');
  });

  it('honours an explicit supplier list over the matcher', async () => {
    const lead = await makeLead(db);
    await createRfqForLead(db as never, ACCOUNT, lead.id, { actorUserId: 'user-agent', supplierIds: ['sup-routes'], send: false });

    const recipients = db.rows('rfq_suppliers');
    expect(recipients).toHaveLength(1);
    expect(recipients[0].supplier_id).toBe('sup-routes');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('never exposes traveller identity in the supplier message', async () => {
    const lead = await makeLead(db);
    await createRfqForLead(db as never, ACCOUNT, lead.id, { actorUserId: null, send: true });

    for (const call of sendMock.mock.calls) {
      const text = String((call[0] as { text: string }).text);
      expect(text).not.toContain('Vishal');
      expect(text).not.toContain('919876543210');
      expect(text).not.toContain('Kerala October'); // campaign is internal
      // ...but it does carry what a supplier needs to quote.
      expect(text).toContain('Kerala');
      expect(text).toContain('4 Adults + 2 Children');
    }
  });
});

describe('supplier quote form token', () => {
  let db: FakeDb;
  beforeEach(() => {
    db = seedWithSuppliers();
    sendMock.mockClear();
  });

  it('rejects an unknown, malformed, expired or revoked token', async () => {
    const lead = await makeLead(db);
    await createRfqForLead(db as never, ACCOUNT, lead.id, { actorUserId: null, send: true });
    const recipient = db.rows('rfq_suppliers')[0];

    await expect(resolveSupplierToken('not-a-token')).rejects.toThrow(/not valid/i);
    await expect(resolveSupplierToken(generateTravelToken('supplier_quote', 1).token)).rejects.toThrow(/not valid/i);

    const live = tokenFor(db, recipient.id as string);
    await expect(resolveSupplierToken(live)).resolves.toBeTruthy();

    recipient.quote_token_expires_at = new Date(Date.now() - 1000).toISOString();
    await expect(resolveSupplierToken(live)).rejects.toThrow(/expired/i);

    recipient.quote_token_expires_at = new Date(Date.now() + 86_400_000).toISOString();
    recipient.quote_token_revoked_at = new Date().toISOString();
    await expect(resolveSupplierToken(live)).rejects.toThrow(/withdrawn/i);
  });

  it('shows one supplier only their own RFQ, never the traveller or other suppliers', async () => {
    const lead = await makeLead(db);
    await createRfqForLead(db as never, ACCOUNT, lead.id, { actorUserId: null, send: true });
    const recipient = db.rows('rfq_suppliers')[0];
    const ctx = await resolveSupplierToken(tokenFor(db, recipient.id as string));

    expect(ctx.supplier.id).toBe(recipient.supplier_id);
    expect(ctx.rfqSupplier.id).toBe(recipient.id);
    const serialised = JSON.stringify(ctx.requirement);
    expect(serialised).not.toContain('919876543210');
    expect(serialised).not.toContain('Vishal');
  });
});

describe('supplier quote submission', () => {
  let db: FakeDb;
  beforeEach(() => {
    db = seedWithSuppliers();
    sendMock.mockClear();
  });

  it('accepts a valid quote, totals it exactly, and marks the recipient responded', async () => {
    const lead = await makeLead(db);
    await createRfqForLead(db as never, ACCOUNT, lead.id, { actorUserId: null, send: true });
    const recipient = db.rows('rfq_suppliers')[0];
    const token = tokenFor(db, recipient.id as string);

    const quote = await submitSupplierQuote(token, QUOTE);

    expect(quote.version).toBe(1);
    expect(quote.subtotal).toBe('60000.00');
    expect(quote.total_supplier_cost).toBe('60000.00');
    expect(quote.status).toBe('SUBMITTED');

    const stored = db.rows('rfq_suppliers').find((r) => r.id === recipient.id)!;
    expect(stored.status).toBe('RESPONDED');
    expect(stored.latest_quote_id).toBe(quote.id);
    expect(stored.responded_at).toBeTruthy();

    const events = db.rows('travel_lead_events').map((e) => e.event_type);
    expect(events).toContain('supplier_quote_received');
  });

  it('rejects a zero or negative quote', async () => {
    expect(() => parseSupplierQuoteInput({ ...QUOTE, hotel_cost: 0, transport_cost: 0, activities_cost: 0, other_cost: 0 })).toThrow(/greater than zero/i);
    expect(() => parseSupplierQuoteInput({ ...QUOTE, hotel_cost: -5 })).toThrow(/non-negative/i);
  });

  it('keeps every revision — the old row becomes REVISED, never overwritten', async () => {
    const lead = await makeLead(db);
    await createRfqForLead(db as never, ACCOUNT, lead.id, { actorUserId: null, send: true });
    const recipient = db.rows('rfq_suppliers')[0];
    const token = tokenFor(db, recipient.id as string);

    const first = await submitSupplierQuote(token, QUOTE);
    const second = await submitSupplierQuote(token, { ...QUOTE, hotel_cost: 29000 });

    expect(second.version).toBe(2);
    expect(second.total_supplier_cost).toBe('57000.00');

    const all = db.rows('supplier_quotes');
    expect(all).toHaveLength(2);
    const original = all.find((q) => q.id === first.id)!;
    expect(original.status).toBe('REVISED');
    // The original figures are still recoverable.
    expect(original.total_supplier_cost).toBe('60000.00');
    expect(db.rows('rfq_suppliers').find((r) => r.id === recipient.id)!.latest_quote_id).toBe(second.id);
  });

  it('refuses a revision once the quote has been decided', async () => {
    const lead = await makeLead(db);
    await createRfqForLead(db as never, ACCOUNT, lead.id, { actorUserId: null, send: true });
    const recipient = db.rows('rfq_suppliers')[0];
    const token = tokenFor(db, recipient.id as string);
    const quote = await submitSupplierQuote(token, QUOTE);

    db.rows('supplier_quotes').find((q) => q.id === quote.id)!.status = 'SELECTED';
    await expect(submitSupplierQuote(token, QUOTE)).rejects.toThrow(/already been decided/i);
  });

  it('notifies the traveller once the minimum number of quotes arrives', async () => {
    const lead = await makeLead(db);
    await createRfqForLead(db as never, ACCOUNT, lead.id, { actorUserId: null, send: true });
    const recipients = db.rows('rfq_suppliers');
    sendMock.mockClear();

    // Default threshold is 3.
    await submitSupplierQuote(tokenFor(db, recipients[0].id as string), QUOTE);
    expect(db.rows('travel_leads')[0].status).toBe('AWAITING_SUPPLIER_QUOTES');

    await submitSupplierQuote(tokenFor(db, recipients[1].id as string), { ...QUOTE, hotel_cost: 29000 });
    expect(db.rows('travel_leads')[0].status).toBe('AWAITING_SUPPLIER_QUOTES');

    await submitSupplierQuote(tokenFor(db, recipients[2].id as string), { ...QUOTE, hotel_cost: 35000 });

    const lead2 = db.rows('travel_leads')[0];
    expect(lead2.status).toBe('QUOTES_AVAILABLE');
    // The traveller got a message carrying a callback link.
    const travellerSend = sendMock.mock.calls.at(-1)?.[0] as { text: string };
    expect(travellerSend.text).toContain('/trip/callback/');
    expect(db.rows('rfqs')[0].traveller_notified_at).toBeTruthy();

    const quotes = await listSupplierQuotesForLead(db as never, ACCOUNT, lead.id);
    expect(quotes).toHaveLength(3);
  });
});

describe('traveller quote and booking', () => {
  let db: FakeDb;
  beforeEach(() => {
    db = seedWithSuppliers();
    sendMock.mockClear();
  });

  async function leadWithQuote() {
    const lead = await makeLead(db);
    await createRfqForLead(db as never, ACCOUNT, lead.id, { actorUserId: null, send: true });
    const recipient = db.rows('rfq_suppliers')[0];
    const supplierQuote = await submitSupplierQuote(tokenFor(db, recipient.id as string), QUOTE);
    return { lead, supplierQuote };
  }

  it('prices a traveller quote from the supplier cost, keeping GST out of profit', async () => {
    const { lead, supplierQuote } = await leadWithQuote();

    const quote = await createTravellerQuote(
      db as never,
      ACCOUNT,
      lead.id,
      { supplier_quote_id: supplierQuote.id, markup_type: 'fixed', markup_value: 10000 },
      'user-agent',
    );

    expect(quote.supplier_cost).toBe('60000.00');
    expect(quote.markup_amount).toBe('10000.00');
    expect(quote.selling_price_before_tax).toBe('70000.00');
    // Default 5% GST on the selling price.
    expect(quote.gst_amount).toBe('3500.00');
    expect(quote.traveller_total).toBe('73500.00');
    // Gross profit is the markup — the collected GST is not ours.
    expect(quote.gross_profit).toBe('10000.00');
    expect(quote.margin_pct).toBe('14.29');
    expect(quote.status).toBe('DRAFT');
  });

  it('creates exactly one booking per accepted quote and snapshots the money', async () => {
    const { lead, supplierQuote } = await leadWithQuote();
    const quote = await createTravellerQuote(
      db as never,
      ACCOUNT,
      lead.id,
      { supplier_quote_id: supplierQuote.id, markup_type: 'fixed', markup_value: 10000 },
      'user-agent',
    );

    const first = await acceptTravellerQuote(db as never, ACCOUNT, quote.id, { actorUserId: 'user-agent', actorType: 'agent' });
    const second = await acceptTravellerQuote(db as never, ACCOUNT, quote.id, { actorUserId: 'user-agent', actorType: 'agent' });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(db.rows('bookings')).toHaveLength(1);

    const booking = first.booking!;
    expect(booking.booking_number).toMatch(/^OLI-\d{4}-\d{5}$/);
    expect(booking.selected_supplier_id).toBe('sup-green');
    expect(booking.supplier_quote_id).toBe(supplierQuote.id);
    expect(booking.traveller_quote_id).toBe(quote.id);

    // Immutable financial snapshot.
    expect(booking.supplier_cost).toBe('60000.00');
    expect(booking.selling_price_before_tax).toBe('70000.00');
    expect(booking.gst_amount).toBe('3500.00');
    expect(booking.traveller_total).toBe('73500.00');
    expect(booking.gross_profit).toBe('10000.00');
    expect((booking.financial_snapshot as { traveller_quote: { version: number } }).traveller_quote.version).toBe(1);
    expect(booking.requirement_snapshot).toBeTruthy();
    expect(booking.supplier_quote_snapshot).toBeTruthy();

    // The chosen supplier wins; the rest are closed out.
    expect(db.rows('supplier_quotes').find((q) => q.id === supplierQuote.id)!.status).toBe('SELECTED');
    expect(db.rows('rfqs')[0].status).toBe('CLOSED');

    // Lead and deal both land on booked.
    expect(db.rows('travel_leads')[0].status).toBe('BOOKING_CONFIRMED');
    expect(db.rows('deals')[0].status).toBe('won');
    expect(db.rows('deals')[0].value).toBe('73500.00');
  });

  it('refuses to accept a quote that is awaiting approval', async () => {
    const { lead, supplierQuote } = await leadWithQuote();
    // Require approval below a 20% margin, then quote at ~14%.
    db.rows('travel_settings')[0].margin_approval_pct = '20.00';

    const quote = await createTravellerQuote(
      db as never,
      ACCOUNT,
      lead.id,
      { supplier_quote_id: supplierQuote.id, markup_type: 'fixed', markup_value: 10000 },
      'user-agent',
    );

    expect(quote.approval_status).toBe('pending');
    await expect(acceptTravellerQuote(db as never, ACCOUNT, quote.id, { actorUserId: 'user-agent', actorType: 'agent' })).rejects.toThrow(/approval/i);
    expect(db.rows('bookings')).toHaveLength(0);
  });

  it('tracks customer and supplier balances from the payment rows', async () => {
    const { lead, supplierQuote } = await leadWithQuote();
    const quote = await createTravellerQuote(
      db as never,
      ACCOUNT,
      lead.id,
      { supplier_quote_id: supplierQuote.id, markup_type: 'fixed', markup_value: 10000 },
      'user-agent',
    );
    const { booking } = await acceptTravellerQuote(db as never, ACCOUNT, quote.id, { actorUserId: 'user-agent', actorType: 'agent' });

    await recordCustomerPayment(db as never, ACCOUNT, booking!.id, { amount: '30000.00', payment_method: 'UPI' }, 'user-agent');
    await recordSupplierPayment(db as never, ACCOUNT, booking!.id, { amount: '20000.00', payment_method: 'BANK_TRANSFER', status: 'PAID' }, 'user-agent');

    const fresh = await getBooking(db as never, ACCOUNT, booking!.id);
    expect(fresh.customer_payments).toHaveLength(1);
    expect(fresh.supplier_payments).toHaveLength(1);

    const events = db.rows('travel_lead_events').map((e) => e.event_type);
    expect(events).toContain('customer_payment_received');
    expect(events).toContain('supplier_payment_made');
  });
});
