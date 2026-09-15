import { describe, expect, it } from 'vitest';
import { parseSupplierInput } from './suppliers';
import { DEFAULT_DESTINATIONS } from './constants';
import { slugify } from './matching';

describe('supplier destination input', () => {
  it('accepts up to three destination mappings', () => {
    const result = parseSupplierInput({ name: 'Mountain DMC', destinations: ['a', 'b', 'c'].map((destination_id) => ({ destination_id })) });
    expect(result.destinations).toHaveLength(3);
  });

  it('rejects more than three distinct destination mappings', () => {
    expect(() => parseSupplierInput({ name: 'Everywhere DMC', destinations: ['a', 'b', 'c', 'd'].map((destination_id) => ({ destination_id })) })).toThrow('maximum of 3 destinations');
  });
});

describe('default destination catalog', () => {
  it('offers every top destination Oliday sells', () => {
    const names = DEFAULT_DESTINATIONS.map((d) => d.name);
    for (const expected of [
      'Kerala',
      'Andaman',
      'Ladakh',
      'Rajasthan',
      'Tamil Nadu',
      'Karnataka',
      'Himachal Pradesh',
      'Gujarat',
      'Uttarakhand',
      'Kashmir',
      'North East',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('gives every destination a unique slug, parents and children alike', () => {
    const slugs = DEFAULT_DESTINATIONS.flatMap((d) => [d.name, ...(d.children ?? [])]).map(slugify);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('carries the spellings an agent is likely to type', () => {
    const aliasesFor = (name: string) => DEFAULT_DESTINATIONS.find((d) => d.name === name)?.aliases ?? [];
    expect(aliasesFor('Tamil Nadu')).toContain('tamilnadu');
    expect(aliasesFor('Uttarakhand')).toContain('uttrakhand');
    expect(aliasesFor('Kerala')).toContain('kerela');
  });
});
