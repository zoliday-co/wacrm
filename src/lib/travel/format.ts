// ============================================================
// Trip-summary formatting helpers — pure, shared by the UI, the
// supplier RFQ message and the traveller notifications. One
// place to render "5N/6D", "4 Adults + 2 Children", "Oct 2026,
// flexible ±3 days" so every surface says it the same way.
// ============================================================

import { hotelCategoryLabel } from './constants';

export interface TripSummaryFields {
  destination_primary?: string | null;
  destinations?: string[] | null;
  departure_city?: string | null;
  travel_start_date?: string | null;
  travel_end_date?: string | null;
  travel_month?: string | null;
  dates_flexible?: boolean | null;
  flexibility_days?: number | null;
  nights?: number | null;
  days?: number | null;
  adults?: number | null;
  children?: number | null;
  infants?: number | null;
  child_ages?: number[] | null;
  room_count?: number | null;
  room_configuration?: string | null;
  hotel_category?: string | null;
  hotel_preferences?: string[] | null;
  meal_plan?: string | null;
  vehicle_type?: string | null;
  pickup_location?: string | null;
  drop_location?: string | null;
  budget_amount?: string | null;
  budget_type?: string | null;
  activities?: string[] | null;
  special_requests?: string | null;
}

export function durationLabel(t: TripSummaryFields): string {
  if (t.nights == null && t.days == null) return '';
  const n = t.nights ?? Math.max(0, (t.days ?? 1) - 1);
  const d = t.days ?? n + 1;
  return `${n}N/${d}D`;
}

export function paxLabel(t: TripSummaryFields): string {
  const parts: string[] = [];
  const a = t.adults ?? 0;
  const c = t.children ?? 0;
  const i = t.infants ?? 0;
  if (a) parts.push(`${a} ${a === 1 ? 'Adult' : 'Adults'}`);
  if (c) parts.push(`${c} ${c === 1 ? 'Child' : 'Children'}`);
  if (i) parts.push(`${i} ${i === 1 ? 'Infant' : 'Infants'}`);
  return parts.join(' + ') || '—';
}

export function childAgesLabel(t: TripSummaryFields): string {
  const ages = t.child_ages ?? [];
  if (!ages.length) return '';
  return `Child ages: ${ages.join(', ')}`;
}

export function datesLabel(t: TripSummaryFields): string {
  if (t.travel_start_date && t.travel_end_date) {
    const base = `${fmtDate(t.travel_start_date)} – ${fmtDate(t.travel_end_date)}`;
    return t.dates_flexible && t.flexibility_days
      ? `${base} (flexible ±${t.flexibility_days} days)`
      : base;
  }
  if (t.travel_start_date) {
    return `From ${fmtDate(t.travel_start_date)}${t.dates_flexible ? ' (flexible)' : ''}`;
  }
  if (t.travel_month) {
    return t.flexibility_days
      ? `${t.travel_month}, flexible ±${t.flexibility_days} days`
      : `${t.travel_month}${t.dates_flexible ? ' (flexible)' : ''}`;
  }
  return t.dates_flexible ? 'Dates flexible' : 'Dates TBC';
}

export function stayLabel(t: TripSummaryFields): string {
  const parts = [hotelCategoryLabel(t.hotel_category)];
  if (t.meal_plan) parts.push(t.meal_plan);
  return parts.filter((p) => p && p !== '—').join(' • ') || '—';
}

export function destinationsLabel(t: TripSummaryFields): string {
  const subs = (t.destinations ?? []).filter(Boolean);
  if (!subs.length) return t.destination_primary ?? '—';
  return `${t.destination_primary ?? ''} (${subs.join(', ')})`.trim();
}

export function roomsLabel(t: TripSummaryFields): string {
  if (!t.room_count && !t.room_configuration) return '';
  const count = t.room_count ? `${t.room_count} ${t.room_count === 1 ? 'room' : 'rooms'}` : '';
  return [count, t.room_configuration].filter(Boolean).join(' — ');
}

export function budgetLabel(t: TripSummaryFields, currency = 'INR'): string {
  if (!t.budget_amount) return '';
  const amount = formatInr(t.budget_amount, currency);
  return t.budget_type === 'per_person' ? `${amount} per person` : `${amount} total`;
}

/** Compact one-liner for headers: "Kerala • 5N/6D • Oct 2026". */
export function headline(t: TripSummaryFields): string {
  return [t.destination_primary, durationLabel(t), t.travel_month ?? (t.travel_start_date ? fmtDate(t.travel_start_date) : null)]
    .filter(Boolean)
    .join(' • ');
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatInr(amount: string, currency: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${currency} ${n}`;
  }
}
