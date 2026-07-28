// ============================================================
// Public deal-page links for catalog packages.
//
// The Oliday site curates a small set of published deal pages
// (`bestDeals`); some mirror an exact catalog package via
// `source.promoId + hId`. When a search result has one, the bot puts
// the public link on its card so the traveller can browse photos and
// the full itinerary on the site.
//
// Fetched from the site's public API and cached in-memory. Entirely
// best-effort: a missing/failed fetch means cards simply go out
// without links — it must never break or slow a search turn.
// ============================================================

const CACHE_TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 5_000;

let cache: { at: number; links: Map<string, string> } | null = null;

function siteUrl(): string {
  return (process.env.OLIDAY_SITE_URL ?? 'https://oliday.app').replace(
    /\/+$/,
    ''
  );
}

/** Map key — promo/h ids are strings in Firestore and numbers-or-
 *  strings in the catalog, so both sides normalize through here. */
export function dealKey(
  promoId: string | number,
  hId: string | number
): string {
  return `${promoId}:${hId}`;
}

/** `promoId:hId` → public deal-page URL, for every published deal
 *  that mirrors a catalog package. Empty map on any failure. */
export async function dealLinks(): Promise<Map<string, string>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.links;

  const links = new Map<string, string>();
  try {
    const res = await fetch(`${siteUrl()}/api/best-deals`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) {
      const body = (await res.json()) as {
        deals?: {
          id?: string;
          source?: { promoId?: string; hId?: string } | null;
        }[];
      };
      for (const d of body.deals ?? []) {
        if (d?.id && d.source?.promoId && d.source?.hId) {
          links.set(
            dealKey(d.source.promoId, d.source.hId),
            `${siteUrl()}/deals/${d.id}`
          );
        }
      }
    }
  } catch (err) {
    console.warn(
      '[oliday] best-deals fetch failed (cards go out without links):',
      err instanceof Error ? err.message : err
    );
  }

  // Failures are cached too — a down site shouldn't be re-hit (and
  // re-waited-on) by every subsequent search inside the TTL.
  cache = { at: Date.now(), links };
  return links;
}
