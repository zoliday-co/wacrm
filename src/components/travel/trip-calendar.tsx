'use client';

// ============================================================
// Trip calendar — every confirmed trip on a month grid.
//
// A multi-day trip draws as one continuous bar across the days it
// spans (wrapping at week boundaries), so an agent can see at a
// glance who is travelling when, where the overlaps are, and which
// departures still owe money. Layout maths lives in
// `@/lib/travel/calendar` (pure + unit-tested); this file only
// renders it.
// ============================================================

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MapPin,
  Users,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { StatusBadge } from './status-badge';
import { formatMoney, toMinor } from '@/lib/travel/money';
import { fmtDate } from '@/lib/travel/format';
import {
  buildCalendarMonth,
  departureBuckets,
  gridWindow,
  shiftMonth,
  startOfMonth,
  toISODate,
  tripsOnDay,
  type CalendarTask,
  type CalendarTrip,
} from '@/lib/travel/calendar';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Bar colour by booking status — paid trips read as settled, unpaid as attention. */
function barClass(status: string, balanceDue: boolean): string {
  if (status === 'ONGOING') return 'bg-emerald-500/85 text-white';
  if (status === 'COMPLETED') return 'bg-muted-foreground/40 text-foreground';
  if (balanceDue) return 'bg-amber-500/80 text-amber-950';
  return 'bg-primary/80 text-primary-foreground';
}

