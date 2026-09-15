// ============================================================
// Route helper for the dashboard-facing travel API.
//
//   export const GET = travelRoute('viewer', async (ctx, req) => { ... });
//
// Resolves the caller's account context (cookie/JWT session, RLS
// client), enforces a minimum role, parses `params`, and maps any
// thrown TravelError / auth error onto `{ error }` + status.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, type AccountContext } from '@/lib/auth/account';
import type { AccountRole } from '@/lib/auth/roles';
import { travelErrorResponse } from './errors';

export interface RouteCtx extends AccountContext {
  params: Record<string, string>;
}

type Handler = (ctx: RouteCtx, request: Request) => Promise<Response | unknown>;

export function travelRoute(minRole: AccountRole, handler: Handler) {
  return async (request: Request, routeCtx?: { params: Promise<Record<string, string>> }): Promise<Response> => {
    try {
      const account = await requireRole(minRole);
      const params = routeCtx?.params ? await routeCtx.params : {};
      const result = await handler({ ...account, params }, request);
      if (result instanceof Response) return result;
      return NextResponse.json(result ?? { ok: true });
    } catch (err) {
      return travelErrorResponse(err);
    }
  };
}

/** Parse a JSON body, tolerating an empty body. */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const text = await request.text();
    if (!text) return {};
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function query(request: Request): URLSearchParams {
  return new URL(request.url).searchParams;
}
