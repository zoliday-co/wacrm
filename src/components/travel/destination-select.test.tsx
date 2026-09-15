import { describe, it, expect } from 'vitest';

import {
  CATALOG_ID_PREFIX,
  MAX_SUPPLIER_DESTINATIONS,
  filterGroups,
  groupDestinations,
  offeredDestinations,
  toggleSelection,
} from './destination-select';
import type { Destination } from '@/types/travel';

function dest(id: string, name: string, parent_id: string | null = null, extra: Partial<Destination> = {}): Destination {
  return {
    id,
    account_id: 'acct-1',
    name,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    parent_id,
    aliases: [],
    active: true,
    created_at: '',
    updated_at: '',
    ...extra,
  };
}

const CATALOG: Destination[] = [
  dest('kerala', 'Kerala', null, { aliases: ['kerela'] }),
  dest('munnar', 'Munnar', 'kerala'),
  dest('alleppey', 'Alleppey', 'kerala'),
  dest('goa', 'Goa'),
  dest('retired', 'Old Region', null, { active: false }),
  // A child whose parent is inactive (so not in the grouped set) must
  // still be reachable rather than silently vanishing.
  dest('orphan', 'Orphan Town', 'missing-parent'),
];

describe('groupDestinations', () => {
  it('nests sub-destinations under their parent, alphabetically', () => {
    const groups = groupDestinations(CATALOG);
    const kerala = groups.find((g) => g.parent.id === 'kerala')!;
    expect(kerala.children.map((c) => c.name)).toEqual(['Alleppey', 'Munnar']);
    expect(groups.map((g) => g.parent.name)).toEqual(['Goa', 'Kerala', 'Orphan Town']);
  });

  it('drops inactive destinations', () => {
    const groups = groupDestinations(CATALOG);
    expect(groups.some((g) => g.parent.id === 'retired')).toBe(false);
  });

  it('promotes a child with no resolvable parent to its own row', () => {
    const groups = groupDestinations(CATALOG);
    expect(groups.some((g) => g.parent.id === 'orphan')).toBe(true);
  });
});

describe('toggleSelection', () => {
  it('adds and removes', () => {
    expect(toggleSelection([], 'kerala')).toEqual(['kerala']);
    expect(toggleSelection(['kerala'], 'kerala')).toEqual([]);
  });

  it('refuses to exceed the cap', () => {
    const three = ['a', 'b', 'c'];
    expect(three).toHaveLength(MAX_SUPPLIER_DESTINATIONS);
    expect(toggleSelection(three, 'd')).toEqual(three);
  });

  it('still allows deselection at the cap, so a choice can be swapped', () => {
    expect(toggleSelection(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });
});

describe('filterGroups', () => {
  const groups = groupDestinations(CATALOG);

  it('returns everything for an empty query', () => {
    expect(filterGroups(groups, '  ')).toHaveLength(groups.length);
  });

  it('keeps a parent and all its children when the parent matches', () => {
    const [kerala] = filterGroups(groups, 'kera');
    expect(kerala.parent.name).toBe('Kerala');
    expect(kerala.children).toHaveLength(2);
  });

  it('matches on an alias', () => {
    expect(filterGroups(groups, 'kerela').map((g) => g.parent.name)).toEqual(['Kerala']);
  });

  it('keeps only the matching child when the parent does not match', () => {
    const result = filterGroups(groups, 'munnar');
    expect(result).toHaveLength(1);
    expect(result[0].parent.name).toBe('Kerala');
    expect(result[0].children.map((c) => c.name)).toEqual(['Munnar']);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterGroups(groups, 'zzz')).toEqual([]);
  });
});

describe('offeredDestinations', () => {
  it('offers the whole catalog even when the account has seeded nothing', () => {
    const offered = offeredDestinations([]);
    const names = offered.map((d) => d.name);
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
    // Unseeded entries carry a placeholder id the server resolves on save.
    expect(offered.every((d) => d.id.startsWith(CATALOG_ID_PREFIX))).toBe(true);
  });

  it('prefers the account\'s real row over the catalog placeholder', () => {
    const seeded = dest('real-kerala', 'Kerala');
    const offered = offeredDestinations([seeded]);
    const kerala = offered.filter((d) => d.slug === 'kerala');
    expect(kerala).toHaveLength(1);
    expect(kerala[0].id).toBe('real-kerala');
  });

  it('keeps account-only destinations that are not in the catalog', () => {
    const custom = dest('custom', 'Lakshadweep');
    expect(offeredDestinations([custom]).some((d) => d.id === 'custom')).toBe(true);
  });

  it('groups a mix of seeded and catalog rows without duplicating a state', () => {
    const groups = groupDestinations(offeredDestinations([dest('real-goa', 'Goa')]));
    expect(groups.filter((g) => g.parent.name === 'Goa')).toHaveLength(1);
  });
});
