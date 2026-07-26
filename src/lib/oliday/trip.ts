// ============================================================
// Trip qualification state (§10 of the bot spec).
//
// The `conversations.trip` JSONB column is the source of truth for
// what we know and what to ask next — NOT the transcript. Every turn
// merges the model's `extractedFields` into the stored trip, then the
// next question is re-derived from the slots, so a long chat can't
// drift.
// ============================================================

import { resolveRegion } from './regions';

export type DateFlexibility =
  'EXACT_DATES' | 'MONTH_KNOWN' | 'FLEXIBLE' | 'JUST_EXPLORING';

export type TripType =
  'HONEYMOON' | 'COUPLE' | 'FAMILY' | 'FRIENDS' | 'SOLO' | 'CORPORATE';

export type RoomOccupancy = 'SINGLE' | 'DOUBLE' | 'TRIPLE';

export type MealPlan =
  'ROOM_ONLY' | 'BREAKFAST' | 'BREAKFAST_DINNER' | 'ALL_MEALS';

export type VehicleType = 'SEDAN' | 'SUV_MUV' | 'TEMPO_TRAVELLER' | 'MINI_BUS';

export interface Trip {
  destination?: string; // as asked (city or region)
  region?: string; // resolved catalog region
  dateFlexibility?: DateFlexibility;
  checkInDate?: string; // YYYY-MM-DD
  checkOutDate?: string;
  travelMonth?: string; // "December 2026"
  nights?: number;
  tripType?: TripType;
  adults?: number;
  children?: number;
  roomOccupancy?: RoomOccupancy;
  mealPlan?: MealPlan;
  vehicleType?: VehicleType;
  starCategory?: 3 | 4 | 5;
  /** Internal: consecutive turns stuck asking for the same slot —
   *  drives the "stuck 3 turns → human" escalation. Not a slot. */
  _stuck?: { slot: string; count: number };
}

const TRIP_TYPES = new Set<string>([
  'HONEYMOON',
  'COUPLE',
  'FAMILY',
  'FRIENDS',
  'SOLO',
  'CORPORATE',
]);
const DATE_FLEX = new Set<string>([
  'EXACT_DATES',
  'MONTH_KNOWN',
  'FLEXIBLE',
  'JUST_EXPLORING',
]);
const OCCUPANCIES = new Set<string>(['SINGLE', 'DOUBLE', 'TRIPLE']);
const MEAL_PLANS = new Set<string>([
  'ROOM_ONLY',
  'BREAKFAST',
  'BREAKFAST_DINNER',
  'ALL_MEALS',
]);
const VEHICLES = new Set<string>([
  'SEDAN',
  'SUV_MUV',
  'TEMPO_TRAVELLER',
  'MINI_BUS',
]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function asInt(v: unknown, min: number, max: number): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  const i = Math.floor(n);
  return i >= min && i <= max ? i : undefined;
}

/**
 * Merge the model's extracted fields into the stored trip, validating
 * every value — the LLM's output is untrusted. Unknown keys and
 * malformed values are dropped silently. Never un-fills a slot: an
 * absent/invalid extraction leaves the stored value alone (the model
 * re-stating a slot CAN overwrite it — travellers change their minds).
 */
