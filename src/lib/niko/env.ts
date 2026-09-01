// ============================================================
// Niko routing gate.
//
// Niko is a separate assistant from Oliday: same WhatsApp number, same
// webhook, different agent. While it is in MVP the routing is an
// explicit allow-list of phone numbers — everyone else keeps getting
// Oliday exactly as before, so a half-finished Niko can never reach a
// travel lead.
//
// NIKO_PHONE_NUMBERS: comma-separated, any format (spaces, +, dashes
// are stripped). Setting it to an empty string disables Niko entirely.
// ============================================================

import { phonesMatch } from '@/lib/whatsapp/phone-utils';

/** The MVP pilot number. Overridden wholesale by NIKO_PHONE_NUMBERS. */
const DEFAULT_ALLOW_LIST = ['919742355944'];

export function nikoAllowList(): string[] {
  const raw = process.env.NIKO_PHONE_NUMBERS;
  if (raw === undefined) return DEFAULT_ALLOW_LIST;
  return raw
    .split(',')
    .map((p) => p.replace(/\D/g, ''))
    .filter((p) => p.length >= 7);
}

/**
 * Does this inbound belong to Niko?
 *
 * Matching goes through `phonesMatch`, so a number stored with a
 * country code still matches one configured without it (it compares the
 * last 8 digits) — the same leniency the sender uses when Meta and our
 * contact rows disagree about trunk prefixes.
 */
export function isNikoPhone(phone: string | null | undefined): boolean {
  if (!phone) return false;
  return nikoAllowList().some((allowed) => phonesMatch(allowed, phone));
}
