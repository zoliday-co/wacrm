import { describe, expect, it } from 'vitest';
import { rankSuppliers, resolveDestination, slugify, type MatchCandidate } from './matching';

const candidate = (id: string, overrides: { supplier?: Partial<MatchCandidate['supplier']>; mapping?: Partial<MatchCandidate['mapping']>; primaryMatch?: boolean } = {}): MatchCandidate => ({
  supplier: { id, account_id: 'a', name: id, company_name: null, primary_contact_name: null, phone: null, whatsapp_phone: null, email: null, status: 'ACTIVE', supplier_type: 'DMC', rating: '3', notes: null, payment_terms: null, preferred: false, active: true, contact_id: null, metadata: {}, deleted_at: null, created_by: null, created_at: '', updated_at: '', ...overrides.supplier },
  mapping: { id: `m-${id}`, account_id: 'a', supplier_id: id, destination_id: 'kerala', priority: 100, preferred: false, active: true, service_types: [], created_at: '', ...overrides.mapping },
  matchedDestinationId: 'kerala',
  primaryMatch: overrides.primaryMatch ?? true,
});

describe('supplier matching', () => {
  it('prioritizes preferred suppliers, mapping priority, then rating', () => {
    const ranked = rankSuppliers([candidate('regular', { supplier: { rating: '5' } }), candidate('preferred', { supplier: { preferred: true, rating: '2' } }), candidate('priority', { mapping: { priority: 1 }, supplier: { rating: '4' } })], 3);
    expect(ranked.map((r) => r.supplier.id)).toEqual(['preferred', 'priority', 'regular']);
  });

  it('honors the configurable maximum', () => {
    expect(rankSuppliers([candidate('a'), candidate('b'), candidate('c')], 2)).toHaveLength(2);
  });

  it('resolves destination aliases and stable slugs', () => {
    const destinations = [{ id: '1', account_id: 'a', name: 'Kerala', slug: 'kerala', parent_id: null, aliases: ['kerela'], active: true, created_at: '', updated_at: '' }];
    expect(resolveDestination('Kerela', destinations)?.id).toBe('1');
    expect(slugify('Himachal Pradesh')).toBe('himachal-pradesh');
  });
});
