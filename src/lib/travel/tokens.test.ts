import { describe, expect, it } from 'vitest';
import { generateTravelToken, hashTravelToken, looksLikeTravelToken, tokenHashEquals, tokenState } from './tokens';

describe('public travel access tokens', () => {
  it('generates opaque tokens while storing only their hash', () => {
    const generated = generateTravelToken('supplier_quote', 24, new Date('2026-01-01T00:00:00Z'));
    expect(looksLikeTravelToken(generated.token, 'supplier_quote')).toBe(true);
    expect(generated.hash).toBe(hashTravelToken(generated.token));
    expect(generated.token).not.toContain(generated.hash);
    expect(generated.expiresAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('uses constant-time hash comparison semantics', () => {
    const hash = hashTravelToken('oliday_test');
    expect(tokenHashEquals(hash, hash)).toBe(true);
    expect(tokenHashEquals(hash, hashTravelToken('different'))).toBe(false);
  });

  it('rejects expired and revoked records', () => {
    const now = new Date('2026-01-02T00:00:00Z');
    expect(tokenState({ expires_at: '2026-01-01T00:00:00Z', revoked_at: null }, now)).toBe('expired');
    expect(tokenState({ expires_at: '2026-02-01T00:00:00Z', revoked_at: '2026-01-01T00:00:00Z' }, now)).toBe('revoked');
  });
});
