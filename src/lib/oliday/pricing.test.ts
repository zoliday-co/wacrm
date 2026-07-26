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

  it('handles the LIVE matrix shape: string numerics + odd sizes (regression)', () => {
    // Verbatim shape from active_packages promo 4831/h 7663: every
    // numeric is a string, odd adultN columns exist and are "0".
    const live = [
      {
        meal_plan: 'CP',
        adult2: '13100',
        adult3: '0',
        adult4: '10100',
        adult5: '0',
        adult6: '8600',
        adult8: '9100',
        adult10: '8350',
        adult12: '6000',
        currency: 'INR',
      },
    ]
    expect(perPersonPrice(live, 2)).toMatchObject({ price: 13100, basisPax: 2 })
    expect(perPersonPrice(live, 4)).toMatchObject({ price: 10100, basisPax: 4 })
    expect(perPersonPrice(live, 6)).toMatchObject({ price: 8600, basisPax: 6 })
    // odd ask lands on the nearest offered size, zeros skipped
    expect(perPersonPrice(live, 5)).toMatchObject({ basisPax: 4 })
  })

  it('quotes a real adult3 column when the supplier offers one', () => {
    const withOdd = [{ meal_plan: 'CP', adult2: '15000', adult3: '13500' }]
    expect(perPersonPrice(withOdd, 3)).toMatchObject({
      price: 13500,
      basisPax: 3,
    })
  })

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
