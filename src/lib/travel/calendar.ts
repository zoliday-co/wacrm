// ============================================================
// Trip-calendar layout — pure, unit-testable.
//
// Turns a flat list of bookings (each with a start/end date) into
// a month grid where a multi-day trip renders as ONE continuous
// bar across the days it spans, wrapping at week boundaries.
//
// The grid is built from date strings only (YYYY-MM-DD), never
// `Date` arithmetic across timezones — a trip starting on the 1st
// must render on the 1st for a viewer in any timezone.
// ============================================================

export interface CalendarTrip {
  booking_id: string;
  booking_number: string;
  traveller_name: string | null;
  destination: string | null;
  start_date: string | null;
  end_date: string | null;
  nights: number | null;
  pax: number;
  adults?: number;
  children?: number;
  status: string;
  supplier_name: string | null;
  traveller_total: string;
  customer_balance: string;
}

export interface CalendarTask {
  task_id: string;
  travel_lead_id: string | null;
  booking_id: string | null;
  title: string;
  task_type: string;
  priority: string;
  due_at: string | null;
  traveller_name: string | null;
}

/** One trip's bar inside one week row. */
export interface TripSegment {
  trip: CalendarTrip;
  /** 0–6 column index within the week (Mon=0). */
  startCol: number;
  /** How many columns the bar spans (1–7). */
  span: number;
  /** True when the trip actually begins in this segment. */
  isStart: boolean;
  /** True when the trip actually ends in this segment. */
  isEnd: boolean;
  /** Stacking row inside the week, so overlapping trips never collide. */
  lane: number;
}

export interface CalendarDay {
  date: string;
  /** Day-of-month number. */
  day: number;
  inMonth: boolean;
  isToday: boolean;
  tasks: CalendarTask[];
}

export interface CalendarWeek {
  days: CalendarDay[];
  segments: TripSegment[];
  /** How many lanes this week needs (max lane + 1). */
  lanes: number;
}

export interface CalendarMonth {
  /** First of the month, YYYY-MM-DD. */
  monthStart: string;
  label: string;
  weeks: CalendarWeek[];
  /** Window the grid covers, for fetching. */
  from: string;
  to: string;
}

const MS_DAY = 86_400_000;

export function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function parseISODate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

export function addDays(iso: string, days: number): string {
  return toISODate(new Date(parseISODate(iso).getTime() + days * MS_DAY));
}

export function daysBetween(a: string, b: string): number {
  return Math.round((parseISODate(b).getTime() - parseISODate(a).getTime()) / MS_DAY);
}

/** Monday-first weekday index (Mon=0 … Sun=6). */
export function weekdayIndex(iso: string): number {
  return (parseISODate(iso).getUTCDay() + 6) % 7;
}

export function monthLabel(monthStart: string): string {
  return parseISODate(monthStart).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** First of the month containing `iso`. */
export function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

export function shiftMonth(monthStart: string, delta: number): string {
  const d = parseISODate(monthStart);
  return toISODate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1)));
}

/** The visible grid window: the Monday on/before the 1st → the Sunday on/after the last. */
export function gridWindow(monthStart: string): { from: string; to: string } {
  const first = startOfMonth(monthStart);
  const from = addDays(first, -weekdayIndex(first));
  const d = parseISODate(first);
  const lastDay = toISODate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
  const to = addDays(lastDay, 6 - weekdayIndex(lastDay));
  return { from, to };
}

/**
 * Build the month grid. Trips are clipped to the window and split
 * at week boundaries; each week packs its bars into lanes so two
 * overlapping trips never draw on top of each other.
 */
