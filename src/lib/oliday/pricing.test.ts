import { describe, it, expect } from 'vitest';
import { perPersonPrice, quoteForParty, parsePriceData } from './pricing';

const MATRIX = [
  {
    meal_plan: 'Breakfast',
    adult2: 24000,
    adult4: 21000,
    adult6: 19000,
    adult8: 18000,
    adult10: 0, // not offered at this size
    adult12: 17000,
  },
  {
    meal_plan: 'MAP',
    adult2: 27000,
    adult4: 24500,
    adult6: 0,
    adult8: 21500,
  },
];

describe('perPersonPrice', () => {
  it('quotes adult8 for a party of 8, never starting_price (acceptance 4)', () => {
    const q = perPersonPrice(MATRIX, 8);
    expect(q).toMatchObject({ price: 18000, basisPax: 8 });
    expect(q!.isStartingPriceFallback).toBe(false);
  });

  it('prefers the asked meal plan', () => {
    const q = perPersonPrice(MATRIX, 8, 'BREAKFAST_DINNER');
    expect(q).toMatchObject({ price: 21500, basisPax: 8, mealPlan: 'MAP' });
  });

  it('falls back to all entries when no entry matches the meal plan', () => {
    const q = perPersonPrice(MATRIX, 2, 'ALL_MEALS');
    expect(q).not.toBeNull(); // AP absent → any plan beats no quote
  });

  it('skips zero columns and picks the nearest offered size', () => {
    // pax 10: adult10 is 0 in entry 1 and absent in entry 2 → nearest
    // usable N wins.
    const q = perPersonPrice(MATRIX, 10);
    expect(q!.basisPax).not.toBe(10);
    expect(q!.price).toBeGreaterThan(0);
  });

  it('ties resolve to the smaller party size (the conservative, higher price)', () => {
    // pax 3 → N∈{2,4} both distance 1 → prefer adult2
    const q = perPersonPrice(MATRIX, 3);
    expect(q).toMatchObject({ price: 24000, basisPax: 2 });
  });

  it('returns null for garbage / empty matrices', () => {
    expect(perPersonPrice(null, 4)).toBeNull();
    expect(perPersonPrice('not-an-array', 4)).toBeNull();
    expect(perPersonPrice([], 4)).toBeNull();
    expect(perPersonPrice([{ meal_plan: 'CP' }], 4)).toBeNull();
  });
});

describe('quoteForParty', () => {
  it('labels the starting-price fallback so the bot must disclose it', () => {
    const q = quoteForParty([], 19650, 6);
    expect(q).toMatchObject({
      price: 19650,
      basisPax: 2,
      isStartingPriceFallback: true,
    });
  });

  it('returns null when there is neither matrix nor starting price', () => {
    expect(quoteForParty([], null, 4)).toBeNull();
  });
});

describe('parsePriceData', () => {
  it('drops non-object entries defensively', () => {
    expect(parsePriceData([null, 'x', { adult2: 100 }])).toEqual([
      { adult2: 100 },
    ]);
  });
});
