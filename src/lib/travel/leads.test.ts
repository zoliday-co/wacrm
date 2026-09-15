// ============================================================
// Lead ingestion — the §64 acceptance cases:
//   - a qualified webhook creates contact + deal + lead + V1 requirement
//   - a REPEATED bot_session_id creates nothing new (idempotency)
//   - the SAME phone can raise several different leads
//   - an existing contact is reused, not duplicated
// ============================================================

import { describe, expect, it, vi, beforeEach } from 'vitest';

import { createFakeDb, baseSeed, type FakeDb } from './test-support';
import { parseQualifiedLeadPayload } from './qualified-payload';

// The event fan-out reaches the automation engine and outbound
// webhooks; neither is under test here and both need the service
// role, so they are stubbed. `supabaseAdmin` returns the same fake
// so anything written through it lands in the same store.
const adminRef: { db: FakeDb | null } = { db: null };
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => adminRef.db }));
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => adminRef.db }));
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined) }));

const { ingestQualifiedLead, listLeads, setLeadStatus } = await import('./leads');

const ACCOUNT = 'acct-1';

function payload(overrides: Record<string, unknown> = {}) {
  const parsed = parseQualifiedLeadPayload({
    bot_session_id: 'session-kerala-1',
    traveller: { name: 'Vishal', phone: '919876543210' },
    source: { type: 'meta_whatsapp_ad', campaign_name: 'Kerala October', campaign_id: 'camp-1' },
    trip: {
      destination: 'Kerala',
      destinations: ['Munnar', 'Alleppey'],
      departure_city: 'Bengaluru',
      dates: { exact: false, travel_month: 'October 2026', flexibility_days: 3 },
      nights: 5,
      days: 6,
      travellers: { adults: 4, children: 2, child_ages: [5, 8] },
      rooms: { count: 2, configuration: '2 double rooms' },
      stay: { category: '4_star', meal_plan: 'CP' },
      transport: { vehicle_type: 'Innova', pickup: 'Kochi', drop: 'Kochi' },
      budget: { amount: 80000, type: 'total' },
      qualification_summary: 'Family of 6, flexible October dates',
    },
    ...overrides,
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

function newDb(): FakeDb {
  const db = createFakeDb({ seed: baseSeed(ACCOUNT) });
  adminRef.db = db;
  return db;
}

describe('ingestQualifiedLead', () => {
  let db: FakeDb;
  beforeEach(() => {
    db = newDb();
  });

  it('creates the contact, conversation, deal, lead and V1 requirement', async () => {
    const result = await ingestQualifiedLead(db as never, ACCOUNT, payload(), { actorType: 'bot' });

    expect(result.created).toBe(true);
    expect(result.contactCreated).toBe(true);

    const contacts = db.rows('contacts');
    expect(contacts).toHaveLength(1);
    expect(contacts[0].phone).toBe('919876543210');

    // The WhatsApp thread is the existing WACRM conversation, and the
    // lead is linked to it (not to a parallel message store).
    const conversations = db.rows('conversations');
    expect(conversations).toHaveLength(1);
    expect(conversations[0].travel_lead_id).toBe(result.lead.id);

    // The deal is the pipeline entity; the lead extends it.
    const deals = db.rows('deals');
    expect(deals).toHaveLength(1);
    expect(deals[0].contact_id).toBe(contacts[0].id);
    expect(deals[0].conversation_id).toBe(conversations[0].id);

    const lead = result.lead;
    expect(lead.status).toBe('QUALIFIED');
    expect(lead.deal_id).toBe(deals[0].id);
    expect(lead.destination_primary).toBe('Kerala');
    expect(lead.nights).toBe(5);
    expect(lead.adults).toBe(4);
    expect(lead.children).toBe(2);
    expect(lead.campaign_name).toBe('Kerala October');
    expect(lead.budget_amount).toBe('80000.00');

    // Requirement V1 is the immutable record of what the bot captured.
    const versions = db.rows('travel_requirement_versions');
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
    expect(versions[0].destination_primary).toBe('Kerala');
    expect(lead.current_requirement_version_id).toBe(versions[0].id);

    // The timeline records entry + qualification.
    const events = db.rows('travel_lead_events').map((e) => e.event_type);
    expect(events).toContain('lead_created');
    expect(events).toContain('lead_qualified');
  });

  it('seeds the Oliday pipeline with keyed stages and files the deal under Qualified', async () => {
    const result = await ingestQualifiedLead(db as never, ACCOUNT, payload(), { actorType: 'bot' });

    const pipelines = db.rows('pipelines');
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0].name).toBe('Oliday Travel');

    const stages = db.rows('pipeline_stages');
    const qualified = stages.find((s) => s.stage_key === 'QUALIFIED');
    expect(qualified).toBeDefined();
    expect(stages.some((s) => s.stage_key === 'BOOKING_CONFIRMED')).toBe(true);

    const deal = db.rows('deals')[0];
    expect(deal.stage_id).toBe(qualified!.id);
    expect(deal.status).toBe('open');
    expect(result.lead.status).toBe('QUALIFIED');
  });

  it('is idempotent — a redelivered webhook creates no second lead', async () => {
    const first = await ingestQualifiedLead(db as never, ACCOUNT, payload(), { actorType: 'bot' });
    const second = await ingestQualifiedLead(db as never, ACCOUNT, payload(), { actorType: 'bot' });

    expect(second.created).toBe(false);
    expect(second.lead.id).toBe(first.lead.id);
    expect(db.rows('travel_leads')).toHaveLength(1);
    expect(db.rows('deals')).toHaveLength(1);
    expect(db.rows('contacts')).toHaveLength(1);
    expect(db.rows('travel_requirement_versions')).toHaveLength(1);
  });

  it('lets one traveller raise several enquiries — phone is not the lead key', async () => {
    const kerala = await ingestQualifiedLead(db as never, ACCOUNT, payload(), { actorType: 'bot' });
    const goa = await ingestQualifiedLead(
      db as never,
      ACCOUNT,
      payload({ bot_session_id: 'session-goa-1', trip: { destination: 'Goa', nights: 3, travellers: { adults: 2 } } }),
      { actorType: 'bot' },
    );

    expect(goa.created).toBe(true);
    expect(goa.lead.id).not.toBe(kerala.lead.id);
    expect(db.rows('travel_leads')).toHaveLength(2);
    // ...but only ONE contact: the phone identifies the person.
    expect(db.rows('contacts')).toHaveLength(1);
    expect(goa.contactCreated).toBe(false);
    expect(goa.lead.contact_id).toBe(kerala.lead.contact_id);
    expect(goa.lead.destination_primary).toBe('Goa');
  });

  it('reuses a contact that already exists in the account', async () => {
    db.setRows('contacts', [
      { id: 'contact-existing', account_id: ACCOUNT, user_id: 'user-owner', phone: '919876543210', phone_normalized: '919876543210', name: 'Vishal R' },
    ]);

    const result = await ingestQualifiedLead(db as never, ACCOUNT, payload(), { actorType: 'bot' });

    expect(result.contactCreated).toBe(false);
    expect(result.lead.contact_id).toBe('contact-existing');
    expect(db.rows('contacts')).toHaveLength(1);
  });
});

describe('lead status transitions', () => {
  it('moves the linked deal stage and marks it won at booking', async () => {
    const db = newDb();
    const { lead } = await ingestQualifiedLead(db as never, ACCOUNT, payload(), { actorType: 'bot' });

    await setLeadStatus(db as never, ACCOUNT, lead.id, 'BOOKING_CONFIRMED', { actorType: 'agent', actorUserId: 'user-agent' });

    const stages = db.rows('pipeline_stages');
    const confirmed = stages.find((s) => s.stage_key === 'BOOKING_CONFIRMED');
    const deal = db.rows('deals')[0];
    expect(deal.stage_id).toBe(confirmed!.id);
    expect(deal.status).toBe('won');

    const stored = db.rows('travel_leads')[0];
    expect(stored.status).toBe('BOOKING_CONFIRMED');
    expect(stored.closed_at).toBeTruthy();

    const changes = db.rows('travel_lead_events').filter((e) => e.event_type === 'status_changed');
    expect(changes.at(-1)?.new_value).toBe('BOOKING_CONFIRMED');
  });

  it('records a lost reason and marks the deal lost', async () => {
    const db = newDb();
    const { lead } = await ingestQualifiedLead(db as never, ACCOUNT, payload(), { actorType: 'bot' });

    await setLeadStatus(db as never, ACCOUNT, lead.id, 'LOST', { actorType: 'agent', actorUserId: 'user-agent', reason: 'Booked elsewhere' });

    expect(db.rows('travel_leads')[0].lost_reason).toBe('Booked elsewhere');
    expect(db.rows('deals')[0].status).toBe('lost');
  });
});

describe('listLeads', () => {
  it('scopes to the account and excludes closed leads by default', async () => {
    const db = newDb();
    const open = await ingestQualifiedLead(db as never, ACCOUNT, payload(), { actorType: 'bot' });
    const closed = await ingestQualifiedLead(db as never, ACCOUNT, payload({ bot_session_id: 'session-2' }), { actorType: 'bot' });
    await setLeadStatus(db as never, ACCOUNT, closed.lead.id, 'LOST', { actorType: 'agent' });

    // A lead belonging to another tenant must never appear.
    db.rows('travel_leads').push({ id: 'foreign', account_id: 'other-account', status: 'QUALIFIED', last_activity_at: new Date().toISOString() });

    const result = await listLeads(db as never, ACCOUNT, { status: 'open' }, 'user-agent');
    expect(result.leads.map((l) => l.id)).toEqual([open.lead.id]);
  });
});
