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

export type VehicleType =
  | 'HATCHBACK'
  | 'SEDAN'
  | 'SUV_MUV'
  | 'TEMPO_TRAVELLER'
  | 'MINI_BUS';

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
  childAges?: number[];
  roomOccupancy?: RoomOccupancy;
  mealPlan?: MealPlan;
  vehicleType?: VehicleType;
  starCategory?: 3 | 4 | 5;
  /** Cities, sights, or areas the traveller explicitly wants included. */
  placesToCover?: string[];
  /** "None" is a valid answer and marks this qualification slot complete. */
  specificRequirements?: string;
  /** CRM ingestion marker. Kept in the trip JSON so webhook retries and
   *  future messages cannot create another lead for the same enquiry. */
  crmLeadId?: string;
  crmQualifiedAt?: string;
  /** A different callback number the traveller gave for the booking
   *  recap (their WhatsApp number is known implicitly). */
  altPhone?: string;
  /** Stage 2 progress: the package they picked from the shown list. */
  selectedPackage?: { promoId: string; hId: string; name: string };
  /** Stage 2 done: they confirmed the selected package after detail. */
  packageConfirmed?: boolean;
  /** Stage 3 done: they confirmed the booking recap card + number. */
  bookingRequestConfirmed?: boolean;
  /** Legacy bookkeeping from the removed stuck-slot escalation; may
   *  still exist on old rows. Never shown to the model. */
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
  'HATCHBACK',
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
  if (children !== undefined) {
    next.children = children;
    if (children === 0) next.childAges = [];
  }
  if (Array.isArray(e.childAges)) {
    const ages = e.childAges
      .map((v) => asInt(v, 0, 17))
      .filter((v): v is number => v !== undefined)
      .slice(0, next.children ?? 20);
    if (ages.length || next.children === 0) {
      const existing = next.childAges ?? [];
      next.childAges =
        next.children && ages.length < next.children && existing.length + ages.length <= next.children
          ? [...existing, ...ages]
          : ages;
    }
  }
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
  if (Array.isArray(e.placesToCover)) {
    const places = e.placesToCover
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim().slice(0, 100))
      .filter(Boolean)
      .slice(0, 20);
    if (places.length) next.placesToCover = [...new Set(places)];
  } else if (typeof e.placesToCover === 'string' && e.placesToCover.trim()) {
    next.placesToCover = e.placesToCover
      .split(/[,;\n]|\band\b/i)
      .map((v) => v.trim().slice(0, 100))
      .filter(Boolean)
      .slice(0, 20);
  }
  if (typeof e.specificRequirements === 'string' && e.specificRequirements.trim()) {
    next.specificRequirements = e.specificRequirements.trim().slice(0, 2000);
  }
  // Alternate callback number for the booking recap — keep only
  // phone-shaped input (digits with optional +, separators allowed).
  if (typeof e.altPhone === 'string') {
    const cleaned = e.altPhone.replace(/[^\d+]/g, '');
    const digits = cleaned.replace(/\D/g, '');
    if (digits.length >= 7 && digits.length <= 15) next.altPhone = cleaned;
  }

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

/**
 * Merge the model's stage progress (Stage 2/3 of the prompt) into the
 * trip — same untrusted-output discipline as `mergeTrip`. Booleans are
 * sticky once true (a later turn can't silently unwind a confirmed
 * stage; the traveller changing their pick DOES replace
 * `selectedPackage` and clears the confirms so the flow re-runs).
 */
