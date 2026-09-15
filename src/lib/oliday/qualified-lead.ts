import type { SupabaseClient } from '@supabase/supabase-js';
import type { QualifiedLeadPayload } from '@/lib/travel/qualified-payload';
import { ingestQualifiedLead } from '@/lib/travel/leads';
import { createRfqForLead } from '@/lib/travel/rfq';
import { getTravelSettings } from '@/lib/travel/settings';
import { derivedRooms, totalPax, type Trip, type VehicleType } from './trip';

interface ContactSnapshot {
  name: string | null;
  phone: string;
  referral: Record<string, unknown> | null;
}

interface SyncInput {
  db: SupabaseClient;
  accountId: string;
  conversationId: string;
  contact: ContactSnapshot;
  trip: Trip;
}

const VEHICLE_LABEL: Record<VehicleType, string> = {
  HATCHBACK: 'Hatchback',
  SEDAN: 'Sedan',
  SUV_MUV: 'SUV',
  TEMPO_TRAVELLER: 'Tempo Traveller',
  MINI_BUS: 'Mini Bus',
};

/** Convert validated bot state into the canonical travel-lead contract. */
export function qualifiedLeadPayload(input: Omit<SyncInput, 'db'>): QualifiedLeadPayload {
  const { accountId, conversationId, contact, trip } = input;
  const referral = contact.referral;
  const sourceValue = (key: string): string | null => {
    const value = referral?.[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  };
  const places = trip.placesToCover ?? [];
  const pax = totalPax(trip) ?? trip.adults ?? 0;
  const dateLabel = trip.checkInDate
    ? `${trip.checkInDate}${trip.checkOutDate ? ` to ${trip.checkOutDate}` : ''}`
    : trip.travelMonth ?? trip.dateFlexibility ?? 'Flexible';
  const special = trip.specificRequirements === 'None' ? null : trip.specificRequirements ?? null;

  return {
    bot_session_id: `oliday-whatsapp:${accountId}:${conversationId}`,
    traveller: { name: contact.name, phone: contact.phone },
    source: {
      type: referral ? 'meta_whatsapp_ad' : 'whatsapp_organic',
      campaign_id: sourceValue('campaign_id'),
      campaign_name: sourceValue('campaign_name'),
      adset_id: sourceValue('adset_id'),
      ad_id: sourceValue('ad_id') ?? sourceValue('source_id'),
      ad_name: sourceValue('ad_name') ?? sourceValue('headline'),
      referral_data: referral,
    },
    trip: {
      destination_primary: trip.destination!,
      destinations: places,
      travel_start_date: trip.checkInDate ?? null,
      travel_end_date: trip.checkOutDate ?? null,
      travel_month: trip.travelMonth ?? null,
      dates_flexible: trip.dateFlexibility !== 'EXACT_DATES',
      nights: trip.nights,
      days: trip.nights !== undefined ? trip.nights + 1 : null,
      adults: trip.adults ?? 0,
      children: trip.children ?? 0,
      infants: 0,
      child_ages: trip.childAges ?? [],
      room_count: derivedRooms(trip) ?? (trip.adults ? Math.ceil(trip.adults / 2) : null),
      room_configuration: trip.roomOccupancy ?? null,
      hotel_category: trip.starCategory ? `${trip.starCategory} star` : null,
      meal_plan: trip.mealPlan ?? null,
      vehicle_type: trip.vehicleType ? VEHICLE_LABEL[trip.vehicleType] : null,
      activities: [],
      special_requests: special,
      qualification_summary: [
        `${pax} traveller${pax === 1 ? '' : 's'}`,
        `${trip.nights} nights in ${trip.destination}`,
        `travel ${dateLabel}`,
        `${trip.starCategory} star stay`,
        trip.vehicleType ? VEHICLE_LABEL[trip.vehicleType] : null,
        `cover: ${places.join(', ')}`,
        special ? `requirements: ${special}` : 'no specific requirements',
      ].filter(Boolean).join(' · '),
    },
    conversation_id: conversationId,
  };
}

/** Create the qualified lead and its first supplier RFQ once. */
export async function syncQualifiedTripToCrm(input: SyncInput): Promise<{ leadId: string }> {
  const payload = qualifiedLeadPayload(input);
  const result = await ingestQualifiedLead(input.db, input.accountId, payload, { actorType: 'bot' });

  if (result.created) {
    try {
      const settings = await getTravelSettings(input.db, input.accountId);
      await createRfqForLead(input.db, input.accountId, result.lead.id, {
        actorUserId: null,
        send: settings.auto_send_rfq,
        request: null,
      });
    } catch (err) {
      // The lead is already safe in CRM. The lead timeline/UI exposes
      // RFQ matching failures for an agent to retry.
      console.error('[oliday] initial RFQ creation failed:', err instanceof Error ? err.message : err);
    }
  }

  return { leadId: result.lead.id };
}