export function buildCalendarMonth(
  monthStart: string,
  trips: CalendarTrip[],
  tasks: CalendarTask[] = [],
  today = toISODate(new Date())
): CalendarMonth {
  const month = startOfMonth(monthStart);
  const { from, to } = gridWindow(month);
  const weekCount = Math.ceil((daysBetween(from, to) + 1) / 7);
  const monthPrefix = month.slice(0, 7);

  const tasksByDay = new Map<string, CalendarTask[]>();
  for (const t of tasks) {
    if (!t.due_at) continue;
    const day = t.due_at.slice(0, 10);
    const list = tasksByDay.get(day) ?? [];
    list.push(t);
    tasksByDay.set(day, list);
  }

  // Sort so longer / earlier trips take the top lanes — a stable,
  // readable order rather than whatever the DB returned.
  const ordered = [...trips]
    .filter((t) => t.start_date)
    .sort((a, b) => {
      const s = (a.start_date ?? '').localeCompare(b.start_date ?? '');
      if (s !== 0) return s;
      return daysBetween(a.start_date!, a.end_date ?? a.start_date!) >= daysBetween(b.start_date!, b.end_date ?? b.start_date!) ? -1 : 1;
    });

  const weeks: CalendarWeek[] = [];
  for (let w = 0; w < weekCount; w++) {
    const weekStart = addDays(from, w * 7);
    const weekEnd = addDays(weekStart, 6);

    const days: CalendarDay[] = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(weekStart, i);
      days.push({
        date,
        day: Number(date.slice(8, 10)),
        inMonth: date.slice(0, 7) === monthPrefix,
        isToday: date === today,
        tasks: tasksByDay.get(date) ?? [],
      });
    }

    // Lane packing: a lane is free for a segment when no segment
    // already placed in it overlaps the new one's columns.
    const laneEnds: number[] = [];
    const segments: TripSegment[] = [];
    for (const trip of ordered) {
      const tripStart = trip.start_date!;
      const tripEnd = trip.end_date ?? tripStart;
      if (tripEnd < weekStart || tripStart > weekEnd) continue;

      const segStart = tripStart < weekStart ? weekStart : tripStart;
      const segEnd = tripEnd > weekEnd ? weekEnd : tripEnd;
      const startCol = daysBetween(weekStart, segStart);
      const span = daysBetween(segStart, segEnd) + 1;

      let lane = laneEnds.findIndex((end) => end <= startCol);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(0);
      }
      laneEnds[lane] = startCol + span;

      segments.push({
        trip,
        startCol,
        span,
        isStart: segStart === tripStart,
        isEnd: segEnd === tripEnd,
        lane,
      });
    }

    weeks.push({ days, segments, lanes: laneEnds.length });
  }

  return { monthStart: month, label: monthLabel(month), weeks, from, to };
}

/** Trips that begin, end or run through a given day — for the day drawer. */
export function tripsOnDay(trips: CalendarTrip[], date: string): CalendarTrip[] {
  return trips.filter((t) => {
    if (!t.start_date) return false;
    const end = t.end_date ?? t.start_date;
    return t.start_date <= date && end >= date;
  });
}

/** Group upcoming trips into departure buckets for the side rail. */
export function departureBuckets(
  trips: CalendarTrip[],
  today = toISODate(new Date())
): { key: string; label: string; trips: CalendarTrip[] }[] {
  const upcoming = trips.filter((t) => t.start_date && (t.end_date ?? t.start_date) >= today);
  const bucket = (t: CalendarTrip): string => {
    const days = daysBetween(today, t.start_date!);
    if (days < 0) return 'travelling';
    if (days === 0) return 'today';
    if (days <= 7) return 'week';
    if (days <= 30) return 'month';
    return 'later';
  };
  const labels: Record<string, string> = {
    travelling: 'Travelling now',
    today: 'Departing today',
    week: 'Next 7 days',
    month: 'Next 30 days',
    later: 'Later',
  };
  const order = ['travelling', 'today', 'week', 'month', 'later'];
  const grouped = new Map<string, CalendarTrip[]>();
  for (const t of upcoming) {
    const k = bucket(t);
    grouped.set(k, [...(grouped.get(k) ?? []), t]);
  }
  return order
    .filter((k) => grouped.has(k))
    .map((k) => ({
      key: k,
      label: labels[k],
      trips: (grouped.get(k) ?? []).sort((a, b) => (a.start_date ?? '').localeCompare(b.start_date ?? '')),
    }));
}
