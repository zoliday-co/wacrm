import { describe, expect, it } from 'vitest';
import { bookingFinancialView, computeQuote, computeSupplierQuoteTotals, marginLevel } from './financials';

describe('Oliday financial calculations', () => {
  it('keeps supplier cost, markup, GST and gross profit separate', () => {
    const result = computeQuote({ supplierCost: '60000', markupType: 'fixed', markupValue: '10000', discountAmount: '0', gstRate: '5', gstTaxableBase: 'selling_price' });
    expect(result).toMatchObject({ supplier_cost: '60000.00', markup_amount: '10000.00', selling_price_before_tax: '70000.00', gst_amount: '3500.00', traveller_total: '73500.00', gross_profit: '10000.00', margin_pct: '14.29' });
  });

  it('applies percent markup and discount with exact paise rounding', () => {
    const result = computeQuote({ supplierCost: '58900', markupType: 'percent', markupValue: '15', discountAmount: '500', gstRate: '5', gstTaxableBase: 'markup' });
    expect(result.markup_amount).toBe('8835.00');
    expect(result.selling_price_before_tax).toBe('67235.00');
    expect(result.gst_amount).toBe('416.75');
    expect(result.traveller_total).toBe('67651.75');
    expect(result.gross_profit).toBe('8335.00');
  });

  it('totals supplier quote components and tax', () => {
    expect(computeSupplierQuoteTotals({ hotelCost: '32000', transportCost: '18000', activitiesCost: '8000', otherCost: '2000', supplierTaxAmount: '3000' })).toEqual({ subtotal: '60000.00', total_supplier_cost: '63000.00' });
  });

  it('classifies configurable margin guardrails', () => {
    expect(marginLevel('12', '8', '5')).toBe('ok');
    expect(marginLevel('7', '8', '5')).toBe('warning');
    expect(marginLevel('4.99', '8', '5')).toBe('approval_required');
  });

  it('presents booking balances without counting GST as profit', () => {
    const view = bookingFinancialView({ supplier_cost: '60000', selling_price_before_tax: '70000', gst_amount: '3500', traveller_total: '73500', amount_received: '30000', supplier_amount_paid: '20000' });
    expect(view.gross_profit).toBe('10000.00');
    expect(view.customer_balance).toBe('43500.00');
    expect(view.supplier_balance).toBe('40000.00');
  });
});
