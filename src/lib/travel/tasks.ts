// ============================================================
// Follow-up tasks + the follow-up scheduler. WACRM has no task
// module, so this is the travel layer's own — used for callbacks,
// scheduled follow-ups, payment chasers and ops reminders.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { TaskPriority, TaskStatus, TaskType, TravelTask } from '@/types/travel';
import { LEAD_EVENT_TYPES } from './constants';
import { recordLeadEvent } from './events';
import { badRequest, notFound } from './errors';
import { notifyUser } from './notifications';

export interface CreateTaskInput {
  travelLeadId?: string | null;
  bookingId?: string | null;
  title: string;
  description?: string | null;
  taskType?: TaskType;
  assignedTo?: string | null;
  priority?: TaskPriority;
  dueAt?: string | null;
  remindAt?: string | null;
  /** Idempotency key (unique per account). */
  sourceKey?: string | null;
  createdBy?: string | null;
  /** Log a timeline event on the lead (default true when a lead is set). */
  logEvent?: boolean;
}

export async function createTask(db: SupabaseClient, accountId: string, input: CreateTaskInput): Promise<TravelTask> {
  if (!input.title?.trim()) throw badRequest('Task title is required');
  if (input.sourceKey) {
    const { data: existing } = await db
      .from('travel_tasks')
      .select('*')
      .eq('account_id', accountId)
      .eq('source_key', input.sourceKey)
      .maybeSingle();
    if (existing) return existing as TravelTask;
  }
  const { data, error } = await db
    .from('travel_tasks')
    .insert({
      account_id: accountId,
      travel_lead_id: input.travelLeadId ?? null,
      booking_id: input.bookingId ?? null,
      title: input.title.trim().slice(0, 300),
      description: input.description ?? null,
      task_type: input.taskType ?? 'GENERAL',
      assigned_to: input.assignedTo ?? null,
      priority: input.priority ?? 'NORMAL',
      due_at: input.dueAt ?? null,
      remind_at: input.remindAt ?? null,
      source_key: input.sourceKey ?? null,
      created_by: input.createdBy ?? null,
    })
    .select('*')
    .single();
  if (error || !data) {
    if (input.sourceKey && /duplicate key|23505/.test(error?.message ?? '')) {
      const { data: raced } = await db.from('travel_tasks').select('*').eq('account_id', accountId).eq('source_key', input.sourceKey).maybeSingle();
      if (raced) return raced as TravelTask;
    }
    throw new Error(`Failed to create task: ${error?.message ?? 'unknown'}`);
  }
  const task = data as TravelTask;
  if (input.travelLeadId && (input.logEvent ?? true)) {
    await recordLeadEvent(db, {
      accountId,
      leadId: input.travelLeadId,
      type: LEAD_EVENT_TYPES.TASK_CREATED,
      actorType: input.createdBy ? 'agent' : 'system',
      actorUserId: input.createdBy ?? null,
      title: `Task: ${task.title}${task.due_at ? ` (due ${new Date(task.due_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })})` : ''}`,
      details: { task_id: task.id, task_type: task.task_type, due_at: task.due_at, assigned_to: task.assigned_to },
    });
  }
  return task;
}

/** Schedule a follow-up on a lead: task + lead next-action. */
export async function scheduleFollowUp(
  db: SupabaseClient,
  accountId: string,
  leadId: string,
  input: { dueAt: string; title?: string | null; note?: string | null; assignedTo?: string | null; remindAt?: string | null; actorUserId: string | null }
): Promise<TravelTask> {
  const due = new Date(input.dueAt);
  if (Number.isNaN(due.getTime())) throw badRequest('Invalid follow-up time');
  const task = await createTask(db, accountId, {
    travelLeadId: leadId,
    title: input.title?.trim() || 'Follow up with traveller',
    description: input.note ?? null,
    taskType: 'FOLLOW_UP',
    assignedTo: input.assignedTo ?? input.actorUserId ?? null,
    priority: 'NORMAL',
    dueAt: due.toISOString(),
    remindAt: input.remindAt ?? null,
    createdBy: input.actorUserId,
  });
  await db
    .from('travel_leads')
    .update({ next_action_text: task.title, next_action_at: task.due_at })
    .eq('id', leadId)
    .eq('account_id', accountId);
  return task;
}