export function mergeTrip(current: Trip, extracted: unknown): Trip {
  const next: Trip = { ...current };
  if (!extracted || typeof extracted !== 'object') return next;
  const e = extracted as Record<string, unknown>;

  if (typeof e.destination === 'string' && e.destination.trim()) {
    next.destination = e.destination.trim().slice(0, 80);
    const resolved = resolveRegion(next.destination);
    next.region = resolved?.region;
  }
  if (
    typeof e.dateFlexibility === 'string' &&
    DATE_FLEX.has(e.dateFlexibility)
  ) {
    next.dateFlexibility = e.dateFlexibility as DateFlexibility;
  }
  if (typeof e.checkInDate === 'string' && ISO_DATE.test(e.checkInDate)) {
    next.checkInDate = e.checkInDate;
  }
  if (typeof e.checkOutDate === 'string' && ISO_DATE.test(e.checkOutDate)) {
    next.checkOutDate = e.checkOutDate;
  }
  if (typeof e.travelMonth === 'string' && e.travelMonth.trim()) {
    next.travelMonth = e.travelMonth.trim().slice(0, 40);
  }
  const nights = asInt(e.nights, 1, 30);
  if (nights !== undefined) next.nights = nights;
  if (typeof e.tripType === 'string' && TRIP_TYPES.has(e.tripType)) {
    next.tripType = e.tripType as TripType;
  }
  const adults = asInt(e.adults, 1, 50);
  if (adults !== undefined) next.adults = adults;
  const children = asInt(e.children, 0, 20);
  if (children !== undefined) next.children = children;
  if (typeof e.roomOccupancy === 'string' && OCCUPANCIES.has(e.roomOccupancy)) {
    next.roomOccupancy = e.roomOccupancy as RoomOccupancy;
  }
  if (typeof e.mealPlan === 'string' && MEAL_PLANS.has(e.mealPlan)) {
    next.mealPlan = e.mealPlan as MealPlan;
  }
  if (typeof e.vehicleType === 'string' && VEHICLES.has(e.vehicleType)) {
    next.vehicleType = e.vehicleType as VehicleType;
  }
  const star = asInt(e.starCategory, 3, 5);
  if (star === 3 || star === 4 || star === 5) next.starCategory = star;

  // Derive check-out from check-in + nights when the traveller gave
  // only one of the pair.
  if (next.checkInDate && next.nights && !next.checkOutDate) {
    const d = new Date(`${next.checkInDate}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) {
      d.setUTCDate(d.getUTCDate() + next.nights);
      next.checkOutDate = d.toISOString().slice(0, 10);
    }
  }
  // ...and nights from the date pair when both dates are known.
  if (next.checkInDate && next.checkOutDate && !next.nights) {
    const a = new Date(`${next.checkInDate}T00:00:00Z`).getTime();
    const b = new Date(`${next.checkOutDate}T00:00:00Z`).getTime();
    const diff = Math.round((b - a) / 86_400_000);
    if (diff >= 1 && diff <= 30) next.nights = diff;
  }

  return next;
}

/** Total travellers (children count toward the pax-size price column
 *  per the spec's pricing rule). Defaults children to 0. */
export function totalPax(trip: Trip): number | undefined {
  if (trip.adults === undefined) return undefined;
  return trip.adults + (trip.children ?? 0);
}

/** Rooms derived, never asked: double → ceil(adults/2), triple →
 *  ceil(adults/3), single → one each. */
export function derivedRooms(trip: Trip): number | undefined {
  if (trip.adults === undefined) return undefined;
  switch (trip.roomOccupancy) {
    case 'SINGLE':
      return trip.adults;
    case 'TRIPLE':
      return Math.ceil(trip.adults / 3);
    case 'DOUBLE':
    default:
      return Math.ceil(trip.adults / 2);
  }
}

/** Vehicle classes sized to the group — a couple never sees "Mini
 *  bus"; 10 people never see "Sedan". */
export function vehicleOptionsForPax(pax: number): VehicleType[] {
  if (pax <= 4) return ['SEDAN', 'SUV_MUV'];
  if (pax <= 6) return ['SUV_MUV', 'TEMPO_TRAVELLER'];
  if (pax <= 12) return ['TEMPO_TRAVELLER', 'MINI_BUS'];
  return ['MINI_BUS'];
}

/**
 * The qualification slot order (§6). `dates` covers the
 * dateFlexibility/checkIn/travelMonth cluster; it's satisfied by ANY
 * of them. Room occupancy / meal plan / vehicle / star are
 * nice-to-haves: packages can be shown before they're filled.
 */
export type SlotName =
  | 'destination'
  | 'dates'
  | 'nights'
  | 'tripType'
  | 'pax'
  | 'roomOccupancy'
  | 'mealPlan'
  | 'vehicleType'
  | 'starCategory';

export function nextMissingSlot(trip: Trip): SlotName | null {
  if (!trip.destination) return 'destination';
  if (!trip.dateFlexibility && !trip.checkInDate && !trip.travelMonth) {
    return 'dates';
  }
  if (trip.nights === undefined) return 'nights';
  if (!trip.tripType) return 'tripType';
  if (trip.adults === undefined) return 'pax';
  if (!trip.roomOccupancy) return 'roomOccupancy';
  if (!trip.mealPlan) return 'mealPlan';
  if (!trip.vehicleType) return 'vehicleType';
  if (!trip.starCategory) return 'starCategory';
  return null;
}

/** Enough to usefully search: destination + nights + rough pax (§6:
 *  "don't wait for all nine slots before being useful"). */
export function readyToSearch(trip: Trip): boolean {
  return Boolean(
    trip.region && trip.nights !== undefined && trip.adults !== undefined
  );
}

/**
 * Deterministic slot extraction for LLM-down turns. Without this, the
 * fallback loop asks a question, the traveller answers (typed or via
 * a quick-reply button), and the answer evaporates — the same slot is
 * asked again until the stuck counter escalates. Seen live: an
 * "Andaman" button tap re-asked "Where are you dreaming of going?".
 *
 * Handles the fallback questions' own button labels exactly, plus the
 * common free-text shapes ("4n", "5 nights", "2 adults 1 kid"). The
 * LLM path does NOT use this — Gemini extracts with full context.
 */
export function deterministicExtract(text: string): Partial<Trip> {
  const out: Partial<Trip> = {};
  const t = text.trim();
  if (!t) return out;
  const lower = t.toLowerCase();

  // Destination — any covered region/city mentioned.
  const region = resolveRegion(t);
  if (region) out.destination = t.length <= 40 ? t : region.region;

  // Date flexibility — the fallback question's own button labels.
  if (lower === 'i have exact dates') out.dateFlexibility = 'EXACT_DATES';
  else if (lower === 'i know the month') out.dateFlexibility = 'MONTH_KNOWN';
  else if (lower === 'flexible') out.dateFlexibility = 'FLEXIBLE';

  // Nights: "4n", "4 nights", "6+ nights".
  const nights = /(\d{1,2})\s*\+?\s*n(?:ights?)?\b/i.exec(t);
  if (nights) {
    const n = Number(nights[1]);
    if (n >= 1 && n <= 30) out.nights = n;
  }

  // Party size: "2 adults", "1 kid"/"1 child"; bare "2 of us".
  const adults = /(\d{1,2})\s*adults?\b/i.exec(t);
  if (adults) out.adults = Number(adults[1]);
  const children = /(\d{1,2})\s*(?:kids?|child(?:ren)?)\b/i.exec(t);
  if (children) out.children = Number(children[1]);

  // Trip type buttons.
  if (lower === 'honeymoon') out.tripType = 'HONEYMOON';
  else if (lower === 'family') out.tripType = 'FAMILY';
  else if (lower === 'friends') out.tripType = 'FRIENDS';
  else if (lower === 'solo') out.tripType = 'SOLO';

  // Room occupancy buttons.
  if (lower.startsWith('double sharing')) out.roomOccupancy = 'DOUBLE';
  else if (lower.startsWith('triple sharing')) out.roomOccupancy = 'TRIPLE';

  // Meal plan buttons.
  if (lower === 'breakfast') out.mealPlan = 'BREAKFAST';
  else if (lower === 'breakfast + dinner') out.mealPlan = 'BREAKFAST_DINNER';
  else if (lower === 'all meals') out.mealPlan = 'ALL_MEALS';

  // Vehicle buttons ("Sedan (4 seats)", "SUV (6 seats)", ...).
  if (lower.startsWith('sedan')) out.vehicleType = 'SEDAN';
  else if (lower.startsWith('suv')) out.vehicleType = 'SUV_MUV';
  else if (lower.startsWith('tempo')) out.vehicleType = 'TEMPO_TRAVELLER';
  else if (lower.startsWith('mini bus')) out.vehicleType = 'MINI_BUS';

  // Star buttons.
  const star = /^([345])\s*star$/i.exec(lower);
  if (star) out.starCategory = Number(star[1]) as 3 | 4 | 5;

  return out;
}

/**
 * Deterministic fallback question for the next missing slot — sent
 * when the LLM is down (the bot must never go silent) and used to
 * detect "stuck on the same slot". Options become quick-reply buttons
 * where they fit WhatsApp's 20-char cap.
 */
export function fallbackQuestion(trip: Trip): {
  text: string;
  options: string[];
} {
  const slot = nextMissingSlot(trip);
  switch (slot) {
    case 'destination':
      return {
        text: 'Where are you dreaming of going? I can help with Kashmir, Kerala, Andaman, Himachal, Rajasthan, Ladakh and more.',
        options: ['Kashmir', 'Kerala', 'Andaman'],
      };
    case 'dates':
      return {
        text: 'When are you planning to travel — do you have exact dates, just the month, or still flexible?',
        options: ['I have exact dates', 'I know the month', 'Flexible'],
      };
    case 'nights':
      return {
        text: 'How many nights are you thinking?',
        options: ['4 nights', '5 nights', '6+ nights'],
      };
    case 'tripType':
      return {
        text: 'Who’s travelling — is this a honeymoon, a family trip, or a getaway with friends?',
        options: ['Honeymoon', 'Family', 'Friends'],
      };
    case 'pax':
      return {
        text: 'How many of you will be travelling? (adults + kids)',
        options: [],
      };
    case 'roomOccupancy':
      return {
        text: 'Room-wise, would you prefer double sharing or triple sharing?',
        options: ['Double sharing', 'Triple sharing'],
      };
    case 'mealPlan':
      return {
        text: 'For meals — breakfast only, breakfast + dinner, or all meals?',
        options: ['Breakfast', 'Breakfast + dinner', 'All meals'],
      };
    case 'vehicleType': {
      const pax = totalPax(trip) ?? 2;
      const labels: Record<VehicleType, string> = {
        SEDAN: 'Sedan (4 seats)',
        SUV_MUV: 'SUV (6 seats)',
        TEMPO_TRAVELLER: 'Tempo (12 seats)',
        MINI_BUS: 'Mini bus',
      };
      return {
        text: 'And for getting around — which vehicle works for your group?',
        options: vehicleOptionsForPax(pax).map((v) => labels[v]),
      };
    }
    case 'starCategory':
      return {
        text: 'Hotel-wise, what are you leaning towards — 3★ comfortable, 4★ premium, or 5★ luxury?',
        options: ['3 star', '4 star', '5 star'],
      };
    default:
      return {
        text: 'Give me a moment — let me pull up the best options for your trip.',
        options: [],
      };
  }
}
