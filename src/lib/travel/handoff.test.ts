// ============================================================
// The human-handoff half of the lifecycle:
//   quotes ready → traveller picks a call slot → callback + task
//   + agent notification → agent logs the call → requirement
//   revised → RFQ V2 off the NEW requirement version.
//
// Covers acceptance steps 12–19 and §27's auditability rule that a
// re-quote must never overwrite the original requirement.
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

const sendMock = vi.fn().mockResolvedValue({ ok: true, messageId: 'msg-1', whatsappMessageId: 'wamid-1', via: 'text' });
vi.mock('./whatsapp', () => ({
  sendTravelWhatsApp: (...args: unknown[]) => sendMock(...args),
  resolveSupplierConversation: vi.fn().mockResolvedValue({ conversationId: 'conv-supplier', contactId: 'contact-supplier' }),
}));

const { ingestQualifiedLead, assignLead } = await import('./leads');
const { createRfqForLead } = await import('./rfq');
const { notifyTravellerQuotesReady, createCallbackRequest, resolveCallbackToken, scheduledAtFor, parseCallbackInput } = await import('./callbacks');
const { createInteraction } = await import('./interactions');
const { reviseRequirement, listRequirementVersions } = await import('./requirements');
const { scheduleFollowUp, runTaskReminders, updateTask } = await import('./tasks');

const ACCOUNT = 'acct-1';

function newDb(): FakeDb {
  const seed = baseSeed(ACCOUNT);
  seed.destinations = [{ id: 'dest-kerala', account_id: ACCOUNT, name: 'Kerala', slug: 'kerala', parent_id: null, aliases: [], active: true }];
  seed.suppliers = [{ id: 'sup-1', account_id: ACCOUNT, name: 'GreenLeaf', status: 'ACTIVE', supplier_type: 'DMC', active: true, preferred: false, rating: '4.0', deleted_at: null, whatsapp_phone: '919000000001', phone: null, contact_id: null, metadata: {} }];
  seed.supplier_destinations = [{ id: 'sd-1', account_id: ACCOUNT, supplier_id: 'sup-1', destination_id: 'dest-kerala', priority: 100, preferred: false, active: true, service_types: [] }];
  const db = createFakeDb({ seed });
  adminRef.db = db;
  return db;
}

async function makeLead(db: FakeDb) {
  const parsed = parseQualifiedLeadPayload({
    bot_session_id: 'session-1',
    traveller: { name: 'Vishal', phone: '919876543210' },
    source: { type: 'meta_whatsapp_ad' },
    trip: { destination: 'Kerala', nights: 5, travellers: { adults: 4, children: 2 }, stay: { category: '4_star' }, budget: { amount: 80000, type: 'total' } },
  });
  if (!parsed.ok) throw new Error(parsed.error);
  const { lead } = await ingestQualifiedLead(db as never, ACCOUNT, parsed.value, { actorType: 'bot' });
  return lead;
}

/** The callback token the traveller receives in the "quotes ready" link. */
function latestCallbackToken(db: FakeDb): string {
  const t = generateTravelToken('callback', 168);
  const row = db.rows('travel_access_tokens').filter((r) => r.kind === 'callback').at(-1)!;
  row.token_hash = t.hash;
  return t.token;
}

