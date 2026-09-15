import { travelRoute, readJson } from '@/lib/travel/route';
import { parseCustomerPaymentInput, recordCustomerPayment } from '@/lib/travel/bookings';

export const POST = travelRoute('agent', async (ctx, request) => recordCustomerPayment(ctx.supabase, ctx.accountId, ctx.params.id, parseCustomerPaymentInput(await readJson(request)), ctx.userId));
