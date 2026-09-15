import { travelRoute, readJson } from '@/lib/travel/route';
import { getTravelSettings, sanitizeSettingsPatch } from '@/lib/travel/settings';

export const GET = travelRoute('viewer', async (ctx) => ({ settings: await getTravelSettings(ctx.supabase, ctx.accountId) }));
export const PATCH = travelRoute('admin', async (ctx, request) => {
  await getTravelSettings(ctx.supabase, ctx.accountId);
  const patch = sanitizeSettingsPatch(await readJson(request));
  const { data, error } = await ctx.supabase.from('travel_settings').update(patch).eq('account_id', ctx.accountId).select('*').single();
  if (error) throw error;
  return { settings: data };
});
