// ============================================================
// Per-person price selection from the supplier price matrix.
//
// `price_data` is the ONLY correct way to quote for a specific party
// size: `adultN` columns hold the per-person price when N people
// travel together (bigger group = cheaper per head; 0 = that size
// isn't offered). `starting_price` is the 2-pax double-sharing
// lowest-meal-plan rate and must only be the last resort — quoting it
// to a group of 8 overstates their price badly.
// ============================================================

import type { MealPlan } from './trip';

/** One entry of the supplier price matrix (fields we consume; rows
 *  carry more that we pass through untouched). */
export interface PriceDataEntry {
  meal_plan?: string;
  currency?: string;
  adult2?: number;
  adult4?: number;
  adult6?: number;
  adult8?: number;
  adult10?: number;
  adult12?: number;
  sgl_room_price?: number;
  dbl_room_price?: number;
  tpl_room_price?: number;
  [key: string]: unknown;
}

export interface PerPersonQuote {
  /** Per-person price in the row's currency. */
  price: number;
  /** The party size the price actually applies to (the adultN column
   *  used) — quoted to the traveller when it differs from their pax. */
  basisPax: number;
  /** Meal plan of the matrix entry the price came from. */
  mealPlan: string | null;
  /** True when we fell back to starting_price (2-pax double-sharing
   *  rate) because the matrix had nothing usable. The bot must SAY so. */
  isStartingPriceFallback: boolean;
}

const ADULT_SIZES = [2, 4, 6, 8, 10, 12] as const;

/** Map the trip's meal-plan enum onto the free-text values the price
 *  matrix uses ("Breakfast", "MAP", "Room Only"...). Loose contains-
 *  match — supplier spellings vary. */
function mealPlanMatches(
  entryPlan: string | undefined,
  asked: MealPlan
): boolean {
  if (!entryPlan) return false;
  const p = entryPlan.toLowerCase();
  switch (asked) {
    case 'ROOM_ONLY':
      return p.includes('room only') || p === 'ep' || p.includes('ep ');
    case 'BREAKFAST':
      return p === 'cp' || p.includes('breakfast');
    case 'BREAKFAST_DINNER':
      return p === 'map' || (p.includes('breakfast') && p.includes('dinner'));
    case 'ALL_MEALS':
      return p === 'ap' || p.includes('all meal');
  }
}

function usable(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/** Parse the raw JSONB `price_data` column defensively — the scraper
 *  pipeline owns its shape and the LLM must never see a crash. */
export function parsePriceData(raw: unknown): PriceDataEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is PriceDataEntry => e !== null && typeof e === 'object'
  );
}

/**
 * Pick the per-person price for a party of `pax` (adults + children):
 * prefer entries matching the asked meal plan, then take the `adultN`
 * column with N nearest to `pax` (ties → smaller N, i.e. the higher,
 * conservative price — never surprise the traveller upward later).
 *
 * Returns null when the matrix yields nothing; the caller falls back
 * to `starting_price` and must present it as the 2-person
 * double-sharing rate.
 */
export function perPersonPrice(
  priceData: unknown,
  pax: number,
  askedMealPlan?: MealPlan
): PerPersonQuote | null {
  const entries = parsePriceData(priceData);
  if (entries.length === 0 || !Number.isFinite(pax) || pax < 1) return null;

  const pool =
    askedMealPlan !== undefined
      ? entries.filter((e) => mealPlanMatches(e.meal_plan, askedMealPlan))
      : [];
  const candidates = pool.length > 0 ? pool : entries;

  let best: PerPersonQuote | null = null;
  let bestDistance = Infinity;
  for (const entry of candidates) {
    for (const n of ADULT_SIZES) {
      const price = entry[`adult${n}`];
      if (!usable(price)) continue;
      const distance = Math.abs(n - pax);
      const beats =
        distance < bestDistance ||
        (distance === bestDistance && best !== null && n < best.basisPax) ||
        (distance === bestDistance &&
          best !== null &&
          n === best.basisPax &&
          price < best.price);
      if (best === null || beats) {
        best = {
          price,
          basisPax: n,
          mealPlan: entry.meal_plan ?? null,
          isStartingPriceFallback: false,
        };
        bestDistance = distance;
      }
    }
  }
  return best;
}

/** The full quote the search results carry: matrix price when
 *  available, otherwise the labelled starting-price fallback. */
export function quoteForParty(
  priceData: unknown,
  startingPrice: number | null,
  pax: number,
  askedMealPlan?: MealPlan
): PerPersonQuote | null {
  const matrix = perPersonPrice(priceData, pax, askedMealPlan);
  if (matrix) return matrix;
  if (usable(startingPrice)) {
    return {
      price: startingPrice,
      basisPax: 2,
      mealPlan: null,
      isStartingPriceFallback: true,
    };
  }
  return null;
}
