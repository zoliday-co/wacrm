// ============================================================
// Base URL for the public travel pages (supplier quote form,
// traveller callback, traveller quote). Server-only.
//
// Resolution: TRAVEL_PUBLIC_BASE_URL → NEXT_PUBLIC_SITE_URL →
// request headers (X-Forwarded-Host / Host) → fallback. These
// links go out over WhatsApp, so a wrong origin means a dead link;
// operators should set NEXT_PUBLIC_SITE_URL in production.
// ============================================================

export function publicBaseUrl(request?: Request | null): string {
  const explicit = process.env.TRAVEL_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  if (request) {
    const proto = request.headers.get('x-forwarded-proto') ?? 'https';
    const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
    if (host) return `${proto}://${host}`;
  }
  console.warn('[travel] no NEXT_PUBLIC_SITE_URL set — public links will use http://localhost:3000');
  return 'http://localhost:3000';
}

export function supplierQuoteUrl(token: string, request?: Request | null): string {
  return `${publicBaseUrl(request)}/supplier/quote/${encodeURIComponent(token)}`;
}

export function callbackUrl(token: string, request?: Request | null): string {
  return `${publicBaseUrl(request)}/trip/callback/${encodeURIComponent(token)}`;
}

export function travellerQuoteUrl(token: string, request?: Request | null): string {
  return `${publicBaseUrl(request)}/q/${encodeURIComponent(token)}`;
}

export function itineraryUrl(token: string, request?: Request | null): string {
  return `${publicBaseUrl(request)}/trip/itinerary/${encodeURIComponent(token)}`;
}
