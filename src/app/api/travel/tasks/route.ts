// GET  /api/travel/tasks?status=open|done|all&scope=mine|all&lead_id=&booking_id=&due_before=
// POST /api/travel/tasks — schedule a standalone follow-up (no lead required)

import { travelRoute, query, readJson } from '@/lib/travel/route';
import { createTask, listTasks } from '@/lib/travel/tasks';
import { badRequest } from '@/lib/travel/errors';
import type { TaskPriority, TaskType } from '@/types/travel';

export const GET = travelRoute('viewer', async (ctx, request) => {
  const q = query(request);
  const status = q.get('status');
  return {
    tasks: await listTasks(
      ctx.supabase,
      ctx.accountId,
      {
        status: status === 'done' || status === 'all' ? status : 'open',
        scope: q.get('scope') === 'mine' ? 'mine' : 'all',
        leadId: q.get('lead_id'),
        bookingId: q.get('booking_id'),
        dueBefore: q.get('due_before'),
        limit: Number(q.get('limit') ?? 200),
      },
      ctx.userId,
    ),
  };
});

export const POST = travelRoute('agent', async (ctx, request) => {
  const body = await readJson(request);
  if (typeof body.title !== 'string' || !body.title.trim()) throw badRequest('title is required');
  const task = await createTask(ctx.supabase, ctx.accountId, {
    travelLeadId: typeof body.lead_id === 'string' && body.lead_id ? body.lead_id : null,
    bookingId: typeof body.booking_id === 'string' && body.booking_id ? body.booking_id : null,
    title: body.title,
    description: typeof body.description === 'string' ? body.description : null,
    taskType: (body.task_type as TaskType) ?? 'FOLLOW_UP',
    // Unassigned work is invisible work: default the task to its creator.
    assignedTo: typeof body.assigned_to === 'string' && body.assigned_to ? body.assigned_to : ctx.userId,
    priority: (body.priority as TaskPriority) ?? 'NORMAL',
    dueAt: typeof body.due_at === 'string' && body.due_at ? new Date(body.due_at).toISOString() : null,
    remindAt: typeof body.remind_at === 'string' && body.remind_at ? new Date(body.remind_at).toISOString() : null,
    createdBy: ctx.userId,
  });
  return { task };
});
