// ============================================================
// `search_packages` — the retrieval + ranking core (§5), a direct
// port of the logic proven in the Oliday web app.
//
// Pool is scoped to trip length FIRST (±2 nights), ordered by price,
// capped at 150: ordering the whole region by price alone floods the
// pool with the cheapest (shortest) packages, so a 6-night ask would
// only ever see 4-night options. Region-wide re-query only when the
// window is empty.
// ============================================================

import { catalogClient } from './catalog-client';
import { resolveRegion, containsWholeWords } from './regions';
import { quoteForParty, type PerPersonQuote } from './pricing';
import {
  averageStar,
  hotelsLine,
  packageMealPlanEnglish,
  routeLine,
} from './format';
import type { MealPlan, VehicleType } from './trip';

export interface SearchParams {
  destination: string;
  nights?: number;
  adults?: number;
  children?: number;
  mealPlan?: MealPlan;
  vehicleType?: VehicleType;
  starCategory?: number;
  maxPrice?: number;
}

/** The compact card shape returned to the LLM — enough to present a
 *  package without a second fetch, nothing supplier-identifying. */
export interface PackageCard {
  promo_id: string | number;
  h_id: string | number;
  name: string;
  region: string;
  nights: number;
  days: number;
  route: string;
  hotels: string;
  meal_plan: string | null;
  vehicle: string | null;
  vehicle_seats: number | null;
  per_person: PerPersonQuote | null;
  starting_price: number | null;
  currency: string;
  travel_from: string | null;
  travel_to: string | null;
}

export interface SearchResult {
  packages: PackageCard[];
  /** Set when `destination` maps to no catalog region — the bot must
   *  offer a specialist callback, never fake coverage. */
  destinationNotCovered?: boolean;
  /** The city the ask resolved to, when city-level. When no package
   *  visits it, the bot says plainly which stops ARE covered. */
  city?: string;
  cityMatched?: boolean;
  region?: string;
}

/** Row shape pulled from `active_packages` for search (search never
 *  reads itinerary/inclusions — that's `get_package`'s job). */
interface PoolRow {
  promo_id: string | number;
  h_id: string | number;
  package_name: string;
  destination: string;
  total_nights: number;
  total_days: number;
  starting_price: number | null;
  currency: string | null;
  vehicle_type: string | null;
  vehicle_seats: number | null;
  route: unknown;
  hotels: unknown;
  price_data: unknown;
  travel_from: string | null;
  travel_to: string | null;
}

const POOL_COLUMNS =
  'promo_id, h_id, package_name, destination, total_nights, total_days, ' +
  'starting_price, currency, vehicle_type, vehicle_seats, route, hotels, ' +
  'price_data, travel_from, travel_to';

const POOL_LIMIT = 150;
const RESULT_LIMIT = 5;

/** Keywords per vehicle class, matched against the free-text
 *  `vehicle_type` column. */
const VEHICLE_KEYWORDS: Record<VehicleType, string[]> = {
  SEDAN: ['sedan', 'hatchback', 'dzire', 'etios'],
  SUV_MUV: ['suv', 'muv', 'innova', 'ertiga', 'crysta'],
  TEMPO_TRAVELLER: ['tempo', 'traveller', 'traveler'],
  MINI_BUS: ['bus', 'coach'],
};

