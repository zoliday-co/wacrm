import { NextResponse } from 'next/server';
import { resolveTravellerQuoteToken, travellerQuoteAction, travellerQuotePublicView } from '@/lib/travel/traveller-quotes';
import { badRequest, travelErrorResponse } from '@/lib/travel/errors';

type TokenContext = { params: Promise<{ token: string }> };

export async function GET(_request: Request, { params }: TokenContext) {
  try {
    const { token } = await params;
    return NextResponse.json(travellerQuotePublicView(await resolveTravellerQuoteToken(token)));
  } catch (error) {
    return travelErrorResponse(error);
  }
}

export async function POST(request: Request, { params }: TokenContext) {
  try {
    const { token } = await params;
    const body = (await request.json()) as Record<string, unknown>;
    const action = body.action;
    if (action !== 'accept' && action !== 'request_change' && action !== 'talk_to_expert') throw badRequest('Unknown action');
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) || null : null;
    return NextResponse.json(await travellerQuoteAction(token, action, note));
  } catch (error) {
    return travelErrorResponse(error);
  }
}
