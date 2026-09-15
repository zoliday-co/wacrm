// ============================================================
// Centralised travel financial calculations — pure, no I/O.
//
// This is THE place where supplier cost → traveller price is
// derived. API routes, the quote builder UI, the booking snapshot
// and reports all call these functions so the numbers agree
// everywhere. Everything runs on exact minor-unit bigints (see
// ./money.ts) and returns NUMERIC-compatible strings.
//
// Model
// -----
//   markup_amount       = markup_type === 'percent'
//                           ? supplier_cost × markup_value%
//                           : markup_value
//   selling_before_tax  = supplier_cost + markup_amount − discount   (floored at 0)
//   gst_taxable_amount  = gst_taxable_base === 'selling_price'
//                           ? selling_before_tax
//                           : max(0, selling_before_tax − supplier_cost)   (margin scheme)
//   gst_amount          = gst_taxable_amount × gst_rate%
//   traveller_total     = selling_before_tax + gst_amount
//   gross_profit        = selling_before_tax − supplier_cost         (GST is NOT profit)
//   margin_pct          = gross_profit / selling_before_tax × 100
//
// The tax base is configurable (travel_settings.gst_taxable_base)
// because the correct treatment depends on how the business is
// registered — the app makes no legal assumption.
// ============================================================

import {
  add,
  fromMinor,
  max0,
  percentOf,
  ratioPercent,
  sub,
  toMinor,
  type Minor,
} from './money';
import type { GstTaxableBase, MarkupType } from '@/types/travel';

export interface QuoteInput {
  supplierCost: string | number;
  markupType: MarkupType;
  markupValue: string | number;
  discountAmount?: string | number | null;
  gstRate: string | number;
  gstTaxableBase: GstTaxableBase;
}

export interface QuoteBreakdown {
  supplier_cost: string;
  markup_type: MarkupType;
  markup_value: string;
  markup_amount: string;
  discount_amount: string;
  selling_price_before_tax: string;
  gst_rate: string;
  gst_taxable_base: GstTaxableBase;
  gst_taxable_amount: string;
  gst_amount: string;
  traveller_total: string;
  gross_profit: string;
  /** Percent with 2 decimals, e.g. "14.29". */
  margin_pct: string;
}

export function computeQuote(input: QuoteInput): QuoteBreakdown {
  const supplierCost = max0(toMinor(input.supplierCost));
  const markupValueMinor = toMinor(input.markupValue);
  const discount = max0(toMinor(input.discountAmount ?? 0));

  const markupAmount =
    input.markupType === 'percent'
      ? percentOf(supplierCost, normalizePercent(input.markupValue))
      : max0(markupValueMinor);

  const sellingBeforeTax = max0(sub(add(supplierCost, markupAmount), discount));

  const taxable =
    input.gstTaxableBase === 'markup'
      ? max0(sub(sellingBeforeTax, supplierCost))
      : sellingBeforeTax;

  const gstRate = normalizePercent(input.gstRate);
  const gstAmount = percentOf(taxable, gstRate);
  const travellerTotal = add(sellingBeforeTax, gstAmount);
  const grossProfit = sub(sellingBeforeTax, supplierCost);

  return {
    supplier_cost: fromMinor(supplierCost),
    markup_type: input.markupType,
    markup_value:
      input.markupType === 'percent'
        ? gstRateString(normalizePercent(input.markupValue))
        : fromMinor(max0(markupValueMinor)),
    markup_amount: fromMinor(markupAmount),
    discount_amount: fromMinor(discount),
    selling_price_before_tax: fromMinor(sellingBeforeTax),
    gst_rate: gstRateString(gstRate),
    gst_taxable_base: input.gstTaxableBase,
    gst_taxable_amount: fromMinor(taxable),
    gst_amount: fromMinor(gstAmount),
    traveller_total: fromMinor(travellerTotal),
    gross_profit: fromMinor(grossProfit),
    margin_pct: ratioPercent(grossProfit, sellingBeforeTax),
  };
}

/** Sum of a supplier quote's cost components (+ tax) → totals. */
export function computeSupplierQuoteTotals(input: {
  hotelCost: string | number;
  transportCost: string | number;
  activitiesCost: string | number;
  otherCost: string | number;
  supplierTaxAmount?: string | number | null;
}): { subtotal: string; total_supplier_cost: string } {
  const subtotal = add(
    max0(toMinor(input.hotelCost)),
    max0(toMinor(input.transportCost)),
    max0(toMinor(input.activitiesCost)),
    max0(toMinor(input.otherCost))
  );
  const total = add(subtotal, max0(toMinor(input.supplierTaxAmount ?? 0)));
  return { subtotal: fromMinor(subtotal), total_supplier_cost: fromMinor(total) };
}

export type MarginLevel = 'ok' | 'warning' | 'approval_required';

/**
 * Classify a margin against the account's guardrails.
 *   - below `approvalPct` (when set)  → approval_required
 *   - below `warningPct`              → warning
 */
export function marginLevel(
  marginPct: string | number,
  warningPct: string | number,
  approvalPct: string | number | null | undefined
): MarginLevel {
  const m = percentToNumber(marginPct);
  if (approvalPct !== null && approvalPct !== undefined && approvalPct !== '') {
    if (m < percentToNumber(approvalPct)) return 'approval_required';
  }
  if (m < percentToNumber(warningPct)) return 'warning';
  return 'ok';
}

/** Booking financial summary from stored booking figures. */
export interface BookingFinancialView {
  package_price: string;
  gst_amount: string;
  traveller_total: string;
  amount_received: string;
  customer_balance: string;
  supplier_cost: string;
  supplier_amount_paid: string;
  supplier_balance: string;
  gross_profit: string;
  margin_pct: string;
}

export function bookingFinancialView(b: {
  selling_price_before_tax: string;
  gst_amount: string;
  traveller_total: string;
  amount_received: string;
  supplier_cost: string;
  supplier_amount_paid: string;
}): BookingFinancialView {
  const selling = toMinor(b.selling_price_before_tax);
  const cost = toMinor(b.supplier_cost);
  const received = toMinor(b.amount_received);
  const paid = toMinor(b.supplier_amount_paid);
  const total = toMinor(b.traveller_total);
  const profit = sub(selling, cost);
  return {
    package_price: fromMinor(selling),
    gst_amount: fromMinor(toMinor(b.gst_amount)),
    traveller_total: fromMinor(total),
    amount_received: fromMinor(received),
    customer_balance: fromMinor(sub(total, received)),
    supplier_cost: fromMinor(cost),
    supplier_amount_paid: fromMinor(paid),
    supplier_balance: fromMinor(sub(cost, paid)),
    gross_profit: fromMinor(profit),
    margin_pct: ratioPercent(profit, selling),
  };
}

// ------------------------------------------------------------
// helpers
// ------------------------------------------------------------

/** Accept "5", "5.0", 5, "18.00" → canonical "5.00" style string (4 dp trimmed to 2). */
function normalizePercent(v: string | number): string {
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n) || n < 0) return '0';
  return n.toFixed(4);
}

function gstRateString(v: string): string {
  const n = Number(v);
  return (Number.isFinite(n) ? n : 0).toFixed(2);
}

function percentToNumber(v: string | number): number {
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : 0;
}

/** Expose minor helpers for callers that want to sum breakdowns. */
export { toMinor, fromMinor, add as addMinor, type Minor };
