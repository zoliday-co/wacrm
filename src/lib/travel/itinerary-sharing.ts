import type { SupabaseClient } from '@supabase/supabase-js';
import type { Itinerary, TravelLead } from '@/types/travel';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { LEAD_EVENT_TYPES } from './constants';
import { recordLeadEvent } from './events';
import { TravelError, notFound } from './errors';
import { getItinerary, setItineraryStatus } from './itineraries';
import { getLead } from './leads';
import { itineraryUrl } from './public-url';
import { generateTravelToken, hashTravelToken, looksLikeTravelToken, tokenState } from './tokens';
import { sendTravelWhatsApp, type TravelSendResult } from './whatsapp';

export interface PublicItineraryView {
  itinerary: Itinerary;
  traveller_name: string | null;
  destination: string | null;
  destinations: string[];
  travel_start_date: string | null;
  travel_end_date: string | null;
  travel_month: string | null;
  nights: number | null;
  days: number | null;
  adults: number;
  children: number;
  child_ages: number[];
  hotel_category: string | null;
  room_configuration: string | null;
  meal_plan: string | null;
  vehicle_type: string | null;
  special_requests: string | null;
}

export async function shareItinerary(
  db: SupabaseClient,
  accountId: string,
  itineraryId: string,
  opts: { actorUserId: string | null; request?: Request | null }
): Promise<{ url: string; sent: TravelSendResult | null }> {
  let itinerary = await getItinerary(db, accountId, itineraryId);
  if (itinerary.status === 'DRAFT') {
    itinerary = await setItineraryStatus(db, accountId, itineraryId, 'FINAL', opts.actorUserId);
  }
  const lead = await getLead(db, accountId, itinerary.travel_lead_id);
  const admin = supabaseAdmin();
  await admin
    .from('travel_access_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('kind', 'itinerary')
    .eq('subject_id', itinerary.id)
    .is('revoked_at', null);

  const token = generateTravelToken('itinerary', 24 * 30);
  const { error } = await admin.from('travel_access_tokens').insert({
    account_id: accountId,
    kind: 'itinerary',
    token_hash: token.hash,
    travel_lead_id: lead.id,
    subject_id: itinerary.id,
    expires_at: token.expiresAt,
  });
  if (error) throw new Error(`Failed to create itinerary link: ${error.message}`);

  const url = itineraryUrl(token.token, opts.request);
  let sent: TravelSendResult | null = null;
  if (lead.conversation_id) {
    sent = await sendTravelWhatsApp({
      db: admin,
      accountId,
      conversationId: lead.conversation_id,
      text: [
        '*Your Oliday itinerary is ready*',
        itinerary.title,
        '',
        `View and download it here: ${url}`,
      ].join('\n'),
    });
  }

  await recordLeadEvent(admin, {
    accountId,
    leadId: lead.id,
    type: LEAD_EVENT_TYPES.ITINERARY_SHARED,
    actorType: 'agent',
    actorUserId: opts.actorUserId,
    title: `Itinerary V${itinerary.version} shared on WhatsApp`,
    details: { itinerary_id: itinerary.id, sent: sent?.ok ?? false, send_error: sent && !sent.ok ? sent.error : null },
  });
  return { url, sent };
}

export async function resolveItineraryToken(token: string): Promise<PublicItineraryView> {
  if (!looksLikeTravelToken(token, 'itinerary')) throw new TravelError('invalid_token', 'This itinerary link is not valid', 404);
  const admin = supabaseAdmin();
  const { data: row } = await admin
    .from('travel_access_tokens')
    .select('*')
    .eq('token_hash', hashTravelToken(token))
    .eq('kind', 'itinerary')
    .maybeSingle();
  if (!row) throw new TravelError('invalid_token', 'This itinerary link is not valid', 404);
  const state = tokenState(row);
  if (state === 'revoked') throw new TravelError('revoked_token', 'This itinerary link is no longer active', 410);
  if (state === 'expired') throw new TravelError('expired_token', 'This itinerary link has expired', 410);
  const itinerary = await getItinerary(admin, row.account_id as string, row.subject_id as string);
  const lead = await getLead(admin, row.account_id as string, row.travel_lead_id as string);
  if (!itinerary || !lead) throw notFound('Itinerary');
  const now = new Date().toISOString();
  await admin.from('travel_access_tokens').update({
    last_used_at: now,
    first_used_at: row.first_used_at ?? now,
    use_count: (row.use_count as number) + 1,
  }).eq('id', row.id);
  return publicItineraryView(itinerary, lead);
}

export function publicItineraryView(itinerary: Itinerary, lead: TravelLead): PublicItineraryView {
  return {
    itinerary,
    traveller_name: lead.traveller_name,
    destination: lead.destination_primary,
    destinations: lead.destinations,
    travel_start_date: lead.travel_start_date,
    travel_end_date: lead.travel_end_date,
    travel_month: lead.travel_month,
    nights: lead.nights,
    days: lead.days,
    adults: lead.adults,
    children: lead.children,
    child_ages: lead.child_ages,
    hotel_category: lead.hotel_category,
    room_configuration: lead.room_configuration,
    meal_plan: lead.meal_plan,
    vehicle_type: lead.vehicle_type,
    special_requests: lead.special_requests,
  };
}
