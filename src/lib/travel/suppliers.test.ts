import { describe, expect, it } from 'vitest';
import { parseSupplierInput } from './suppliers';

describe('supplier destination input', () => {
  it('accepts up to three destination mappings', () => {
    const result = parseSupplierInput({ name: 'Mountain DMC', destinations: ['a', 'b', 'c'].map((destination_id) => ({ destination_id })) });
    expect(result.destinations).toHaveLength(3);
  });

  it('rejects more than three distinct destination mappings', () => {
    expect(() => parseSupplierInput({ name: 'Everywhere DMC', destinations: ['a', 'b', 'c', 'd'].map((destination_id) => ({ destination_id })) })).toThrow('maximum of 3 destinations');
  });
});
