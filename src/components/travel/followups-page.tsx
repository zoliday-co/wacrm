'use client';

// ============================================================
// Follow-up scheduler — the agent's working queue.
//
// Every scheduled call, callback, supplier chase and payment
// reminder in one place, bucketed by urgency (overdue → today →
// this week → later). Agents can schedule a new follow-up,
// snooze one, reassign it, or mark it done without opening the
// lead. The cron (`runTaskReminders`) pushes an in-app
// notification when a task falls due; rescheduling re-arms it.
// ============================================================

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { CalendarClock, Check, Loader2, Plus, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { StatusBadge } from './status-badge';
import { fmtDateTime } from '@/lib/travel/format';
import type { TaskPriority, TaskType, TravelTask } from '@/types/travel';

type Scope = 'mine' | 'all';
type Bucket = { key: string; label: string; tone: string; tasks: TravelTask[] };

const TASK_TYPES: TaskType[] = ['CALL', 'FOLLOW_UP', 'CALLBACK', 'SUPPLIER', 'PAYMENT', 'OPERATIONS', 'GENERAL'];
const PRIORITIES: TaskPriority[] = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

/** Snooze offsets, in hours — the reschedules agents actually reach for. */
const SNOOZE = [
  { label: '+1h', hours: 1 },
  { label: '+3h', hours: 3 },
  { label: 'Tomorrow', hours: 24 },
  { label: '+3d', hours: 72 },
];

function bucketTasks(tasks: TravelTask[], now = new Date()): Bucket[] {
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  const endOfWeek = new Date(endOfToday.getTime() + 6 * 86_400_000);

  const buckets: Bucket[] = [
    { key: 'overdue', label: 'Overdue', tone: 'text-destructive', tasks: [] },
    { key: 'today', label: 'Today', tone: 'text-primary', tasks: [] },
    { key: 'week', label: 'This week', tone: 'text-foreground', tasks: [] },
    { key: 'later', label: 'Later', tone: 'text-muted-foreground', tasks: [] },
    { key: 'unscheduled', label: 'No due date', tone: 'text-muted-foreground', tasks: [] },
  ];
  const by = Object.fromEntries(buckets.map((b) => [b.key, b])) as Record<string, Bucket>;

  for (const t of tasks) {
    if (!t.due_at) by.unscheduled.tasks.push(t);
    else {
      const due = new Date(t.due_at);
      if (due < now) by.overdue.tasks.push(t);
      else if (due <= endOfToday) by.today.tasks.push(t);
      else if (due <= endOfWeek) by.week.tasks.push(t);
      else by.later.tasks.push(t);
    }
  }
  for (const b of buckets) {
    b.tasks.sort((a, c) => (a.due_at ?? '').localeCompare(c.due_at ?? ''));
  }
  return buckets.filter((b) => b.tasks.length > 0);
}

/** `datetime-local` wants local wall-clock time, not an ISO instant. */
function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function FollowupsPage() {
  const [tasks, setTasks] = useState<TravelTask[] | null>(null);
  const [scope, setScope] = useState<Scope>('all');
  const [showDone, setShowDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [members, setMembers] = useState<{ user_id: string; full_name: string }[]>([]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/travel/tasks?status=${showDone ? 'all' : 'open'}&scope=${scope}`);
      const body = (await res.json()) as { tasks?: TravelTask[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? 'Could not load follow-ups');
      setTasks(body.tasks ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load follow-ups');
      setTasks([]);
    }
  }, [scope, showDone]);

  useEffect(() => {
    void load();
  }, [load]);

  // Assignee options come from the account roster the dashboard already exposes.
  useEffect(() => {
    fetch('/api/account/members')
      .then((r) => (r.ok ? r.json() : { members: [] }))
      .then((b: { members?: { user_id: string; full_name: string }[] }) => setMembers(b.members ?? []))
      .catch(() => setMembers([]));
  }, []);

  const buckets = useMemo(() => bucketTasks((tasks ?? []).filter((t) => showDone || t.status !== 'DONE')), [tasks, showDone]);
  const openCount = (tasks ?? []).filter((t) => t.status === 'OPEN' || t.status === 'IN_PROGRESS').length;
  const overdueCount = buckets.find((b) => b.key === 'overdue')?.tasks.length ?? 0;

  async function patchTask(id: string, patch: Record<string, unknown>, successMessage: string) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/travel/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? 'Could not update the follow-up');
      }
      toast.success(successMessage);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update the follow-up');
    } finally {
      setBusyId(null);
    }
  }

  async function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const leadId = String(data.get('lead_id') ?? '').trim();
    const dueRaw = String(data.get('due_at') ?? '');
    setCreating(true);
    try {
      // A lead-scoped follow-up posts to the lead route so it also
      // becomes the lead's "next action"; a standalone one doesn't.
      const url = leadId ? `/api/travel/leads/${leadId}/tasks` : '/api/travel/tasks';
      const payload: Record<string, unknown> = {
        follow_up: Boolean(leadId),
        title: String(data.get('title') ?? '').trim(),
        note: String(data.get('description') ?? '').trim() || null,
        description: String(data.get('description') ?? '').trim() || null,
        task_type: data.get('task_type'),
        priority: data.get('priority'),
        due_at: dueRaw ? new Date(dueRaw).toISOString() : null,
        assigned_to: String(data.get('assigned_to') ?? '') || null,
      };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? 'Could not schedule the follow-up');
      }
      form.reset();
      toast.success('Follow-up scheduled');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not schedule the follow-up');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Follow-ups</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {openCount} open
            {overdueCount > 0 ? ` · ${overdueCount} overdue` : ''}. Reminders go out automatically when a follow-up falls due.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Scope"
            value={scope}
            onChange={(e) => setScope(e.target.value as Scope)}
            className="h-9 rounded-lg border border-input bg-background px-2 text-sm"
          >
            <option value="all">Everyone</option>
            <option value="mine">Assigned to me</option>
          </select>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
            Show completed
          </label>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className="size-4" />
            Refresh
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Plus className="size-4" />
            Schedule a follow-up
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={createTask} className="grid gap-3 md:grid-cols-12">
            <Input
              className="md:col-span-4"
              name="title"
              required
              placeholder="Call Vishal about the Munnar upgrade"
              aria-label="Follow-up title"
            />
            <Input
              className="md:col-span-3"
              name="due_at"
              type="datetime-local"
              required
              aria-label="Due at"
              defaultValue={toLocalInput(new Date(Date.now() + 86_400_000))}
            />
            <select name="task_type" aria-label="Type" defaultValue="FOLLOW_UP" className="h-9 rounded-lg border border-input bg-background px-2 text-sm md:col-span-2">
              {TASK_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
            <select name="priority" aria-label="Priority" defaultValue="NORMAL" className="h-9 rounded-lg border border-input bg-background px-2 text-sm md:col-span-1">
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <select name="assigned_to" aria-label="Assign to" className="h-9 rounded-lg border border-input bg-background px-2 text-sm md:col-span-2">
              <option value="">Assign to me</option>
              {members.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.full_name}
                </option>
              ))}
            </select>
            <Input className="md:col-span-4" name="lead_id" placeholder="Lead ID (optional)" aria-label="Lead ID" />
            <Textarea className="md:col-span-6" name="description" placeholder="Context for whoever picks this up" rows={1} />
            <Button className="md:col-span-2" disabled={creating}>
              {creating ? <Loader2 className="size-4 animate-spin" /> : <CalendarClock className="size-4" />}
              Schedule
            </Button>
          </form>
        </CardContent>
      </Card>

      {error ? (
        <Card>
          <CardContent className="py-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : null}

      {tasks === null ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : buckets.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Nothing scheduled. Follow-ups created from a call log or a callback request land here.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {buckets.map((bucket) => (
            <section key={bucket.key} className="space-y-2">
              <h2 className={`text-xs font-semibold uppercase tracking-wider ${bucket.tone}`}>
                {bucket.label} · {bucket.tasks.length}
              </h2>
              <div className="grid gap-2">
                {bucket.tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    busy={busyId === task.id}
                    onSnooze={(hours) =>
                      void patchTask(
                        task.id,
                        { due_at: new Date(Date.now() + hours * 3_600_000).toISOString() },
                        'Follow-up rescheduled',
                      )
                    }
                    onDone={() => void patchTask(task.id, { status: 'DONE' }, 'Follow-up completed')}
                    onReopen={() => void patchTask(task.id, { status: 'OPEN' }, 'Follow-up reopened')}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function TaskRow({
  task,
  busy,
  onSnooze,
  onDone,
  onReopen,
}: {
  task: TravelTask;
  busy: boolean;
  onSnooze: (hours: number) => void;
  onDone: () => void;
  onReopen: () => void;
}) {
  const done = task.status === 'DONE' || task.status === 'CANCELLED';
  const lead = task.travel_lead;
  return (
    <Card className={done ? 'opacity-60' : undefined}>
      <CardContent className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className={`font-medium ${done ? 'line-through' : ''}`}>{task.title}</p>
            {task.priority === 'URGENT' || task.priority === 'HIGH' ? (
              <StatusBadge value={task.priority} />
            ) : null}
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
              {task.task_type.replaceAll('_', ' ')}
            </span>
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
            <span>{task.due_at ? fmtDateTime(task.due_at) : 'No due date'}</span>
            {lead ? (
              <Link href={`/leads/${lead.id}`} className="text-primary hover:underline">
                {lead.traveller_name ?? 'Lead'}
                {lead.destination_primary ? ` · ${lead.destination_primary}` : ''}
              </Link>
            ) : null}
            {task.booking_id ? (
              <Link href={`/bookings/${task.booking_id}`} className="text-primary hover:underline">
                Booking
              </Link>
            ) : null}
          </p>
          {task.description ? (
            <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{task.description}</p>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1">
          {done ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={onReopen}>
              Reopen
            </Button>
          ) : (
            <>
              {SNOOZE.map((s) => (
                <Button key={s.label} size="sm" variant="ghost" disabled={busy} onClick={() => onSnooze(s.hours)}>
                  {s.label}
                </Button>
              ))}
              <Button size="sm" disabled={busy} onClick={onDone}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                Done
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
