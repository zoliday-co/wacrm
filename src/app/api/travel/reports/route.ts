import { travelRoute, query } from '@/lib/travel/route';
import { defaultRange, loadFunnel, loadGroupReport, loadSupplierReport } from '@/lib/travel/reports';

export const GET = travelRoute('viewer', async (ctx, request) => {
  const q = query(request);
  const fallback = defaultRange();
  const range = { from: q.get('from') ?? fallback.from, to: q.get('to') ?? fallback.to };
  const kind = q.get('kind') ?? 'funnel';
  if (kind === 'suppliers') return { kind, rows: await loadSupplierReport(ctx.supabase, ctx.accountId, range) };
  if (kind === 'campaigns' || kind === 'destinations' || kind === 'agents') return { kind, rows: await loadGroupReport(ctx.supabase, ctx.accountId, kind, range) };
  return { kind: 'funnel', funnel: await loadFunnel(ctx.supabase, ctx.accountId, range) };
});