export function mergeStage(
  current: Trip,
  parsed: {
    selectedPackage?: unknown;
    packageConfirmed?: unknown;
    bookingRequestConfirmed?: unknown;
  }
): Trip {
  const next: Trip = { ...current };

  const sp = parsed.selectedPackage;
  if (sp && typeof sp === 'object') {
    const p = sp as Record<string, unknown>;
    // Accept both the contract's camelCase and the shown-list's
    // snake_case ids — the model sees the latter in its context.
    const promoId = p.promoId ?? p.promo_id;
    const hId = p.hId ?? p.h_id;
    if (
      (typeof promoId === 'string' || typeof promoId === 'number') &&
      (typeof hId === 'string' || typeof hId === 'number')
    ) {
      const picked = {
        promoId: String(promoId),
        hId: String(hId),
        name: typeof p.name === 'string' ? p.name.slice(0, 120) : '',
      };
      if (
        next.selectedPackage &&
        (next.selectedPackage.promoId !== picked.promoId ||
          next.selectedPackage.hId !== picked.hId)
      ) {
        // They changed their mind — earlier confirmations are void.
        next.packageConfirmed = undefined;
        next.bookingRequestConfirmed = undefined;
      }
      next.selectedPackage = picked;
    }
  }

  if (parsed.packageConfirmed === true && next.selectedPackage) {
    next.packageConfirmed = true;
  }
  if (parsed.bookingRequestConfirmed === true && next.packageConfirmed) {
    next.bookingRequestConfirmed = true;
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
  if (pax <= 2) return ['HATCHBACK', 'SEDAN', 'SUV_MUV'];
  if (pax <= 4) return ['SEDAN', 'SUV_MUV'];
  return ['SUV_MUV'];
}

/** Vehicle automatically selected from total passenger count. */
export function recommendedVehicleForPax(pax: number): VehicleType {
  if (pax <= 2) return 'HATCHBACK';
  if (pax <= 4) return 'SEDAN';
  return 'SUV_MUV';
}

/**
 * The qualification slot order (§6). `dates` covers the
 * dateFlexibility/checkIn/travelMonth cluster; it's satisfied by ANY
 * of them. Vehicle is derived from passenger count; every other slot
 * listed here must be known before CRM ingestion.
 */
export type SlotName =
  | 'destination'
  | 'dates'
  | 'nights'
  | 'pax'
  | 'childAges'
  | 'vehicleType'
  | 'roomOccupancy'
  | 'mealPlan'
  | 'starCategory'
  | 'placesToCover'
  | 'specificRequirements';

export function nextMissingSlot(trip: Trip): SlotName | null {
  if (!trip.destination) return 'destination';
  if (trip.adults === undefined || trip.children === undefined) return 'pax';
  if (trip.children > 0 && trip.childAges?.length !== trip.children) return 'childAges';
  if (!trip.vehicleType) return 'vehicleType';
  if (trip.nights === undefined) return 'nights';
  if (!trip.dateFlexibility && !trip.checkInDate && !trip.travelMonth) {
    return 'dates';
  }
  if (trip.dateFlexibility === 'EXACT_DATES' && !trip.checkInDate) return 'dates';
  if (trip.dateFlexibility === 'MONTH_KNOWN' && !trip.travelMonth) return 'dates';
  if (!trip.starCategory) return 'starCategory';
  if (!trip.roomOccupancy) return 'roomOccupancy';
  if (!trip.mealPlan) return 'mealPlan';
  if (!trip.placesToCover?.length) return 'placesToCover';
  if (!trip.specificRequirements) return 'specificRequirements';
  return null;
}

export function isQualifiedTrip(trip: Trip): boolean {
  return nextMissingSlot(trip) === null;
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
  else if (lower === 'exact dates') out.dateFlexibility = 'EXACT_DATES';
  else if (lower === 'i know the month') out.dateFlexibility = 'MONTH_KNOWN';
  else if (lower === 'flexible') out.dateFlexibility = 'FLEXIBLE';
  const month = /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})$/i.exec(t);
  if (month) {
    out.travelMonth = `${month[1][0].toUpperCase()}${month[1].slice(1).toLowerCase()} ${month[2]}`;
    out.dateFlexibility = 'MONTH_KNOWN';
  }
  const indianDate = /\b(\d{1,2})[-/](\d{1,2})[-/](20\d{2})\b/.exec(t);
  if (indianDate) {
    const day = indianDate[1].padStart(2, '0');
    const monthNumber = indianDate[2].padStart(2, '0');
    const candidate = `${indianDate[3]}-${monthNumber}-${day}`;
    const parsed = new Date(`${candidate}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate) {
      out.checkInDate = candidate;
      out.dateFlexibility = 'EXACT_DATES';
    }
  }

  // Nights: "4n", "4 nights", "6+ nights".
  const nights = /(\d{1,2})\s*\+?\s*n(?:ights?)?\b/i.exec(t);
  if (nights) {
    const n = Number(nights[1]);
    if (n >= 1 && n <= 30) out.nights = n;
  }

  // Party size: "2 adults", "1 kid"/"1 child"; bare "2 of us".
  const adults = /(\d{1,2})\s*adults?\b/i.exec(t);
  if (adults) {
    out.adults = Number(adults[1]);
    if (!/\b(?:kids?|child(?:ren)?)\b/i.test(t)) out.children = 0;
  }
  const children = /(\d{1,2})\s*(?:kids?|child(?:ren)?)\b/i.exec(t);
  if (children) out.children = Number(children[1]);
  if (/\b(?:age|ages|aged)\b/i.test(t)) {
    const agePart = t.slice(Math.max(0, t.search(/\b(?:age|ages|aged)\b/i)));
    const ages = [...agePart.matchAll(/\b(\d{1,2})\b/g)]
      .map((m) => Number(m[1]))
      .filter((n) => n >= 0 && n <= 17);
    if (ages.length) out.childAges = ages;
  }

  // Trip type buttons.
  if (lower === 'honeymoon') out.tripType = 'HONEYMOON';
  else if (lower === 'family') out.tripType = 'FAMILY';
  else if (lower === 'friends') out.tripType = 'FRIENDS';
  else if (lower === 'solo') out.tripType = 'SOLO';

  // Room occupancy buttons.
  if (lower.startsWith('double sharing')) out.roomOccupancy = 'DOUBLE';
  else if (lower.startsWith('triple sharing')) out.roomOccupancy = 'TRIPLE';
  else if (lower.startsWith('single')) out.roomOccupancy = 'SINGLE';

  // Meal plan buttons.
  if (lower === 'breakfast') out.mealPlan = 'BREAKFAST';
  else if (lower === 'room only') out.mealPlan = 'ROOM_ONLY';
  else if (lower === 'breakfast + dinner') out.mealPlan = 'BREAKFAST_DINNER';
  else if (lower === 'all meals') out.mealPlan = 'ALL_MEALS';

  // Vehicle buttons ("Sedan (4 seats)", "SUV (6 seats)", ...).
  if (lower.startsWith('sedan')) out.vehicleType = 'SEDAN';
  else if (lower.startsWith('hatchback')) out.vehicleType = 'HATCHBACK';
  else if (lower.startsWith('suv')) out.vehicleType = 'SUV_MUV';
  else if (lower.startsWith('tempo')) out.vehicleType = 'TEMPO_TRAVELLER';
  else if (lower.startsWith('mini bus')) out.vehicleType = 'MINI_BUS';

  // Star buttons.
  const star = /^([345])\s*star$/i.exec(lower);
  if (star) out.starCategory = Number(star[1]) as 3 | 4 | 5;

  if (/^(?:no|none|nothing|nope|nothing for now|not for now|not at the moment|no (?:specific )?requirements?)\.?$/i.test(t)) {
    out.specificRequirements = 'None';
  }
  if (/^(?:no preference|open to suggestions|you suggest)\.?$/i.test(t)) {
    out.placesToCover = ['Open to suggestions'];
  }
  if (/^must-see highlights\.?$/i.test(t)) {
    out.placesToCover = ['Must-see highlights'];
  }
  if (/^dietary needs\.?$/i.test(t)) out.specificRequirements = 'Dietary requirements';
  else if (/^accessibility\.?$/i.test(t)) out.specificRequirements = 'Accessibility requirements';
  else if (/^celebration setup\.?$/i.test(t)) out.specificRequirements = 'Celebration setup';

  return out;
}

export function qualificationRecap(trip: Trip): string {
  const vehicle: Record<VehicleType, string> = {
    HATCHBACK: 'Hatchback',
    SEDAN: 'Sedan',
    SUV_MUV: 'SUV',
    TEMPO_TRAVELLER: 'Tempo Traveller',
    MINI_BUS: 'Mini Bus',
  };
  const occupancy: Record<RoomOccupancy, string> = {
    SINGLE: 'Single rooms',
    DOUBLE: 'Double sharing',
    TRIPLE: 'Triple sharing',
  };
  const meals: Record<MealPlan, string> = {
    ROOM_ONLY: 'Room only',
    BREAKFAST: 'Breakfast',
    BREAKFAST_DINNER: 'Breakfast + dinner',
    ALL_MEALS: 'All meals',
  };
  const childText = trip.children
    ? `, ${trip.children} ${trip.children === 1 ? 'child' : 'children'} (age${trip.children === 1 ? '' : 's'} ${(trip.childAges ?? []).join(', ')})`
    : ', 0 children';
  const timing = trip.checkInDate
    ? `${trip.checkInDate}${trip.checkOutDate ? ` to ${trip.checkOutDate}` : ''}`
    : trip.travelMonth ?? 'Flexible';
  const requirements = trip.specificRequirements === 'None' ? 'None' : trip.specificRequirements;

  return [
    'Thank you — your travel requirements have been added successfully.',
    '',
    `📍 ${trip.destination}`,
    `👥 ${trip.adults} ${trip.adults === 1 ? 'adult' : 'adults'}${childText}`,
    `🌙 ${trip.nights} nights · ${timing}`,
    `🏨 ${trip.starCategory} star · ${occupancy[trip.roomOccupancy!]} · ${meals[trip.mealPlan!]}`,
    `🚗 ${vehicle[trip.vehicleType!]}`,
    `🗺️ ${trip.placesToCover?.join(', ')}`,
    `📝 Specific requirements: ${requirements}`,
    '',
    'We will connect back with you here with quotes for these travel requirements.',
  ].join('\n');
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
        options: ['Ladakh', 'Kashmir', 'Kerala', 'Andaman', 'Himachal', 'Rajasthan', 'Goa'],
      };
    case 'dates': {
      if (trip.dateFlexibility === 'EXACT_DATES') {
        return { text: 'Please send your travel start date in DD-MM-YYYY format.', options: [] };
      }
      if (trip.dateFlexibility === 'MONTH_KNOWN') {
        return { text: 'Which month are you planning to travel?', options: upcomingMonths(8) };
      }
      return {
        text: 'When are you planning to travel?',
        options: [...upcomingMonths(7), 'Exact dates', 'Flexible'],
      };
    }
    case 'nights':
      return {
        text: 'How many nights are you thinking?',
        options: ['4 nights', '5 nights', '6+ nights'],
      };
    case 'pax':
      return {
        text: 'How many adults and children will be travelling?',
        options: ['1 adult, 0 kids', '2 adults, 0 kids', '2 adults, 1 kid', '2 adults, 2 kids', '4 adults, 0 kids', '6 adults, 0 kids', 'Other group size'],
      };
    case 'childAges':
      return {
        text: `What ${trip.children === 1 ? 'is the child’s age' : `is the age of child ${(trip.childAges?.length ?? 0) + 1} of ${trip.children}`}?`,
        options: ['Age 2', 'Age 3', 'Age 4', 'Age 5', 'Age 6', 'Age 7', 'Age 8', 'Age 9', 'Age 10', 'Other age'],
      };
    case 'vehicleType': {
      const labels: Record<VehicleType, string> = {
        HATCHBACK: 'Hatchback',
        SEDAN: 'Sedan',
        SUV_MUV: 'SUV',
        TEMPO_TRAVELLER: 'Tempo Traveller',
        MINI_BUS: 'Mini Bus',
      };
      return {
        text: 'Which vehicle type would you prefer for your group?',
        options: vehicleOptionsForPax(totalPax(trip) ?? 1).map((v) => labels[v]),
      };
    }
    case 'starCategory':
      return {
        text: 'Hotel-wise, what are you leaning towards — 3★ comfortable, 4★ premium, or 5★ luxury?',
        options: ['3 star', '4 star', '5 star'],
      };
    case 'roomOccupancy':
      return {
        text: 'How would you like the rooms shared?',
        options: ['Double sharing', 'Triple sharing', 'Single rooms'],
      };
    case 'mealPlan':
      return {
        text: 'Which meal plan would you prefer?',
        options: ['Room only', 'Breakfast', 'Breakfast + dinner', 'All meals'],
      };
    case 'placesToCover':
      return {
        text: 'Which places or sights would you definitely like included in the itinerary?',
        options: ['Must-see highlights', 'Open to suggestions', 'Custom places'],
      };
    case 'specificRequirements':
      return {
        text: 'Any specific requirements I should note, such as accessibility, food, room, or celebration needs?',
        options: ['No requirements', 'Dietary needs', 'Accessibility', 'Celebration setup', 'Other requirement'],
      };
    default:
      return {
        text: 'Give me a moment — let me pull up the best options for your trip.',
        options: [],
      };
  }
}

function upcomingMonths(count: number): string[] {
  const now = new Date();
  return Array.from({ length: count }, (_, offset) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  });
}
