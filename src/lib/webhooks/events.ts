// ============================================================
// Outbound webhook event vocabulary — pure, no I/O.
//
// An endpoint subscribes to one or more of these. Adding an event is
// one entry here plus a `dispatchWebhookEvent` call at the source of
// the event (the DB stores subscriptions as a free `text[]`, so no
// migration is needed — same model as API scopes).
// ============================================================

export const WEBHOOK_EVENTS = [
  'message.received', // an inbound WhatsApp message landed
  'message.status_updated', // a sent message advanced (sent/delivered/read)
  'conversation.created', // a new conversation was opened for a contact
  // Oliday travel lifecycle (see src/lib/travel/events.ts)
  'travel.lead.qualified',
  'travel.rfq.sent',
  'travel.supplier_quote.received',
  'travel.quotes.ready',
  'travel.callback.requested',
  'travel.traveller_quote.sent',
  'travel.traveller_quote.accepted',
  'travel.booking.created',
  'travel.payment.recorded',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Human-readable descriptions (surfaced in docs / a future UI). */
export const WEBHOOK_EVENT_DESCRIPTIONS: Record<WebhookEvent, string> = {
  'message.received': 'An inbound message was received from a contact',
  'message.status_updated':
    'A message you sent changed delivery status (sent/delivered/read/failed)',
  'conversation.created': 'A new conversation was opened',
  'travel.lead.qualified': 'A travel lead was qualified by the bot',
  'travel.rfq.sent': 'An RFQ was sent to suppliers',
  'travel.supplier_quote.received': 'A supplier submitted a quote',
  'travel.quotes.ready': 'Enough supplier quotes arrived and the traveller was notified',
  'travel.callback.requested': 'A traveller requested a callback',
  'travel.traveller_quote.sent': 'A traveller quote was sent',
  'travel.traveller_quote.accepted': 'A traveller accepted a quote',
  'travel.booking.created': 'A booking was created',
  'travel.payment.recorded': 'A customer or supplier payment was recorded',
};

/** Type-narrow an unknown value into a valid `WebhookEvent`. */
export function isWebhookEvent(value: unknown): value is WebhookEvent {
  return (
    typeof value === 'string' &&
    (WEBHOOK_EVENTS as readonly string[]).includes(value)
  );
}

/**
 * Validate + de-duplicate a caller-supplied event list. Returns the
 * cleaned list, or `null` if any entry is unknown (callers turn that
 * into a 400). An empty list is rejected as `null` too — an endpoint
 * subscribed to nothing is almost certainly a mistake.
 */
export function normalizeEvents(input: unknown): WebhookEvent[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const out: WebhookEvent[] = [];
  for (const entry of input) {
    if (!isWebhookEvent(entry)) return null;
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}
