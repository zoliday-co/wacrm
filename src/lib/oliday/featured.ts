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
}

export const FEATURED_EVENTS: FeaturedEvent[] = [
  {
    name: 'Dev Deepawali 2026 — Varanasi',
    urlPath: '/dev-deepawali-2026',
    facts:
      '23–25 Nov 2026 (2N/3D) · all 84 ghats lit with lamps for the "Diwali of the gods" · hotel with breakfast, VIP temple darshan, the grand-illumination boat ride on Dev Deepawali night, Ganga aarti and private AC transfers · early-bird from ₹15,999 per person (incl. GST)',
  },
];

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
    'These limited-time event trips are NOT in the packages catalog and NOT on Vibes — each lives on its own page. When a traveller asks about one (by event name, place or dates), NEVER say we don\'t have it: confirm warmly that we run it, share its page link exactly as written below, and answer only from the facts below.',
    ...bullets,
    'The page carries the current prices and room tiers — point them there for anything beyond these facts, and set "needsSpecialist": true when they want to book one (booking happens via the page\'s callback form and our team, right here on WhatsApp).',
  ].join('\n');
}
