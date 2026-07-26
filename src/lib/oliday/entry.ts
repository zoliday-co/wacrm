// ============================================================
// Entry-context detection (§6): how did this enquiry arrive?
//
//   'deal_link' — the deal-page CTA deep link, with title/nights/
//                 destination embedded in the prefilled text
//   'ad'       — click-to-WhatsApp ad (Meta sends `referral` on the
//                first webhook message)
//   'site_cta' — the site's generic floating-button prefill
//   'cold'     — anything else
//
// Detected once per conversation and stored on
// `conversations.entry_context`; a deal link also pre-fills trip
// slots so the bot never re-asks what the link already said.
// ============================================================

import type { Trip } from './trip';
import { resolveRegion } from './regions';

export type EntryContext = 'deal_link' | 'ad' | 'site_cta' | 'cold';

/**
 * Deal deep-link prefill:
 *   Hi Oliday! I'm interested in the "<title>" deal (<N>N/<D>D, <dest>). Can you help?
 * Quote style and apostrophes vary by platform, so both are matched
 * loosely.
 */
const DEAL_LINK_RE =
  /interested in the ["“](.+?)["”] deal \((\d{1,2})N\/(\d{1,2})D,\s*([^)]+)\)/i;

/** The site's generic floating-button prefill. */
const SITE_CTA_RE = /hi oliday! i have a question about planning a trip/i;

export interface DealLinkInfo {
  title: string;
  nights: number;
  days: number;
  destination: string;
}

export function parseDealLink(text: string): DealLinkInfo | null {
  const m = DEAL_LINK_RE.exec(text);
  if (!m) return null;
  const nights = Number(m[2]);
  const days = Number(m[3]);
  if (!Number.isFinite(nights) || nights < 1 || nights > 30) return null;
  return {
    title: m[1].trim(),
    nights,
    days,
    destination: m[4].trim(),
  };
}

export function detectEntryContext(
  firstInboundText: string,
  referral: unknown
): EntryContext {
  if (referral && typeof referral === 'object') return 'ad';
  if (DEAL_LINK_RE.test(firstInboundText)) return 'deal_link';
  if (SITE_CTA_RE.test(firstInboundText)) return 'site_cta';
  return 'cold';
}

/** Pre-fill trip slots from a deal deep link so the bot goes straight
 *  to dates + pax instead of restarting discovery (§6 context 2). */
export function tripFromDealLink(deal: DealLinkInfo): Partial<Trip> {
  const resolved = resolveRegion(deal.destination);
  return {
    destination: deal.destination,
    region: resolved?.region,
    nights: deal.nights,
  };
}
