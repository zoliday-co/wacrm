// ============================================================
// Featured event trips — limited-time trips that live as landing
// pages on the site, NOT in the packages catalog and NOT on Vibes.
// Both agents get this block in their prompt so neither denies an
// event we're actively selling ("we don't have a Dev Deepawali
// trip") — they confirm it, send the page link, and flag a
// specialist for booking.
//
// The landing page is the source of truth for prices/tiers; the
// facts here are the safe-to-quote summary. When an event passes,
// remove its entry.
// ============================================================

import { siteUrl } from './vibes-trips';

export interface FeaturedEvent {
  /** Display name, as the bot should call it. */
  name: string;
  /** Path on the site, with leading slash. */
  urlPath: string;
  /** One compact line of safe-to-quote facts (dates, place, what's
   *  in, starting price). Kept as one string so the prompt stays a
   *  single bullet per event. */
  facts: string;
  /** Matches the page's own WhatsApp-CTA prefill — deliberately
   *  narrow, like the entry-detection regexes in `entry.ts`, so a
   *  passing mention mid-chat never triggers the canned ack. */
  prefillRe: RegExp;
  /** The canned first reply for a lead who arrived FROM the page —
   *  they just left it, so it never echoes the link back. */
  ackText: string;
}

export const FEATURED_EVENTS: FeaturedEvent[] = [
  {
    name: 'Dev Deepawali 2026 — Varanasi',
    urlPath: '/dev-deepawali-2026',
    facts:
      '23–25 Nov 2026 (2N/3D) · all 84 ghats lit with lamps for the "Diwali of the gods" · hotel with breakfast, VIP temple darshan, the grand-illumination boat ride on Dev Deepawali night, Ganga aarti and private AC transfers · early-bird from ₹15,999 per person (incl. GST)',
    // "Hi Oliday! I'm interested in the Dev Deepawali Varanasi trip
    // (23–25 Nov 2026)." — spelling (Deepawali/Deepavali) tolerated.
    prefillRe: /interested in the dev\s*deepa?[wv]ali/i,
    ackText:
      'Thanks for showing interest in experiencing the magical evening of lights and fireworks from the boat on Dev Deepawali night 🪔\nSomeone from our team will reach out to you right here shortly.',
  },
];

/** The featured event whose page CTA produced this inbound, if any. */
export function matchFeaturedPrefill(text: string): FeaturedEvent | null {
  return FEATURED_EVENTS.find((e) => e.prefillRe.test(text)) ?? null;
}

export function featuredEventLink(event: FeaturedEvent): string {
  return `${siteUrl()}${event.urlPath}`;
}

/** The prompt block both agents include. Empty string when no
 *  featured events are running (callers skip pushing it then). */
export function featuredEventsSection(rule: string): string {
  if (FEATURED_EVENTS.length === 0) return '';
  const bullets = FEATURED_EVENTS.map(
    (e) => `- *${e.name}* · ${e.facts} · ${featuredEventLink(e)}`
  );
  return [
    rule,
    'FEATURED EVENT TRIPS — landing pages on our site',
    rule,
    'These limited-time event trips are NOT in the packages catalog and NOT on Vibes — each lives on its own page. When a traveller brings one up (by event name, place or dates), NEVER say we don\'t have it: confirm warmly that we run it, share its page link exactly as written below, and answer only from the facts below.',
    ...bullets,
    'If the conversation opened from an event page, qualify the traveller first. Do not mention team follow-up or resend the page until qualification is complete.',
    'The page carries the current prices and room tiers — for anything beyond these facts say the team will confirm, and set "needsSpecialist": true when they want to book one.',
  ].join('\n');
}
