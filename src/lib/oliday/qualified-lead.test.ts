import { describe, expect, it } from 'vitest';
import { qualifiedLeadPayload } from './qualified-lead';

describe('qualifiedLeadPayload', () => {
  it('maps a completed WhatsApp qualification into the travel CRM contract', () => {
    const payload = qualifiedLeadPayload({
      accountId: 'account-1',
      conversationId: 'conversation-1',
      contact: {
        name: 'Asha',
        phone: '919876543210',
        referral: { source_id: 'ad-42', headline: 'Kashmir holidays' },
      },
      trip: {
        destination: 'Kashmir',
        adults: 3,
        children: 1,
        childAges: [8],
        nights: 5,
        travelMonth: 'December 2026',
        starCategory: 4,
        vehicleType: 'SEDAN',
        placesToCover: ['Gulmarg', 'Pahalgam'],
        specificRequirements: 'Vegetarian meals',
      },
    });

    expect(payload.bot_session_id).toBe('oliday-whatsapp:account-1:conversation-1');
    expect(payload.source).toMatchObject({
      type: 'meta_whatsapp_ad',
      ad_id: 'ad-42',
      ad_name: 'Kashmir holidays',
    });
    expect(payload.trip).toMatchObject({
      destination_primary: 'Kashmir',
      destinations: ['Gulmarg', 'Pahalgam'],
      nights: 5,
      days: 6,
      adults: 3,
      children: 1,
      child_ages: [8],
      hotel_category: '4 star',
      vehicle_type: 'Sedan',
      special_requests: 'Vegetarian meals',
    });
  });

  it('records an organic lead and treats no requirements as an answered slot', () => {
    const payload = qualifiedLeadPayload({
      accountId: 'a',
      conversationId: 'c',
      contact: { name: null, phone: '911234567890', referral: null },
      trip: {
        destination: 'Kerala',
        adults: 2,
        nights: 4,
        dateFlexibility: 'FLEXIBLE',
        starCategory: 3,
        vehicleType: 'HATCHBACK',
        placesToCover: ['Munnar'],
        specificRequirements: 'None',
      },
    });

    expect(payload.source.type).toBe('whatsapp_organic');
    expect(payload.trip.vehicle_type).toBe('Hatchback');
    expect(payload.trip.special_requests).toBeNull();
  });
});
