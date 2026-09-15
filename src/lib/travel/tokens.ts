// ============================================================
// Opaque public-access tokens for the travel layer — pure.
//
// Used by:
//   - the supplier quote form   (/supplier/quote/[token])
//   - the traveller callback    (/trip/callback/[token])
//   - the traveller quote page  (/q/[token])
//
// Same scheme as invites + API keys (src/lib/auth/invitations.ts,
// src/lib/api-keys/keys.ts): 32 bytes CSPRNG → base64url (43
// chars), SHA-256 hex stored in the DB, plaintext handed out
// exactly once inside the WhatsApp link. A DB leak yields nothing
// usable; a guessed token is 256 bits of search space.
//
// Tokens are prefixed so a leaked string is self-identifying and
// so the lookup can reject junk before hashing.
// ============================================================

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type TravelTokenKind = 'supplier_quote' | 'callback' | 'traveller_quote';

const PREFIX: Record<TravelTokenKind, string> = {
  supplier_quote: 'sq_',
  callback: 'cb_',
  traveller_quote: 'tq_',
};

export interface GeneratedTravelToken {
  /** Plaintext — embed in the link, never persist. */
  token: string;
  /** SHA-256 hex — persist this. */
  hash: string;
  expiresAt: string;
}

export function generateTravelToken(kind: TravelTokenKind, ttlHours: number, now = new Date()): GeneratedTravelToken {
  const body = randomBytes(32).toString('base64url');
  const token = `${PREFIX[kind]}${body}`;
  const expiresAt = new Date(now.getTime() + Math.max(1, ttlHours) * 3_600_000).toISOString();
  return { token, hash: hashTravelToken(token), expiresAt };
}

export function hashTravelToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Cheap structural check before hashing + DB lookup. */
export function looksLikeTravelToken(value: string, kind: TravelTokenKind): boolean {
  if (typeof value !== 'string') return false;
  const p = PREFIX[kind];
  if (!value.startsWith(p)) return false;
  const body = value.slice(p.length);
  return body.length >= 32 && body.length <= 64 && /^[A-Za-z0-9_-]+$/.test(body);
}

/** Constant-time hex compare (length mismatch → false). */
export function tokenHashEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

export type TokenState = 'valid' | 'expired' | 'revoked';

/** Evaluate a stored token row's liveness. */
export function tokenState(
  row: { expires_at?: string | null; revoked_at?: string | null; quote_token_expires_at?: string | null; quote_token_revoked_at?: string | null },
  now = new Date()
): TokenState {
  const revoked = row.revoked_at ?? row.quote_token_revoked_at ?? null;
  if (revoked) return 'revoked';
  const expires = row.expires_at ?? row.quote_token_expires_at ?? null;
  if (!expires) return 'expired';
  return new Date(expires).getTime() > now.getTime() ? 'valid' : 'expired';
}
