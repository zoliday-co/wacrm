// ============================================================
// Typed error for the travel service layer. Routes map it to
// `{ error }` + status via `travelErrorResponse`.
// ============================================================

import { NextResponse } from 'next/server';
import { ForbiddenError, UnauthorizedError } from '@/lib/auth/account';
import { ApiError } from '@/lib/api/v1/respond';

export class TravelError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'TravelError';
    this.code = code;
    this.status = status;
  }
}

export function notFound(what = 'Resource'): TravelError {
  return new TravelError('not_found', `${what} not found`, 404);
}

export function badRequest(message: string): TravelError {
  return new TravelError('bad_request', message, 400);
}

export function conflict(message: string): TravelError {
  return new TravelError('conflict', message, 409);
}

/** Map any thrown value onto the dashboard's `{ error }` shape. */
export function travelErrorResponse(err: unknown): NextResponse {
  if (err instanceof TravelError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof ApiError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status, headers: err.headers });
  }
  console.error('[travel] uncategorized error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}