describe('traveller callback', () => {
  let db: FakeDb;
  beforeEach(() => {
    db = newDb();
    sendMock.mockClear();
  });

  it('parses a slot choice and turns it into a concrete IST time', () => {
    const input = parseCallbackInput({ time_window: 'SPECIFIC', preferred_date: '2026-10-16', preferred_time: '11:00' });
    // 11:00 IST is 05:30 UTC.
    expect(scheduledAtFor(input)).toBe('2026-10-16T05:30:00.000Z');

    const morning = parseCallbackInput({ time_window: 'MORNING', preferred_date: '2026-10-16' });
    expect(scheduledAtFor(morning)).toBe('2026-10-16T04:30:00.000Z');

    expect(() => parseCallbackInput({ time_window: 'SPECIFIC', preferred_date: '2026-10-16' })).toThrow(/date and time/i);
    expect(() => parseCallbackInput({ time_window: 'NONSENSE' })).toThrow(/choose a time/i);
  });

  it('rejects an unknown or expired callback link', async () => {
    await expect(resolveCallbackToken('nope')).rejects.toThrow(/not valid/i);
    await expect(resolveCallbackToken(generateTravelToken('callback', 1).token)).rejects.toThrow(/not valid/i);
  });

  it('books the slot, raises a task for the agent, and moves the lead', async () => {
    const lead = await makeLead(db);
    await assignLead(db as never, ACCOUNT, lead.id, 'user-agent', 'user-owner');
    await notifyTravellerQuotesReady(db as never, ACCOUNT, lead.id, { actorUserId: null, reason: 'test' });

    expect(db.rows('travel_leads')[0].status).toBe('QUOTES_AVAILABLE');
    const token = latestCallbackToken(db);

    const callback = await createCallbackRequest(token, { time_window: 'SPECIFIC', preferred_date: '2026-10-16', preferred_time: '11:00', note: 'Prefer after lunch' });

    expect(callback.status).toBe('SCHEDULED');
    expect(callback.scheduled_at).toBe('2026-10-16T05:30:00.000Z');
    expect(callback.assigned_agent_id).toBe('user-agent');

    // A callback task lands on the assignee, and the lead's next action
    // says what has to happen.
    const tasks = db.rows('travel_tasks').filter((t) => t.task_type === 'CALLBACK');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].assigned_to).toBe('user-agent');
    expect(tasks[0].due_at).toBe('2026-10-16T05:30:00.000Z');

    const stored = db.rows('travel_leads')[0];
    expect(stored.status).toBe('CALLBACK_REQUESTED');
    expect(String(stored.next_action_text)).toContain('Call');

    // The assigned agent is notified.
    const notes = db.rows('notifications').filter((n) => n.type === 'travel_callback_requested');
    expect(notes).toHaveLength(1);
    expect(notes[0].user_id).toBe('user-agent');

    const events = db.rows('travel_lead_events').map((e) => e.event_type);
    expect(events).toContain('callback_requested');
  });

  it('closes the callback task when the agent logs the call', async () => {
    const lead = await makeLead(db);
    await assignLead(db as never, ACCOUNT, lead.id, 'user-agent', 'user-owner');
    await notifyTravellerQuotesReady(db as never, ACCOUNT, lead.id, { actorUserId: null });
    await createCallbackRequest(latestCallbackToken(db), { time_window: 'MORNING', preferred_date: '2026-10-16' });

    await createInteraction(
      db as never,
      ACCOUNT,
      lead.id,
      { interaction_type: 'CALL', summary: 'Wants a better Munnar resort', details: 'Budget can stretch to 90k', outcome: 'Re-quote' },
      'user-agent',
    );

    expect(db.rows('travel_leads')[0].status).toBe('HUMAN_FOLLOWUP');
    expect(db.rows('callback_requests')[0].status).toBe('COMPLETED');
    expect(db.rows('travel_tasks').find((t) => t.task_type === 'CALLBACK')!.status).toBe('DONE');

    const interactions = db.rows('lead_interactions');
    expect(interactions).toHaveLength(1);
    expect(interactions[0].details).toBe('Budget can stretch to 90k');
  });

  it('schedules a follow-up from a call and reminds the agent when it falls due', async () => {
    const lead = await makeLead(db);
    await assignLead(db as never, ACCOUNT, lead.id, 'user-agent', 'user-owner');

    const dueAt = new Date(Date.now() - 60_000).toISOString(); // already due
    await createInteraction(
      db as never,
      ACCOUNT,
      lead.id,
      { interaction_type: 'CALL', summary: 'Sent options', next_follow_up_at: dueAt },
      'user-agent',
    );

    const followUp = db.rows('travel_tasks').find((t) => t.task_type === 'FOLLOW_UP')!;
    expect(followUp.assigned_to).toBe('user-agent');
    expect(db.rows('travel_leads')[0].next_action_at).toBe(dueAt);

    const sent = await runTaskReminders(db as never);
    expect(sent).toBe(1);
    const reminder = db.rows('notifications').find((n) => n.type === 'travel_task_due');
    expect(reminder?.user_id).toBe('user-agent');

    // The reminder fires once, not on every cron tick.
    expect(await runTaskReminders(db as never)).toBe(0);
  });

  it('re-arms the reminder when a follow-up is rescheduled', async () => {
    const lead = await makeLead(db);
    const task = await scheduleFollowUp(db as never, ACCOUNT, lead.id, {
      dueAt: new Date(Date.now() - 60_000).toISOString(),
      assignedTo: 'user-agent',
      actorUserId: 'user-agent',
    });
    expect(await runTaskReminders(db as never)).toBe(1);

    await updateTask(db as never, ACCOUNT, task.id, { due_at: new Date(Date.now() - 30_000).toISOString() }, 'user-agent');
    expect(db.rows('travel_tasks')[0].reminded_at).toBeNull();
    expect(await runTaskReminders(db as never)).toBe(1);
  });
});