export async function searchPackages(
  params: SearchParams
): Promise<SearchResult> {
  const resolved = resolveRegion(params.destination ?? '');
  if (!resolved) {
    return { packages: [], destinationNotCovered: true };
  }
  const { region, city } = resolved;
  const db = catalogClient();

  // Candidate pool, trip-length-scoped first.
  let pool: PoolRow[] = [];
  if (params.nights !== undefined) {
    const { data, error } = await db
      .from('active_packages')
      .select(POOL_COLUMNS)
      .eq('destination', region)
      .gte('total_nights', Math.max(1, params.nights - 2))
      .lte('total_nights', params.nights + 2)
      .order('starting_price', { ascending: true })
      .limit(POOL_LIMIT);
    if (error) throw new Error(`catalog query failed: ${error.message}`);
    pool = (data ?? []) as unknown as PoolRow[];
  }
  if (pool.length === 0) {
    const { data, error } = await db
      .from('active_packages')
      .select(POOL_COLUMNS)
      .eq('destination', region)
      .order('starting_price', { ascending: true })
      .limit(POOL_LIMIT);
    if (error) throw new Error(`catalog query failed: ${error.message}`);
    pool = (data ?? []) as unknown as PoolRow[];
  }

  // City-level ask: prefer packages that actually visit the city; if
  // none mention it, keep the regional pool (§4 — show regional
  // options rather than nothing, but say which stops are covered).
  let cityMatched = false;
  if (city) {
    const visiting = pool.filter(
      (row) =>
        containsWholeWords(row.package_name ?? '', city) ||
        containsWholeWords(routeLine(row.route), city)
    );
    if (visiting.length > 0) {
      pool = visiting;
      cityMatched = true;
    }
  }

  const pax = (params.adults ?? 2) + (params.children ?? 0);

  const scored = pool.map((row) => ({
    row,
    score: scorePackage(row, { ...params, pax }),
  }));
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (a.row.starting_price ?? Infinity) - (b.row.starting_price ?? Infinity)
  );

  let top = scored
    .slice(0, RESULT_LIMIT * 3)
    .map(({ row }) => toCard(row, pax, params.mealPlan));

  // Budget cap applies to the price the traveller would actually pay
  // (their party-size quote), not the 2-pax starting price. Only
  // filters when the traveller volunteered a cap — we never ask (§6).
  if (params.maxPrice !== undefined && Number.isFinite(params.maxPrice)) {
    const capped = top.filter(
      (c) =>
        (c.per_person?.price ?? c.starting_price ?? Infinity) <=
        params.maxPrice!
    );
    if (capped.length > 0) top = capped;
  }

  return {
    packages: top.slice(0, RESULT_LIMIT),
    region,
    city,
    cityMatched: city ? cityMatched : undefined,
  };
}

function scorePackage(
  row: PoolRow,
  ask: SearchParams & { pax: number }
): number {
  let score = 0;

  // Trip length: exact +40, off-by-1 +24, off-by-2 +8, else -6×diff.
  if (ask.nights !== undefined && Number.isFinite(row.total_nights)) {
    const diff = Math.abs(row.total_nights - ask.nights);
    if (diff === 0) score += 40;
    else if (diff === 1) score += 24;
    else if (diff === 2) score += 8;
    else score -= 6 * diff;
  }

  // Vehicle: can't fit the group → heavy penalty; asked class → bonus.
  if (
    typeof row.vehicle_seats === 'number' &&
    row.vehicle_seats > 0 &&
    row.vehicle_seats < ask.pax
  ) {
    score -= 30;
  }
  if (ask.vehicleType && row.vehicle_type) {
    const v = row.vehicle_type.toLowerCase();
    if (VEHICLE_KEYWORDS[ask.vehicleType].some((k) => v.includes(k))) {
      score += 12;
    }
  }

  // Meal plan: any hotel on the asked plan.
  if (ask.mealPlan && Array.isArray(row.hotels)) {
    const wanted = mealPlanCodes(ask.mealPlan);
    const hit = (row.hotels as { meal_plan?: string }[]).some((h) => {
      const plan = (h?.meal_plan ?? '').toUpperCase();
      return wanted.some((w) => plan.includes(w));
    });
    if (hit) score += 10;
  }

  // Star preference: +8 − min(8, |avg − asked| × 4).
  if (ask.starCategory !== undefined) {
    const avg = averageStar(row.hotels);
    if (avg !== null) {
      score += 8 - Math.min(8, Math.abs(avg - ask.starCategory) * 4);
    }
  }

  return score;
}

/** Meal-plan enum → matrix/hotel code spellings. */
function mealPlanCodes(plan: MealPlan): string[] {
  switch (plan) {
    case 'ROOM_ONLY':
      return ['EP', 'ROOM ONLY'];
    case 'BREAKFAST':
      return ['CP', 'BREAKFAST'];
    case 'BREAKFAST_DINNER':
      return ['MAP'];
    case 'ALL_MEALS':
      return ['AP', 'ALL MEAL'];
  }
}

function toCard(row: PoolRow, pax: number, mealPlan?: MealPlan): PackageCard {
  return {
    promo_id: row.promo_id,
    h_id: row.h_id,
    name: row.package_name,
    region: row.destination,
    nights: row.total_nights,
    days: row.total_days,
    route: routeLine(row.route),
    hotels: hotelsLine(row.hotels),
    meal_plan: packageMealPlanEnglish(row.hotels),
    vehicle: row.vehicle_type,
    vehicle_seats: row.vehicle_seats,
    per_person: quoteForParty(
      row.price_data,
      row.starting_price,
      pax,
      mealPlan
    ),
    starting_price: row.starting_price,
    currency: row.currency ?? 'INR',
    travel_from: row.travel_from,
    travel_to: row.travel_to,
  };
}
