// ============================================================
// WhatsApp-facing rendering of catalog rows.
//
// One place turns route/hotels JSONB into the short lines the bot
// sends, so every card looks the same:
//
//   *Kashmir Delight — 5N/6D*
//   Srinagar 2N → Gulmarg 1N → Pahalgam 2N
//   3★ hotels · breakfast + dinner · SUV (6 seats)
//   ₹24,300 per person (for 4 travellers)
// ============================================================

import type { PerPersonQuote } from './pricing';

interface RouteStop {
  destination?: string;
  nights?: number;
}

interface HotelStay {
  destination?: string;
  nights?: number;
  name?: string;
  star?: number;
  meal_plan?: string;
  room_type?: string;
}

/** Meal-plan codes → plain English, always translated for the
 *  traveller (EP/CP/MAP/AP mean nothing to them). */
export function mealPlanEnglish(
  code: string | null | undefined
): string | null {
  if (!code) return null;
  const c = code.trim().toUpperCase();
  switch (c) {
    case 'EP':
      return 'room only';
    case 'CP':
      return 'breakfast';
    case 'MAP':
      return 'breakfast + dinner';
    case 'AP':
      return 'all meals';
    default:
      // Already-English values ("Breakfast") pass through, lowered.
      return code.trim().toLowerCase();
  }
}

/** "Srinagar 2N → Gulmarg 1N → Pahalgam 2N" */
export function routeLine(route: unknown): string {
  if (!Array.isArray(route)) return '';
  return (route as RouteStop[])
    .filter((s) => s && typeof s.destination === 'string')
    .map(
      (s) => `${s.destination}${usableNights(s.nights) ? ` ${s.nights}N` : ''}`
    )
    .join(' → ');
}

/** "3★ TGS Dine Inn (Port Blair) · 4★ Sea Shell (Havelock)" */
export function hotelsLine(hotels: unknown): string {
  if (!Array.isArray(hotels)) return '';
  return (hotels as HotelStay[])
    .filter((h) => h && typeof h.name === 'string')
    .map((h) => {
      const star = usableStar(h.star) ? `${h.star}★ ` : '';
      const where = h.destination ? ` (${h.destination})` : '';
      return `${star}${h.name}${where}`;
    })
    .join(' · ');
}

/** Average hotel star of a package (search scoring input). */
export function averageStar(hotels: unknown): number | null {
  if (!Array.isArray(hotels)) return null;
  const stars = (hotels as HotelStay[]).map((h) => h?.star).filter(usableStar);
  if (stars.length === 0) return null;
  return stars.reduce((a, b) => a + b, 0) / stars.length;
}

/** Dominant meal plan across a package's hotels, in plain English. */
export function packageMealPlanEnglish(hotels: unknown): string | null {
  if (!Array.isArray(hotels)) return null;
  for (const h of hotels as HotelStay[]) {
    const english = mealPlanEnglish(h?.meal_plan);
    if (english) return english;
  }
  return null;
}

/** Indian-grouped rupees: 24300 → "₹24,300". Never used with an
 *  emoji — price lines stay plain (§6). */
export function formatInr(amount: number): string {
  return `₹${Math.round(amount).toLocaleString('en-IN')}`;
}

/** The per-person price sentence, honest about its basis: the party
 *  size it was computed for, and the starting-price caveat when the
 *  matrix had nothing. */
export function perPersonLine(quote: PerPersonQuote, pax: number): string {
  if (quote.isStartingPriceFallback) {
    return `${formatInr(quote.price)} per person (2-person double-sharing rate — group price to be confirmed)`;
  }
  const forPax =
    quote.basisPax === pax
      ? `for ${pax} travellers`
      : `${quote.basisPax}-person group rate`;
  return `${formatInr(quote.price)} per person (${forPax})`;
}

function usableNights(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}
function usableStar(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 7;
}
