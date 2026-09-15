import { NextResponse } from 'next/server';
import { resolveSupplierToken, supplierFormData, submitSupplierQuote } from '@/lib/travel/supplier-quotes';
import { travelErrorResponse } from '@/lib/travel/errors';

type TokenContext = { params: Promise<{ token: string }> };

export async function GET(_request: Request, { params }: TokenContext) {
  try {
    const { token } = await params;
    return NextResponse.json(supplierFormData(await resolveSupplierToken(token)));
  } catch (error) {
    return travelErrorResponse(error);
  }
}

export async function POST(request: Request, { params }: TokenContext) {
  try {
    const { token } = await params;
    const quote = await submitSupplierQuote(token, await request.json(), request);
    return NextResponse.json({ quote: { id: quote.id, version: quote.version, status: quote.status } }, { status: 201 });
  } catch (error) {
    return travelErrorResponse(error);
  }
}
