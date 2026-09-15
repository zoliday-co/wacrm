import { travelRoute, readJson } from '@/lib/travel/route';
import { getBooking, setBookingStatus } from '@/lib/travel/bookings';
import { badRequest } from '@/lib/travel/errors';
import type { BookingStatus } from '@/types/travel';

const STATUSES: BookingStatus[] = ['CONFIRMED', 'PARTIALLY_PAID', 'FULLY_PAID', 'UPCOMING', 'ONGOING', 'COMPLETED', 'CANCELLED'];
export const GET = travelRoute('viewer', async (ctx) => ({ booking: await getBooking(ctx.supabase, ctx.accountId, ctx.params.id) }));
export const PATCH = travelRoute('agent', async (ctx, request) => {
  const body = await readJson(request);
  if (!STATUSES.includes(body.status as BookingStatus)) throw badRequest('Unknown booking status');
  return { booking: await setBookingStatus(ctx.supabase, ctx.accountId, ctx.params.id, body.status as BookingStatus, { actorUserId: ctx.userId, reason: typeof body.reason === 'string' ? body.reason : null }) };
});
