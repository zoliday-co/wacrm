// ============================================================
// Validation + normalisation of the bot's "qualified lead"
// webhook payload (POST /api/travel/leads/qualified) — pure.
//
// Lenient by design: the only hard requirements are a
// `bot_session_id` (idempotency key), a traveller phone, and a
// primary destination. Everything else is optional — travel
// dates can be missing or flexible. Bad *shapes* (a string where
// a number is expected) are coerced when unambiguous and dropped
// otherwise, so a slightly-off bot never loses a qualified lead.
// ============================================================

import type { BudgetType, RequirementInput } from '@/types/travel';

export interface QualifiedLeadPayload {
  bot_session_id: string;
  traveller: { name: string | null; phone: string; email?: string | null };
  source: {
    type: string;
    campaign_id: string | null;
    campaign_name: string | null;
    adset_id: string | null;
    ad_id: string | null;
    ad_name: string | null;
    referral_data: Record<string, unknown> | null;
  };
  trip: RequirementInput & {
    destination_primary: string;
    qualification_summary: string | null;
  };
  /** Optional: lets the bot pass the CRM conversation id it already knows. */
  conversation_id?: string | null;
}

export type PayloadResult =
  | { ok: true; value: QualifiedLeadPayload }
  | { ok: false; error: string };

export function parseQualifiedLeadPayload(raw: unknown): PayloadResult {
  if (!isObject(raw)) return { ok: false, error: 'Body must be a JSON object' };

  const botSessionId = str(raw.bot_session_id);
  if (!botSessionId) return { ok: false, error: 'bot_session_id is required' };
  if (botSessionId.length > 200) return { ok: false, error: 'bot_session_id is too long' };

  const traveller = isObject(raw.traveller) ? raw.traveller : {};
  const phone = str(traveller.phone);
  if (!phone) return { ok: false, error: 'traveller.phone is required' };

  const trip = isObject(raw.trip) ? raw.trip : {};
  const destination = str(trip.destination) ?? str(trip.destination_primary);
  if (!destination) return { ok: false, error: 'trip.destination is required' };

  const source = isObject(raw.source) ? raw.source : {};
  const dates = isObject(trip.dates) ? trip.dates : {};
  const travellers = isObject(trip.travellers) ? trip.travellers : {};
  const rooms = isObject(trip.rooms) ? trip.rooms : {};
  const stay = isObject(trip.stay) ? trip.stay : {};
  const transport = isObject(trip.transport) ? trip.transport : {};
  const budget = isObject(trip.budget) ? trip.budget : {};

  const startDate = dateStr(dates.start_date);
  const endDate = dateStr(dates.end_date);
  const exact = typeof dates.exact === 'boolean' ? dates.exact : Boolean(startDate && endDate);

  const nights = int(trip.nights);
  const days = int(trip.days) ?? (nights !== null ? nights + 1 : null);

  const budgetTypeRaw = str(budget.type);
  const budgetType: BudgetType | null =
    budgetTypeRaw === 'per_person' ? 'per_person' : budgetTypeRaw === 'total' ? 'total' : null;

  const value: QualifiedLeadPayload = {
    bot_session_id: botSessionId,
    traveller: {
      name: str(traveller.name),
      phone,
      email: str(traveller.email),
    },
    source: {
      type: str(source.type) ?? 'meta_whatsapp_ad',
      campaign_id: str(source.campaign_id),
      campaign_name: str(source.campaign_name),
      adset_id: str(source.adset_id),
      ad_id: str(source.ad_id),
      ad_name: str(source.ad_name),
      referral_data: isObject(source.referral_data) ? source.referral_data : null,
    },
    trip: {
      destination_primary: destination,
      destinations: strList(trip.destinations),
      departure_city: str(trip.departure_city),
      travel_start_date: startDate,
      travel_end_date: endDate,
      travel_month: str(dates.travel_month) ?? str(trip.travel_month),
      dates_flexible: !exact,
      flexibility_days: int(dates.flexibility_days),
      nights,
      days,
      adults: int(travellers.adults) ?? int(trip.adults) ?? 0,
      children: int(travellers.children) ?? int(trip.children) ?? 0,
      infants: int(travellers.infants) ?? int(trip.infants) ?? 0,
      child_ages: intList(travellers.child_ages),
      room_count: int(rooms.count),
      room_configuration: str(rooms.configuration),
      hotel_category: str(stay.category),
      meal_plan: str(stay.meal_plan),
      hotel_preferences: strList(stay.preferences),
      vehicle_type: str(transport.vehicle_type),
      pickup_location: str(transport.pickup),
      drop_location: str(transport.drop),
      budget_amount: money(budget.amount),
      budget_type: budgetType,
      activities: strList(trip.activities),
      special_requests: str(trip.special_requests),
      qualification_summary: str(trip.qualification_summary),
    },
    conversation_id: str(raw.conversation_id),
  };

  return { ok: true, value };
}

// ------------------------------------------------------------
// coercion helpers — lenient, never throw
// ------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim();
    return t.length ? t.slice(0, 2000) : null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function int(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.round(v));
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

function money(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v.toFixed(2);
  if (typeof v === 'string') {
    const cleaned = v.replace(/[,\s₹]/g, '');
    if (/^\d+(\.\d{1,2})?$/.test(cleaned)) return Number(cleaned).toFixed(2);
  }
  return null;
}

function dateStr(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
  if (!m) return null;
  const d = new Date(`${m[1]}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : m[1];
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(str).filter((s): s is string => s !== null).slice(0, 50);
}

function intList(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.map(int).filter((n): n is number => n !== null).slice(0, 20);
}
