// ============================================================
// Supplier matching — destination → ranked supplier list.
//
// Pure ranking (`rankSuppliers`) is separated from the DB loader
// (`matchSuppliersForLead`) so the rules are unit-testable:
//
//   1. supplier active + not deleted + status ACTIVE
//   2. serves the primary destination (or any selected
//      sub-destination, or the destination's parent)
//   3. preferred (supplier-level OR mapping-level) first
//   4. then mapping priority ascending (1 = first choice)
//   5. then rating descending
//   6. capped at `limit` (travel_settings.max_suppliers_per_rfq)
//
// Matching is by destination id. The lead's free-text
// `destination_primary` is resolved to a destination row via
// name / slug / alias (case-insensitive); sub-destinations the
// same way. Unresolvable names simply match nothing — the agent
// can still add suppliers by hand.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Destination, Supplier, SupplierDestination } from '@/types/travel';

export interface MatchCandidate {
  supplier: Supplier;
  mapping: SupplierDestination;
  /** Which destination id the mapping matched (primary or sub). */
  matchedDestinationId: string;
  /** True when matched on the primary destination (vs a sub-destination). */
  primaryMatch: boolean;
}

export interface MatchResult {
  suppliers: Supplier[];
  candidates: MatchCandidate[];
  destinationIds: string[];
  resolvedDestination: Destination | null;
}

/** Pure: rank + cap candidates. One entry per supplier (best mapping wins). */
export function rankSuppliers(candidates: MatchCandidate[], limit: number): MatchCandidate[] {
  const bySupplier = new Map<string, MatchCandidate>();
  for (const c of candidates) {
    if (!isEligible(c)) continue;
    const prev = bySupplier.get(c.supplier.id);
    if (!prev || compareCandidates(c, prev) < 0) bySupplier.set(c.supplier.id, c);
  }
  return [...bySupplier.values()]
    .sort(compareCandidates)
    .slice(0, Math.max(0, limit));
}

function isEligible(c: MatchCandidate): boolean {
  const s = c.supplier;
  return (
    s.active &&
    !s.deleted_at &&
    s.status === 'ACTIVE' &&
    c.mapping.active
  );
}

function compareCandidates(a: MatchCandidate, b: MatchCandidate): number {
  const prefA = a.supplier.preferred || a.mapping.preferred ? 1 : 0;
  const prefB = b.supplier.preferred || b.mapping.preferred ? 1 : 0;
  if (prefA !== prefB) return prefB - prefA;
  if (a.primaryMatch !== b.primaryMatch) return a.primaryMatch ? -1 : 1;
  if (a.mapping.priority !== b.mapping.priority) return a.mapping.priority - b.mapping.priority;
  const rA = Number(a.supplier.rating ?? 0);
  const rB = Number(b.supplier.rating ?? 0);
  if (rA !== rB) return rB - rA;
  return a.supplier.name.localeCompare(b.supplier.name);
}

/** Pure: resolve a free-text destination against the account's list. */
export function resolveDestination(
  name: string | null | undefined,
  destinations: Destination[]
): Destination | null {
  if (!name) return null;
  const needle = norm(name);
  if (!needle) return null;
  for (const d of destinations) {
    if (!d.active) continue;
    if (norm(d.name) === needle || norm(d.slug) === needle) return d;
  }
  for (const d of destinations) {
    if (!d.active) continue;
    if ((d.aliases ?? []).some((a) => norm(a) === needle)) return d;
  }
  // Loose containment ("kerala backwaters" → Kerala)
  for (const d of destinations) {
    if (!d.active) continue;
    if (needle.includes(norm(d.name)) && norm(d.name).length >= 4) return d;
  }
  return null;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * DB loader: find suppliers for a lead's destinations.
 * `db` may be RLS-scoped or service-role — every query filters by
 * `accountId` regardless.
 */
export async function matchSuppliersForLead(
  db: SupabaseClient,
  accountId: string,
  input: { destination_primary: string | null; destinations: string[] | null },
  limit: number
): Promise<MatchResult> {
  const { data: destRows } = await db
    .from('destinations')
    .select('*')
    .eq('account_id', accountId);
  const destinations = (destRows ?? []) as Destination[];

  const primary = resolveDestination(input.destination_primary, destinations);
  const subs = (input.destinations ?? [])
    .map((n) => resolveDestination(n, destinations))
    .filter((d): d is Destination => d !== null);

  const idSet = new Set<string>();
  if (primary) {
    idSet.add(primary.id);
    if (primary.parent_id) idSet.add(primary.parent_id);
  }
  for (const s of subs) idSet.add(s.id);
  // Sub-destinations of the primary also count ("Kerala" supplier
  // mapped only to Munnar still serves a generic Kerala ask).
  if (primary) {
    for (const d of destinations) if (d.parent_id === primary.id) idSet.add(d.id);
  }
  const destinationIds = [...idSet];
  if (destinationIds.length === 0) {
    return { suppliers: [], candidates: [], destinationIds, resolvedDestination: primary };
  }

  const { data: mappings } = await db
    .from('supplier_destinations')
    .select('*, supplier:suppliers(*)')
    .eq('account_id', accountId)
    .in('destination_id', destinationIds)
    .eq('active', true);

  const candidates: MatchCandidate[] = [];
  for (const m of (mappings ?? []) as (SupplierDestination & { supplier: Supplier | null })[]) {
    if (!m.supplier) continue;
    candidates.push({
      supplier: m.supplier,
      mapping: m,
      matchedDestinationId: m.destination_id,
      primaryMatch: primary ? m.destination_id === primary.id : false,
    });
  }

  const ranked = rankSuppliers(candidates, limit);
  return {
    suppliers: ranked.map((c) => c.supplier),
    candidates: ranked,
    destinationIds,
    resolvedDestination: primary,
  };
}
