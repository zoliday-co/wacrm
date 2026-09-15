import { travelRoute, readJson } from '@/lib/travel/route';
import { updateTask } from '@/lib/travel/tasks';

export const PATCH = travelRoute('agent', async (ctx, request) => ({ task: await updateTask(ctx.supabase, ctx.accountId, ctx.params.id, await readJson(request), ctx.userId) }));
