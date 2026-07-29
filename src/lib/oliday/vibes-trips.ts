// ============================================================
// Vibes trip lookups — the Vibes agent's grounding source.
//
// Reads the site's public projection (`/api/vibes/public`): trip
// facts, spots left, host name/badges. Never quotes, rosters or any
// traveller's contact details — the endpoint doesn't expose them, so
// the model cannot leak what it never sees (spec §2: "facts the bot
// must NOT invent" all come from here).
// ============================================================

const FETCH_TIMEOUT_MS = 6_000;

export interface VibeTripPublic {
  id: string;
  title: string;
  startCity: string | null;
  destination: string;
  travelMonth: string;
  days: number;
  groupType: string;
  spots: number;
  memberCount: number;
  spotsLeft: number;
  vibes: string[];
  description: string;
  status: string;
  hostName: string | null;
  hostIsBrand: boolean;
}

function siteUrl(): string {
  return (process.env.OLIDAY_SITE_URL ?? 'https://oliday.app').replace(
    /\/+$/,
    ''
  );
}

/** The in-app trip link the bot sends (opens that trip directly). */
export function vibeTripLink(tripId: string): string {
  return `${siteUrl()}/vibes/app/${tripId}`;
}

export const VIBES_APP_URL_PATH = '/vibes/app';

/** The app + story links, for the prompt. */
export function vibesAppUrl(): string {
  return `${siteUrl()}${VIBES_APP_URL_PATH}`;
}
export function vibesStoryUrl(): string {
  return `${siteUrl()}/vibes`;
}

export async function getVibeTrip(
  tripId: string
): Promise<VibeTripPublic | null> {
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(tripId)) return null;
  try {
    const res = await fetch(
      `${siteUrl()}/api/vibes/public?tripId=${encodeURIComponent(tripId)}`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { trip?: VibeTripPublic };
    return body.trip ?? null;
  } catch (err) {
    console.warn(
      '[oliday vibes] trip fetch failed:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

export async function listOpenVibeTrips(): Promise<VibeTripPublic[]> {
  try {
    const res = await fetch(`${siteUrl()}/api/vibes/public`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { trips?: VibeTripPublic[] };
    return Array.isArray(body.trips) ? body.trips : [];
  } catch (err) {
    console.warn(
      '[oliday vibes] open-trips fetch failed:',
      err instanceof Error ? err.message : err
    );
    return [];
  }
}
