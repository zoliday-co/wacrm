import { describe, it, expect } from 'vitest';
import {
  resolveRegion,
  containsWholeWords,
  normalizeForMatch,
  CATALOG_REGIONS,
} from './regions';

describe('normalizeForMatch', () => {
  it('lowercases and strips non-alphanumerics', () => {
    expect(normalizeForMatch("Tiger's Nest")).toBe('tiger s nest');
    expect(normalizeForMatch('  Port   Blair ')).toBe('port blair');
  });
});

describe('containsWholeWords', () => {
  it('matches whole words only', () => {
    expect(containsWholeWords('trip to port blair please', 'Port Blair')).toBe(
      true
    );
    // "goa" inside "goas" must not match
    expect(containsWholeWords('goas beaches', 'Goa')).toBe(false);
  });
});

describe('resolveRegion', () => {
  it('resolves a region asked directly', () => {
    expect(resolveRegion('Kashmir')).toEqual({ region: 'Kashmir' });
    expect(resolveRegion('5 nights in kashmir in december')).toEqual({
      region: 'Kashmir',
    });
  });

  it('resolves a city to its region and remembers the city (acceptance 3)', () => {
    expect(resolveRegion('packages for Coorg')).toEqual({
      region: 'Karnataka',
      city: 'Coorg',
    });
    expect(resolveRegion('Gulmarg')).toEqual({
      region: 'Kashmir',
      city: 'Gulmarg',
    });
    expect(resolveRegion('Munnar and Alleppey')).toMatchObject({
      region: 'Kerala',
    });
  });

  it('resolves multi-word cities', () => {
    expect(resolveRegion('honeymoon in port blair')).toEqual({
      region: 'Andaman',
      city: 'Port Blair',
    });
    expect(resolveRegion('rann of kutch trip')).toEqual({
      region: 'Gujarat',
      city: 'Rann of Kutch',
    });
  });

  it('returns null for uncovered destinations (acceptance 5)', () => {
    expect(resolveRegion('Bali honeymoon')).toBeNull();
    expect(resolveRegion('Dubai')).toBeNull();
    expect(resolveRegion('Maldives package')).toBeNull();
    expect(resolveRegion('')).toBeNull();
  });

  it('every region name resolves to itself', () => {
    for (const region of CATALOG_REGIONS) {
      expect(resolveRegion(region)).toEqual({ region });
    }
  });
});
