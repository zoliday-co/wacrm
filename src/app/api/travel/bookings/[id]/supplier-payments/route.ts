import { travelRoute, readJson } from '@/lib/travel/route';
import { parseSupplierPaymentInput, recordSupplierPayment } from '@/lib/travel/bookings';

export const POST = travelRoute('agent', async (ctx, request) => recordSupplierPayment(ctx.supabase, ctx.accountId, ctx.params.id, parseSupplierPaymentInput(await readJson(request)), ctx.userId));
