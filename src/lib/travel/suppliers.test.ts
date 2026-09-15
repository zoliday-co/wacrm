import { describe, expect, it, vi } from 'vitest';

import { createFakeDb, baseSeed, type FakeDb } from './test-support';

const adminRef: { db: FakeDb | null } = { db: null };
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => adminRef.db }));
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

describe('catalog destinations resolve on save', () => {
  const ACCOUNT = 'acct-1';

  it('creates the destination row for a catalog placeholder and maps the supplier to it', async () => {
    const db = createFakeDb({ seed: baseSeed(ACCOUNT) });
    adminRef.db = db;
    const { createSupplier } = await import('./suppliers');

    // The account has seeded nothing, so the form sends placeholders.
    expect(db.rows('destinations')).toHaveLength(0);

    await createSupplier(
      db as never,
      ACCOUNT,
      {
        name: 'GreenLeaf Travels',
        whatsapp_phone: '919000000001',
        destinations: [{ destination_id: 'catalog:kerala' }, { destination_id: 'catalog:gujarat' }],
      },
      'user-agent',
    );

    const created = db.rows('destinations');
    expect(created.map((d) => d.slug).sort()).toEqual(['gujarat', 'kerala']);

    const mappings = db.rows('supplier_destinations');
    expect(mappings).toHaveLength(2);
    // Every mapping points at a real row, never at the placeholder.
    for (const m of mappings) {
      expect(String(m.destination_id)).not.toContain('catalog:');
      expect(created.some((d) => d.id === m.destination_id)).toBe(true);
    }
  });

  it('reuses an already-seeded row rather than creating a duplicate', async () => {
    const seed = baseSeed(ACCOUNT);
    seed.destinations = [{ id: 'existing-kerala', account_id: ACCOUNT, name: 'Kerala', slug: 'kerala', parent_id: null, aliases: [], active: true }];
    const db = createFakeDb({ seed });
    adminRef.db = db;
    const { createSupplier } = await import('./suppliers');

    await createSupplier(
      db as never,
      ACCOUNT,
      { name: 'Kerala Routes', destinations: [{ destination_id: 'catalog:kerala' }] },
      'user-agent',
    );

    expect(db.rows('destinations')).toHaveLength(1);
    expect(db.rows('supplier_destinations')[0].destination_id).toBe('existing-kerala');
  });

  it('refuses a placeholder that is not in the catalog', async () => {
    const db = createFakeDb({ seed: baseSeed(ACCOUNT) });
    adminRef.db = db;
    const { createSupplier } = await import('./suppliers');

    await createSupplier(
      db as never,
      ACCOUNT,
      { name: 'Nowhere DMC', destinations: [{ destination_id: 'catalog:atlantis' }] },
      'user-agent',
    );

    // Nothing invented, nothing mapped.
    expect(db.rows('destinations')).toHaveLength(0);
    expect(db.rows('supplier_destinations')).toHaveLength(0);
  });
});