export function TripCalendar() {
  const [month, setMonth] = useState(() => startOfMonth(toISODate(new Date())));
  const [trips, setTrips] = useState<CalendarTrip[] | null>(null);
  const [tasks, setTasks] = useState<CalendarTask[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const today = useMemo(() => toISODate(new Date()), []);

  const load = useCallback(async () => {
    setError(null);
    const { from, to } = gridWindow(month);
    try {
      const res = await fetch(`/api/travel/calendar?from=${from}&to=${to}&include=tasks`);
      const body = (await res.json()) as { trips?: CalendarTrip[]; tasks?: CalendarTask[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? 'Could not load the trip calendar');
      setTrips(body.trips ?? []);
      setTasks(body.tasks ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the trip calendar');
      setTrips([]);
    }
  }, [month]);

  useEffect(() => {
    void load();
  }, [load]);

  const grid = useMemo(
    () => buildCalendarMonth(month, trips ?? [], tasks, today),
    [month, trips, tasks, today],
  );
  const buckets = useMemo(() => departureBuckets(trips ?? [], today), [trips, today]);
  const dayTrips = useMemo(
    () => (selectedDay ? tripsOnDay(trips ?? [], selectedDay) : []),
    [selectedDay, trips],
  );

  const travellingNow = (trips ?? []).filter(
    (t) => t.start_date && t.start_date <= today && (t.end_date ?? t.start_date) >= today,
  ).length;
  const balanceOwed = (trips ?? []).reduce(
    (sum, t) => sum + toMinor(t.customer_balance),
    0n,
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Trip calendar</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every confirmed trip, laid out by travel dates.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">
            <ChevronLeft className="size-4" />
          </Button>
          <span className="min-w-40 text-center text-sm font-semibold">{grid.label}</span>
          <Button variant="outline" size="sm" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">
            <ChevronRight className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setMonth(startOfMonth(today));
              setSelectedDay(null);
            }}
          >
            Today
          </Button>
        </div>
      </div>

      {error ? (
        <Card>
          <CardContent className="py-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryTile label="Trips this view" value={String((trips ?? []).length)} />
        <SummaryTile label="Travelling now" value={String(travellingNow)} />
        <SummaryTile label="Customer balance due" value={formatMoney(balanceOwed)} />
      </div>

      {trips === null ? (
        <div className="flex h-64 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-start">
          <Card className="overflow-hidden">
            <CardContent className="p-0">
              {/* The grid scrolls horizontally on phones rather than squashing a week into 40px columns. */}
              <div className="overflow-x-auto">
                <div className="min-w-[680px]">
                  <div className="grid grid-cols-7 border-b border-border bg-muted/40">
                    {WEEKDAYS.map((d) => (
                      <div key={d} className="px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {d}
                      </div>
                    ))}
                  </div>

                  {grid.weeks.map((week) => (
                    <div key={week.days[0].date} className="relative border-b border-border last:border-b-0">
                      <div className="grid grid-cols-7">
                        {week.days.map((day) => (
                          <button
                            key={day.date}
                            type="button"
                            onClick={() => setSelectedDay(day.date === selectedDay ? null : day.date)}
                            aria-label={`Trips on ${fmtDate(day.date)}`}
                            aria-pressed={day.date === selectedDay}
                            className={[
                              'flex flex-col items-start gap-1 border-r border-border/60 px-2 pt-1.5 text-left transition-colors last:border-r-0',
                              // Room for the stacked bars, which are absolutely positioned below.
                              'min-h-24',
                              day.inMonth ? '' : 'bg-muted/30 text-muted-foreground',
                              day.date === selectedDay ? 'bg-primary/10' : 'hover:bg-muted/40',
                            ].join(' ')}
                            style={{ paddingBottom: `${week.lanes * 22 + 6}px` }}
                          >
                            <span
                              className={[
                                'flex size-6 items-center justify-center rounded-full text-xs font-medium',
                                day.isToday ? 'bg-primary text-primary-foreground' : '',
                              ].join(' ')}
                            >
                              {day.day}
                            </span>
                            {day.tasks.length > 0 ? (
                              <span className="truncate text-[10px] font-medium text-amber-600 dark:text-amber-400">
                                {day.tasks.length === 1 ? day.tasks[0].title : `${day.tasks.length} follow-ups`}
                              </span>
                            ) : null}
                          </button>
                        ))}
                      </div>

                      {/* Trip bars, absolutely positioned over the week's day cells. */}
                      <div className="pointer-events-none absolute inset-x-0 bottom-1.5">
                        {week.segments.map((seg) => {
                          const balanceDue = toMinor(seg.trip.customer_balance) > 0n;
                          return (
                            <Link
                              key={`${seg.trip.booking_id}-${seg.startCol}`}
                              href={`/bookings/${seg.trip.booking_id}`}
                              title={`${seg.trip.booking_number} · ${seg.trip.traveller_name ?? 'Traveller'} · ${seg.trip.destination ?? ''}`}
                              className={[
                                'pointer-events-auto absolute flex h-[18px] items-center truncate px-2 text-[11px] font-medium shadow-sm transition-opacity hover:opacity-90',
                                barClass(seg.trip.status, balanceDue),
                                seg.isStart ? 'rounded-l-full' : 'rounded-l-none',
                                seg.isEnd ? 'rounded-r-full' : 'rounded-r-none',
                              ].join(' ')}
                              style={{
                                left: `calc(${(seg.startCol / 7) * 100}% + 3px)`,
                                width: `calc(${(seg.span / 7) * 100}% - 6px)`,
                                bottom: `${seg.lane * 22}px`,
                              }}
                            >
                              <span className="truncate">
                                {seg.isStart
                                  ? `${seg.trip.traveller_name ?? seg.trip.booking_number}${seg.trip.destination ? ` · ${seg.trip.destination}` : ''}`
                                  : `↳ ${seg.trip.destination ?? seg.trip.booking_number}`}
                              </span>
                            </Link>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="space-y-4">
            {selectedDay ? (
              <Card>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">{fmtDate(selectedDay)}</p>
                    <Button variant="ghost" size="sm" onClick={() => setSelectedDay(null)}>
                      Clear
                    </Button>
                  </div>
                  {dayTrips.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No trips running on this day.</p>
                  ) : (
                    dayTrips.map((t) => <TripRow key={t.booking_id} trip={t} />)
                  )}
                  {grid.weeks
                    .flatMap((w) => w.days)
                    .find((d) => d.date === selectedDay)
                    ?.tasks.map((task) => (
                      <Link
                        key={task.task_id}
                        href={task.travel_lead_id ? `/leads/${task.travel_lead_id}` : '/followups'}
                        className="block rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs"
                      >
                        <span className="font-medium">{task.title}</span>
                        {task.traveller_name ? (
                          <span className="text-muted-foreground"> · {task.traveller_name}</span>
                        ) : null}
                      </Link>
                    ))}
                </CardContent>
              </Card>
            ) : null}

            {buckets.map((bucket) => (
              <Card key={bucket.key}>
                <CardContent className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {bucket.label}
                  </p>
                  {bucket.trips.slice(0, 6).map((t) => (
                    <TripRow key={t.booking_id} trip={t} compact />
                  ))}
                </CardContent>
              </Card>
            ))}

            {buckets.length === 0 && !selectedDay ? (
              <Card>
                <CardContent className="py-8 text-center text-sm text-muted-foreground">
                  <CalendarDays className="mx-auto mb-2 size-6 opacity-50" />
                  No upcoming trips. Confirmed bookings appear here with their travel dates.
                </CardContent>
              </Card>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="py-4">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className="mt-1 text-xl font-bold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}

function TripRow({ trip, compact }: { trip: CalendarTrip; compact?: boolean }) {
  const balanceDue = toMinor(trip.customer_balance) > 0n;
  return (
    <Link
      href={`/bookings/${trip.booking_id}`}
      className="block rounded-lg border border-border/60 px-3 py-2 transition-colors hover:bg-muted/40"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{trip.traveller_name ?? trip.booking_number}</span>
        {compact ? null : <StatusBadge value={trip.status} />}
      </div>
      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        {trip.destination ? (
          <span className="inline-flex items-center gap-1">
            <MapPin className="size-3" />
            {trip.destination}
          </span>
        ) : null}
        <span className="inline-flex items-center gap-1">
          <Users className="size-3" />
          {trip.pax}
        </span>
        <span>
          {fmtDate(trip.start_date)}
          {trip.end_date && trip.end_date !== trip.start_date ? ` – ${fmtDate(trip.end_date)}` : ''}
        </span>
      </p>
      {balanceDue ? (
        <p className="mt-1 text-xs font-medium text-amber-600 dark:text-amber-400">
          {formatMoney(trip.customer_balance)} due
        </p>
      ) : null}
    </Link>
  );
}
