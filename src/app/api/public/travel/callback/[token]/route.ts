import { NextResponse } from 'next/server';
import { callbackPublicView, createCallbackRequest, resolveCallbackToken } from '@/lib/travel/callbacks';
import { travelErrorResponse } from '@/lib/travel/errors';

type TokenContext = { params: Promise<{ token: string }> };

export async function GET(_request: Request, { params }: TokenContext) {
  try {
    const { token } = await params;
    return NextResponse.json(callbackPublicView((await resolveCallbackToken(token)).lead));
  } catch (error) {
    return travelErrorResponse(error);
  }
}

export async function POST(request: Request, { params }: TokenContext) {
  try {
    const { token } = await params;
    const callback = await createCallbackRequest(token, await request.json(), request);
    return NextResponse.json({ callback: { id: callback.id, status: callback.status, scheduled_at: callback.scheduled_at } }, { status: 201 });
  } catch (error) {
    return travelErrorResponse(error);
  }
}
