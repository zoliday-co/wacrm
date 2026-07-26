// ============================================================
// `get_package` — fetch ONE package's full row before presenting it
// in detail. Search results carry only the card summary; day-wise
// itinerary, the full hotel list, inclusions/exclusions and the price
// matrix must come from this fetch — never from the model's memory.
// ============================================================

import { catalogClient } from './catalog-client';

/**
 * Columns the LLM must never see, stripped before the row is handed
 * to the model so it CANNOT leak them:
 *   - view_details_url: supplier portal link (requires supplier login)
 *   - supplier_id / product_code / price_code: supplier references —
 *     useful to a human closing the booking, not to the traveller
 *   - search_text / fts: retrieval internals, token waste
 */
const FORBIDDEN_FIELDS = new Set([
  'view_details_url',
  'supplier_id',
  'product_code',
  'price_code',
  'search_text',
  'fts',
]);

export interface PackageDetail {
  [key: string]: unknown;
}

export async function getPackage(
  promoId: string | number,
  hId: string | number
): Promise<PackageDetail | null> {
  const db = catalogClient();
  const { data, error } = await db
    .from('active_packages')
    .select('*')
    .eq('promo_id', promoId)
    .eq('h_id', hId)
    .maybeSingle();
  if (error) throw new Error(`catalog fetch failed: ${error.message}`);
  if (!data) return null;

  const safe: PackageDetail = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (!FORBIDDEN_FIELDS.has(key)) safe[key] = value;
  }
  return safe;
}
