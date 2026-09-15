import { describe, expect, it } from 'vitest';
import { parseItineraryInput, skeletonDays } from './itineraries';

describe('itinerary builder data', () => {
  it('normalizes detailed itinerary fields and traveller notes', () => {
    const itinerary = parseItineraryInput({
      title: ' Ladakh escape ',
      summary: ' Five unforgettable nights ',
      inclusions: 'Hotels and breakfast',
      exclusions: 'Flights',
      notes: 'Carry warm layers',
      days: [{
        day_number: 1,
        date: '2026-11-02',
        title: ' Arrival in Leh ',
        description: 'Acclimatise and rest',
        hotel: 'Leh hotel',
        meals: 'Dinner',
        transport: 'SUV',
        activities: [' Airport pickup ', '', 'Evening market'],
      }],
    });

    expect(itinerary.title).toBe('Ladakh escape');
    expect(itinerary.inclusions).toBe('Hotels and breakfast');
    expect(itinerary.exclusions).toBe('Flights');
    expect(itinerary.notes).toBe('Carry warm layers');
    expect(itinerary.days[0]).toMatchObject({
      date: '2026-11-02',
      title: 'Arrival in Leh',
      hotel: 'Leh hotel',
      meals: 'Dinner',
      transport: 'SUV',
      activities: ['Airport pickup', 'Evening market'],
    });
  });

  it('creates dated arrival, sightseeing, and departure days from the lead', () => {
    const days = skeletonDays({
      nights: 2,
      days: null,
      destination_primary: 'Ladakh',
      destinations: ['Leh', 'Nubra'],
      travel_start_date: '2026-11-02',
      pickup_location: 'Leh airport',
      drop_location: 'Leh airport',
    });

    expect(days).toHaveLength(3);
    expect(days.map((day) => day.date)).toEqual(['2026-11-02', '2026-11-03', '2026-11-04']);
    expect(days[0].title).toContain('Arrival');
    expect(days[2].title).toContain('Departure');
  });
});
