// ============================================================
// GET /api/travel/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Every confirmed trip overlapping the window, for the trip
// calendar. Returns one entry per booking with the span the
// calendar needs to lay it out, plus the operational facts an
// agent wants at a glance (pax, supplier, balance due).
//
// Also returns the callbacks + due follow-ups inside the window
// so the calendar can overlay "what has to happen" on top of
// "who is travelling" — `include=tasks`.
// ============================================================

import { travelRoute, query } from '@/lib/travel/route';
import { listBookingsForCalendar } from '@/lib/travel/bookings';
import { listTasks } from '@/lib/travel/tasks';

/** Default window: the current month plus a month either side. */
function defaultWindow(now = new Date()): { from: string; to: string } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 0));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

function isDate(v: string | null): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

export const GET = travelRoute('viewer', async (ctx, request) => {
  const q = query(request);
  const fallback = defaultWindow();
  const from = isDate(q.get('from')) ? (q.get('from') as string) : fallback.from;
  const to = isDate(q.get('to')) ? (q.get('to') as string) : fallback.to;

  const bookings = await listBookingsForCalendar(ctx.supabase, ctx.accountId, from, to);

  const trips = bookings.map((b) => ({
    booking_id: b.id,
    booking_number: b.booking_number,
    traveller_name: b.traveller_name,
    destination: b.destination_primary,
    start_date: b.travel_start_date,
    // A booking with no end date is a single-day entry.
    end_date: b.travel_end_date ?? b.travel_start_date,
    nights: b.nights,
    pax: (b.adults ?? 0) + (b.children ?? 0),
    adults: b.adults,
    children: b.children,
    status: b.status,
    supplier_name: b.supplier?.name ?? null,
    traveller_total: b.traveller_total,
    customer_balance: b.customer_balance,
  }));

  let tasks: unknown[] = [];
  if (q.get('include') === 'tasks') {
    const rows = await listTasks(
      ctx.supabase,
      ctx.accountId,
      { status: 'open', dueBefore: `${to}T23:59:59Z`, limit: 300 },
      ctx.userId
    );
    tasks = rows
      .filter((t) => t.due_at && t.due_at.slice(0, 10) >= from)
      .map((t) => ({
        task_id: t.id,
        travel_lead_id: t.travel_lead_id,
        booking_id: t.booking_id,
        title: t.title,
        task_type: t.task_type,
        priority: t.priority,
        due_at: t.due_at,
        assigned_to: t.assigned_to,
        traveller_name: t.travel_lead?.traveller_name ?? null,
      }));
  }

  return { from, to, trips, tasks };
});
