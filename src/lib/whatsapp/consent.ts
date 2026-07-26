// ============================================================
// Opt-out / opt-in keyword detection (migration 037).
//
// Consent language promised on the web forms: "You can opt out any
// time by replying STOP on WhatsApp." Matching is deliberately
// strict — the whole message (trimmed, case-insensitive) must BE the
// keyword, not merely contain it, so "please don't stop the booking"
// never unsubscribes anyone.
// ============================================================

const OPT_OUT_KEYWORDS = new Set([
  'stop',
  'unsubscribe',
  'opt out',
  'opt-out',
  'optout',
]);

const OPT_IN_KEYWORDS = new Set(['start', 'unstop', 'subscribe']);

export function isOptOutKeyword(text: string): boolean {
  return OPT_OUT_KEYWORDS.has(text.trim().toLowerCase());
}

export function isOptInKeyword(text: string): boolean {
  return OPT_IN_KEYWORDS.has(text.trim().toLowerCase());
}