export async function updateTask(
  db: SupabaseClient,
  accountId: string,
  taskId: string,
  patch: Partial<Pick<TravelTask, 'title' | 'description' | 'assigned_to' | 'priority' | 'due_at' | 'remind_at' | 'status' | 'task_type'>>,
  actorUserId: string | null
): Promise<TravelTask> {
  const { data: current } = await db.from('travel_tasks').select('*').eq('id', taskId).eq('account_id', accountId).maybeSingle();
  if (!current) throw notFound('Task');
  const prev = current as TravelTask;
  const clean: Record<string, unknown> = {};
  if (patch.title !== undefined) clean.title = String(patch.title).trim().slice(0, 300);
  if (patch.description !== undefined) clean.description = patch.description;
  if (patch.assigned_to !== undefined) clean.assigned_to = patch.assigned_to;
  if (patch.priority !== undefined) clean.priority = patch.priority;
  if (patch.task_type !== undefined) clean.task_type = patch.task_type;
  if (patch.due_at !== undefined) {
    clean.due_at = patch.due_at;
    clean.reminded_at = null; // re-arm the reminder on reschedule
  }
  if (patch.remind_at !== undefined) clean.remind_at = patch.remind_at;
  if (patch.status !== undefined) {
    clean.status = patch.status as TaskStatus;
    clean.completed_at = patch.status === 'DONE' ? new Date().toISOString() : null;
  }
  const { data, error } = await db.from('travel_tasks').update(clean).eq('id', taskId).select('*').single();
  if (error || !data) throw new Error(`Failed to update task: ${error?.message}`);
  const task = data as TravelTask;

  if (prev.status !== 'DONE' && task.status === 'DONE' && task.travel_lead_id) {
    await recordLeadEvent(db, {
      accountId,
      leadId: task.travel_lead_id,
      type: LEAD_EVENT_TYPES.TASK_COMPLETED,
      actorType: 'agent',
      actorUserId,
      title: `Done: ${task.title}`,
      details: { task_id: task.id },
    });
    // Clear the lead's next action if it pointed at this task.
    await db
      .from('travel_leads')
      .update({ next_action_text: null, next_action_at: null })
      .eq('id', task.travel_lead_id)
      .eq('next_action_text', task.title);
  }
  return task;
}

export interface TaskFilters {
  scope?: 'mine' | 'all';
  status?: 'open' | 'done' | 'all';
  leadId?: string | null;
  bookingId?: string | null;
  dueBefore?: string | null;
  limit?: number;
}

export async function listTasks(db: SupabaseClient, accountId: string, f: TaskFilters, currentUserId: string): Promise<TravelTask[]> {
  let q = db
    .from('travel_tasks')
    .select('*, travel_lead:travel_leads(id, traveller_name, destination_primary)')
    .eq('account_id', accountId)
    .order('due_at', { ascending: true, nullsFirst: false })
    .limit(Math.min(500, f.limit ?? 200));
  if (f.scope === 'mine') q = q.eq('assigned_to', currentUserId);
  if (f.status === 'open' || !f.status) q = q.in('status', ['OPEN', 'IN_PROGRESS']);
  else if (f.status === 'done') q = q.eq('status', 'DONE');
  if (f.leadId) q = q.eq('travel_lead_id', f.leadId);
  if (f.bookingId) q = q.eq('booking_id', f.bookingId);
  if (f.dueBefore) q = q.lte('due_at', f.dueBefore);
  const { data } = await q;
  return (data ?? []) as TravelTask[];
}

/**
 * Cron: push one in-app reminder per due task (or at `remind_at`
 * when set ahead of the due time). `reminded_at` stops repeats;
 * rescheduling a task re-arms it.
 */
export async function runTaskReminders(admin: SupabaseClient, now = new Date()): Promise<number> {
  const nowIso = now.toISOString();
  const { data: due } = await admin
    .from('travel_tasks')
    .select('*, travel_lead:travel_leads(id, traveller_name, destination_primary, conversation_id, contact_id)')
    .in('status', ['OPEN', 'IN_PROGRESS'])
    .is('reminded_at', null)
    .or(`remind_at.lte.${nowIso},and(remind_at.is.null,due_at.lte.${nowIso})`)
    .limit(200);
  let sent = 0;
  for (const t of (due ?? []) as (TravelTask & { travel_lead: { id: string; traveller_name: string | null; destination_primary: string | null; conversation_id: string | null; contact_id: string | null } | null })[]) {
    if (!t.assigned_to) {
      await admin.from('travel_tasks').update({ reminded_at: nowIso }).eq('id', t.id);
      continue;
    }
    const who = t.travel_lead?.traveller_name ? ` — ${t.travel_lead.traveller_name}` : '';
    await notifyUser({
      accountId: t.account_id,
      userId: t.assigned_to,
      type: 'travel_task_due',
      title: `Follow-up due: ${t.title}${who}`,
      body: t.description ?? (t.travel_lead?.destination_primary ?? null),
      travelLeadId: t.travel_lead_id,
      conversationId: t.travel_lead?.conversation_id ?? null,
      contactId: t.travel_lead?.contact_id ?? null,
    });
    await admin.from('travel_tasks').update({ reminded_at: nowIso }).eq('id', t.id);
    sent += 1;
  }
  return sent;
}