describe('requirement revision and re-quote', () => {
  let db: FakeDb;
  beforeEach(() => {
    db = newDb();
    sendMock.mockClear();
  });

  it('appends V2 without touching V1 and logs exactly what changed', async () => {
    const lead = await makeLead(db);

    const { version, lead: updated } = await reviseRequirement(
      db as never,
      ACCOUNT,
      lead.id,
      { hotel_category: '5_star', budget_amount: '90000.00' },
      { reason: 'Customer wants a premium Munnar resort', actorUserId: 'user-agent' },
    );

    expect(version.version).toBe(2);
    expect(updated.current_requirement_version).toBe(2);
    expect(updated.hotel_category).toBe('5_star');
    expect(updated.budget_amount).toBe('90000.00');

    const versions = await listRequirementVersions(db as never, ACCOUNT, lead.id);
    expect(versions).toHaveLength(2);
    const v1 = versions.find((v) => v.version === 1)!;
    // V1 is untouched — the original ask is still recoverable.
    expect(v1.hotel_category).toBe('4_star');
    expect(v1.budget_amount).toBe('80000.00');
    expect(v1.change_reason).toBe('Qualified by WhatsApp bot');

    const event = db.rows('travel_lead_events').find((e) => e.event_type === 'requirement_modified')!;
    expect((event.details as { changed_fields: string[] }).changed_fields.sort()).toEqual(['budget_amount', 'hotel_category']);
    expect((event.old_value as { hotel_category: string }).hotel_category).toBe('4_star');
    expect((event.new_value as { hotel_category: string }).hotel_category).toBe('5_star');
  });

  it('refuses a no-op revision', async () => {
    const lead = await makeLead(db);
    await expect(
      reviseRequirement(db as never, ACCOUNT, lead.id, { hotel_category: '4_star' }, { reason: 'none', actorUserId: 'user-agent' }),
    ).rejects.toThrow(/No requirement fields changed/i);
  });

  it('builds RFQ V2 from the NEW requirement version and closes V1', async () => {
    const lead = await makeLead(db);
    const v1Rfq = await createRfqForLead(db as never, ACCOUNT, lead.id, { actorUserId: null, send: true });
    expect(v1Rfq.rfq.version).toBe(1);

    const { version } = await reviseRequirement(
      db as never,
      ACCOUNT,
      lead.id,
      { hotel_category: '5_star' },
      { reason: 'Premium resort', actorUserId: 'user-agent' },
    );

    const v2Rfq = await createRfqForLead(db as never, ACCOUNT, lead.id, { actorUserId: 'user-agent', send: true });

    expect(v2Rfq.rfq.version).toBe(2);
    // Each RFQ is pinned to the requirement it was generated from.
    expect(v2Rfq.rfq.requirement_version_id).toBe(version.id);
    expect(v2Rfq.rfq.requirement_version_id).not.toBe(v1Rfq.rfq.requirement_version_id);

    // The superseded RFQ is closed, not deleted.
    const rfqs = db.rows('rfqs');
    expect(rfqs).toHaveLength(2);
    expect(rfqs.find((r) => r.id === v1Rfq.rfq.id)!.status).toBe('CLOSED');

    // The supplier sees the revised requirement in the V2 message.
    const lastSend = sendMock.mock.calls.at(-1)?.[0] as { text: string };
    expect(lastSend.text).toContain('Revised');
    expect(lastSend.text).toContain('5 Star');
  });
});
