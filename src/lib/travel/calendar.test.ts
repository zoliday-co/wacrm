import { describe, it, expect } from 'vitest';
import {
  addDays,
  buildCalendarMonth,
  daysBetween,
  departureBuckets,
  gridWindow,
  shiftMonth,
  tripsOnDay,
  weekdayIndex,
  type CalendarTrip,
} from './calendar';

function trip(partial: Partial<CalendarTrip> & { booking_id: string; start_date: string }): CalendarTrip {
  return {
    booking_number: `OLI-2026-${partial.booking_id}`,
    traveller_name: 'Vishal',
    destination: 'Kerala',
    end_date: partial.start_date,
    nights: 1,
    pax: 2,
    status: 'CONFIRMED',
    supplier_name: 'Kerala Routes',
    traveller_total: '73500.00',
    customer_balance: '43500.00',
    ...partial,
  };
}

describe('calendar date helpers', () => {
  it('walks days without timezone drift', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-10-01', '2026-10-06')).toBe(5);
  });

  it('indexes weekdays Monday-first', () => {
    // 2026-10-05 is a Monday.
    expect(weekdayIndex('2026-10-05')).toBe(0);
    expect(weekdayIndex('2026-10-11')).toBe(6);
  });

  it('shifts months across a year boundary', () => {
    expect(shiftMonth('2026-12-01', 1)).toBe('2027-01-01');
    expect(shiftMonth('2026-01-01', -1)).toBe('2025-12-01');
  });

  it('pads the grid to whole Monday→Sunday weeks', () => {
    // October 2026 starts on a Thursday and ends on a Saturday.
    const { from, to } = gridWindow('2026-10-01');
    expect(weekdayIndex(from)).toBe(0);
    expect(weekdayIndex(to)).toBe(6);
    expect(from <= '2026-10-01').toBe(true);
    expect(to >= '2026-10-31').toBe(true);
  });
});

describe('buildCalendarMonth', () => {
  it('lays out whole weeks and marks the days outside the month', () => {
    const month = buildCalendarMonth('2026-10-01', [], [], '2026-10-15');
    expect(month.label).toBe('October 2026');
    for (const week of month.weeks) expect(week.days).toHaveLength(7);
    const inMonth = month.weeks.flatMap((w) => w.days).filter((d) => d.inMonth);
    expect(inMonth).toHaveLength(31);
    expect(inMonth[0].date).toBe('2026-10-01');
    const today = month.weeks.flatMap((w) => w.days).filter((d) => d.isToday);
    expect(today).toHaveLength(1);
    expect(today[0].date).toBe('2026-10-15');
  });

  it('renders a multi-day trip as one bar per week, split at the week boundary', () => {
    // 2026-10-09 (Fri) → 2026-10-14 (Wed) crosses one week boundary.
    const month = buildCalendarMonth('2026-10-01', [trip({ booking_id: 'a', start_date: '2026-10-09', end_date: '2026-10-14' })]);
    const segments = month.weeks.flatMap((w) => w.segments);
    expect(segments).toHaveLength(2);

    const [first, second] = segments;
    expect(first.isStart).toBe(true);
    expect(first.isEnd).toBe(false);
    expect(first.startCol).toBe(weekdayIndex('2026-10-09'));
    expect(first.startCol + first.span).toBe(7); // runs to the end of the week

    expect(second.isStart).toBe(false);
    expect(second.isEnd).toBe(true);
    expect(second.startCol).toBe(0);
    expect(second.span).toBe(weekdayIndex('2026-10-14') + 1);
  });

  it('clips a trip that starts before and ends after the visible window', () => {
    const month = buildCalendarMonth('2026-10-01', [trip({ booking_id: 'long', start_date: '2026-08-01', end_date: '2026-12-31' })]);
    const segments = month.weeks.flatMap((w) => w.segments);
    expect(segments).toHaveLength(month.weeks.length);
    for (const s of segments) {
      expect(s.startCol).toBe(0);
      expect(s.span).toBe(7);
      expect(s.isStart).toBe(false);
      expect(s.isEnd).toBe(false);
    }
  });

  it('stacks overlapping trips into separate lanes and reuses a lane once free', () => {
    const month = buildCalendarMonth('2026-10-01', [
      trip({ booking_id: 'a', start_date: '2026-10-05', end_date: '2026-10-07' }),
      trip({ booking_id: 'b', start_date: '2026-10-06', end_date: '2026-10-08' }),
      // Starts after 'a' has finished, so it can share lane 0.
      trip({ booking_id: 'c', start_date: '2026-10-09', end_date: '2026-10-10' }),
    ]);
    const week = month.weeks.find((w) => w.days.some((d) => d.date === '2026-10-05'))!;
    const byId = new Map(week.segments.map((s) => [s.trip.booking_id, s]));
    expect(byId.get('a')!.lane).toBe(0);
    expect(byId.get('b')!.lane).toBe(1);
    expect(byId.get('c')!.lane).toBe(0);
    expect(week.lanes).toBe(2);
  });

  it('puts a due task on its own day cell', () => {
    const month = buildCalendarMonth(
      '2026-10-01',
      [],
      [{ task_id: 't1', travel_lead_id: 'l1', booking_id: null, title: 'Call Vishal', task_type: 'CALLBACK', priority: 'HIGH', due_at: '2026-10-16T05:30:00.000Z', traveller_name: 'Vishal' }]
    );
    const days = month.weeks.flatMap((w) => w.days);
    expect(days.find((d) => d.date === '2026-10-16')!.tasks).toHaveLength(1);
    expect(days.filter((d) => d.tasks.length)).toHaveLength(1);
  });

  it('treats a booking with no end date as a single day', () => {
    const month = buildCalendarMonth('2026-10-01', [trip({ booking_id: 'one', start_date: '2026-10-20', end_date: null })]);
    const segments = month.weeks.flatMap((w) => w.segments);
    expect(segments).toHaveLength(1);
    expect(segments[0].span).toBe(1);
    expect(segments[0].isStart && segments[0].isEnd).toBe(true);
  });
});

describe('tripsOnDay / departureBuckets', () => {
  const trips = [
    trip({ booking_id: 'a', start_date: '2026-10-09', end_date: '2026-10-14' }),
    trip({ booking_id: 'b', start_date: '2026-10-20', end_date: '2026-10-22' }),
  ];

  it('includes a trip on every day it runs, not just its start', () => {
    expect(tripsOnDay(trips, '2026-10-09').map((t) => t.booking_id)).toEqual(['a']);
    expect(tripsOnDay(trips, '2026-10-12').map((t) => t.booking_id)).toEqual(['a']);
    expect(tripsOnDay(trips, '2026-10-14').map((t) => t.booking_id)).toEqual(['a']);
    expect(tripsOnDay(trips, '2026-10-15')).toEqual([]);
  });

  it('buckets by how soon each trip departs', () => {
    const buckets = departureBuckets(trips, '2026-10-12');
    const keys = buckets.map((b) => b.key);
    // 'a' is mid-trip on the 12th; 'b' departs in 8 days.
    expect(keys).toContain('travelling');
    expect(keys).toContain('month');
    expect(buckets.find((b) => b.key === 'travelling')!.trips[0].booking_id).toBe('a');
    expect(buckets.find((b) => b.key === 'month')!.trips[0].booking_id).toBe('b');
  });

  it('drops trips that already finished', () => {
    expect(departureBuckets(trips, '2026-11-01')).toEqual([]);
  });
});
