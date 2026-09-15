// ============================================================
// Scheduled maintenance for the travel layer — invoked by
// GET /api/travel/cron (cron-secret protected). Each job is
// isolated so one failure never blocks the others.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { runRfqMaintenance } from './rfq';
import { runTaskReminders } from './tasks';
import { rollBookingStatuses } from './bookings';

export interface CronReport {
  rfq: { reminders: number; expired: number } | { error: string };
  task_reminders: number | { error: string };
  booking_status_changes: number | { error: string };
  traveller_quotes_expired: number | { error: string };
  ran_at: string;
}

export async function runTravelCron(now = new Date()): Promise<CronReport> {
  const admin = supabaseAdmin();
  const report: CronReport = {
    rfq: { reminders: 0, expired: 0 },
    task_reminders: 0,
    booking_status_changes: 0,
    traveller_quotes_expired: 0,
    ran_at: now.toISOString(),
  };

  try {
    report.rfq = await runRfqMaintenance(admin, now);
  } catch (err) {
    report.rfq = { error: msg(err) };
  }
  try {
    report.task_reminders = await runTaskReminders(admin, now);
  } catch (err) {
    report.task_reminders = { error: msg(err) };
  }
  try {
    report.booking_status_changes = await rollBookingStatuses(admin, now);
  } catch (err) {
    report.booking_status_changes = { error: msg(err) };
  }
  try {
    const today = now.toISOString().slice(0, 10);
    const { data } = await admin
      .from('traveller_quotes')
      .update({ status: 'EXPIRED' })
      .in('status', ['SENT', 'VIEWED'])
      .lt('valid_until', today)
      .select('id');
    report.traveller_quotes_expired = data?.length ?? 0;
  } catch (err) {
    report.traveller_quotes_expired = { error: msg(err) };
  }

  console.log('[travel/cron] run complete', report);
  return report;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
