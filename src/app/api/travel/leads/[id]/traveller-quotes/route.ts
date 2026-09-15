// GET  /api/travel/leads/[id]/traveller-quotes
// POST /api/travel/leads/[id]/traveller-quotes — create quote version from a supplier quote + markup
// POST with { preview: true } — compute the breakdown without saving (quote builder live preview)

import { travelRoute, readJson } from '@/lib/travel/route';
import { createTravellerQuote, listTravellerQuotes, parseTravellerQuoteInput } from '@/lib/travel/traveller-quotes';
import { computeQuote, marginLevel } from '@/lib/travel/financials';
import { getTravelSettings } from '@/lib/travel/settings';
import { badRequest } from '@/lib/travel/errors';

export const GET = travelRoute('viewer', async (ctx) => {
  return { quotes: await listTravellerQuotes(ctx.supabase, ctx.accountId, ctx.params.id) };
});

export const POST = travelRoute('agent', async (ctx, request) => {
  const body = await readJson(request);
  const input = parseTravellerQuoteInput(body);
  if (body.preview === true) {
    const settings = await getTravelSettings(ctx.supabase, ctx.accountId);
    let supplierCost = input.supplier_cost;
    if (supplierCost === null || supplierCost === undefined) {
      if (!input.supplier_quote_id) throw badRequest('supplier_quote_id or supplier_cost required');
      const { data } = await ctx.supabase.from('supplier_quotes').select('total_supplier_cost').eq('id', input.supplier_quote_id).eq('account_id', ctx.accountId).maybeSingle();
      supplierCost = data?.total_supplier_cost ?? '0';
    }
    const resolvedSupplierCost: string | number = supplierCost ?? '0';
    const breakdown = computeQuote({
      supplierCost: resolvedSupplierCost,
      markupType: input.markup_type ?? settings.default_markup_type,
      markupValue: input.markup_value ?? settings.default_markup_value,
      discountAmount: input.discount_amount ?? 0,
      gstRate: input.gst_rate ?? settings.gst_rate,
      gstTaxableBase: input.gst_taxable_base ?? settings.gst_taxable_base,
    });
    return { preview: breakdown, margin_level: marginLevel(breakdown.margin_pct, settings.margin_warning_pct, settings.margin_approval_pct) };
  }
  const quote = await createTravellerQuote(ctx.supabase, ctx.accountId, ctx.params.id, input, ctx.userId);
  return { quote };
});
