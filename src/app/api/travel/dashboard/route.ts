import { travelRoute } from '@/lib/travel/route';
import { loadDashboard } from '@/lib/travel/reports';

export const GET = travelRoute('viewer', async (ctx) => loadDashboard(ctx.supabase, ctx.accountId));
