import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { renderItineraryPdf } from './itinerary-pdf';
import type { PublicItineraryView } from './itinerary-sharing';

describe('branded itinerary PDF', () => {
  it('renders a readable multi-page Oliday document', async () => {
    const view = sampleView();
    const bytes = await renderItineraryPdf(view);
    const pdf = await PDFDocument.load(bytes);

    expect(pdf.getTitle()).toBe('Ladakh: High passes and quiet valleys');
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(3);

  });
});

function sampleView(): PublicItineraryView {
  return {
    traveller_name: 'Aarav and family',
    destination: 'Ladakh',
    destinations: ['Leh', 'Nubra Valley', 'Pangong Lake'],
    travel_start_date: '2026-11-02',
    travel_end_date: '2026-11-07',
    travel_month: 'November 2026',
    nights: 5,
    days: 6,
    adults: 2,
    children: 1,
    child_ages: [4],
    hotel_category: '3 star',
    room_configuration: 'Double sharing',
    meal_plan: 'Breakfast',
    vehicle_type: 'SUV',
    special_requests: 'A relaxed pace on the first day for acclimatisation.',
    itinerary: {
      id: 'itinerary-preview',
      account_id: 'account-preview',
      travel_lead_id: 'lead-preview',
      traveller_quote_id: null,
      version: 1,
      title: 'Ladakh: High passes and quiet valleys',
      summary: 'A six-day family journey through Leh, Nubra Valley and Pangong Lake with time to acclimatise and enjoy the landscape.',
      hero_image_url: null,
      status: 'FINAL',
      generated_by: 'manual',
      extras: { inclusions: '5 nights accommodation\nDaily breakfast\nPrivate SUV and sightseeing', exclusions: 'Flights\nLunch and dinner\nPersonal expenses', notes: 'Carry warm layers and a government-issued photo ID.' },
      created_by: null,
      created_at: '2026-09-15T00:00:00Z',
      updated_at: '2026-09-15T00:00:00Z',
      days: Array.from({ length: 6 }, (_, index) => ({
        id: `day-${index + 1}`,
        account_id: 'account-preview',
        itinerary_id: 'itinerary-preview',
        day_number: index + 1,
        date: `2026-11-0${index + 2}`,
        title: index === 0 ? 'Arrive in Leh and acclimatise' : index === 5 ? 'Departure from Leh' : `Explore Ladakh - day ${index + 1}`,
        description: 'Travel at an easy pace, take in the mountain views, and stop for local experiences selected for the family.',
        hotel: 'Comfortable 3-star stay',
        meals: 'Breakfast',
        transport: 'Private SUV',
        activities: ['Scenic drive', 'Local sightseeing', 'Time at leisure'],
        sort_order: index,
        created_at: '2026-09-15T00:00:00Z',
      })),
    },
  };
}
