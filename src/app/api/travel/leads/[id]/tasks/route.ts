// POST /api/travel/leads/[id]/tasks — create a task, or schedule a follow-up when { follow_up: true }

import { travelRoute, readJson } from '@/lib/travel/route';
import { createTask, scheduleFollowUp } from '@/lib/travel/tasks';
import { badRequest } from '@/lib/travel/errors';
import type { TaskPriority, TaskType } from '@/types/travel';

export const POST = travelRoute('agent', async (ctx, request) => {
  const body = await readJson(request);
  const leadId = ctx.params.id;
  if (body.follow_up === true) {
    if (typeof body.due_at !== 'string') throw badRequest('due_at is required');
    const task = await scheduleFollowUp(ctx.supabase, ctx.accountId, leadId, {
      dueAt: body.due_at,
      title: typeof body.title === 'string' ? body.title : null,
      note: typeof body.note === 'string' ? body.note : null,
      assignedTo: typeof body.assigned_to === 'string' ? body.assigned_to : null,
      remindAt: typeof body.remind_at === 'string' ? new Date(body.remind_at).toISOString() : null,
      actorUserId: ctx.userId,
    });
    return { task };
  }
  if (typeof body.title !== 'string') throw badRequest('title is required');
  const task = await createTask(ctx.supabase, ctx.accountId, {
    travelLeadId: leadId,
    title: body.title,
    description: typeof body.description === 'string' ? body.description : null,
    taskType: (body.task_type as TaskType) ?? 'GENERAL',
    assignedTo: typeof body.assigned_to === 'string' ? body.assigned_to : ctx.userId,
    priority: (body.priority as TaskPriority) ?? 'NORMAL',
    dueAt: typeof body.due_at === 'string' && body.due_at ? new Date(body.due_at).toISOString() : null,
    remindAt: typeof body.remind_at === 'string' && body.remind_at ? new Date(body.remind_at).toISOString() : null,
    createdBy: ctx.userId,
  });
  return { task };
});
