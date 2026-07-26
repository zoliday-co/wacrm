import { describe, it, expect } from 'vitest';
import {
  mergeTrip,
  nextMissingSlot,
  readyToSearch,
  totalPax,
  derivedRooms,
  vehicleOptionsForPax,
  fallbackQuestion,
  type Trip,
} from './trip';

describe('mergeTrip', () => {
  it('fills several slots from one extraction (acceptance 2)', () => {
    const trip = mergeTrip(
      {},
      {
        destination: 'Kashmir',
        nights: 5,
        adults: 2,
        children: 1,
        starCategory: 3,
        travelMonth: 'December 2026',
      }
    );
    expect(trip).toMatchObject({
      destination: 'Kashmir',
      region: 'Kashmir',
      nights: 5,
      adults: 2,
      children: 1,
      starCategory: 3,
    });
    expect(readyToSearch(trip)).toBe(true);
    expect(totalPax(trip)).toBe(3);
  });

  it('resolves a city-level destination to its region', () => {
    const trip = mergeTrip({}, { destination: 'Coorg' });
    expect(trip.region).toBe('Karnataka');
  });

  it('leaves region unset for uncovered destinations', () => {
    const trip = mergeTrip({}, { destination: 'Bali' });
    expect(trip.destination).toBe('Bali');
    expect(trip.region).toBeUndefined();
    expect(readyToSearch({ ...trip, nights: 5, adults: 2 })).toBe(false);
  });

  it('never un-fills a slot on an absent extraction', () => {
    const trip = mergeTrip({ nights: 5, adults: 2 }, { destination: 'Kerala' });
    expect(trip.nights).toBe(5);
    expect(trip.adults).toBe(2);
  });

  it('drops invalid values from the untrusted LLM', () => {
    const trip = mergeTrip(
      {},
      {
        nights: 999,
        adults: -1,
        tripType: 'PARTY',
        mealPlan: 'FEAST',
        starCategory: 7,
        checkInDate: 'tomorrow',
      }
    );
    expect(trip).toEqual({});
  });

  it('derives checkOutDate from checkInDate + nights', () => {
    const trip = mergeTrip({}, { checkInDate: '2026-12-10', nights: 5 });
    expect(trip.checkOutDate).toBe('2026-12-15');
  });

  it('derives nights from the date pair', () => {
    const trip = mergeTrip(
      {},
      {
        checkInDate: '2026-06-30',
        checkOutDate: '2026-07-05',
      }
    );
    expect(trip.nights).toBe(5);
  });
});

describe('slot order', () => {
  it('walks the §6 order', () => {
    const trip: Trip = {};
    expect(nextMissingSlot(trip)).toBe('destination');
    trip.destination = 'Kashmir';
    expect(nextMissingSlot(trip)).toBe('dates');
    trip.travelMonth = 'December 2026';
    expect(nextMissingSlot(trip)).toBe('nights');
    trip.nights = 5;
    expect(nextMissingSlot(trip)).toBe('tripType');
    trip.tripType = 'FAMILY';
    expect(nextMissingSlot(trip)).toBe('pax');
    trip.adults = 2;
    expect(nextMissingSlot(trip)).toBe('roomOccupancy');
  });
});

describe('derivations (asked never, derived always)', () => {
  it('rooms from occupancy', () => {
    expect(derivedRooms({ adults: 5, roomOccupancy: 'DOUBLE' })).toBe(3);
    expect(derivedRooms({ adults: 5, roomOccupancy: 'TRIPLE' })).toBe(2);
    expect(derivedRooms({ adults: 5, roomOccupancy: 'SINGLE' })).toBe(5);
  });

  it('vehicle options sized to the group', () => {
    expect(vehicleOptionsForPax(2)).not.toContain('MINI_BUS');
    expect(vehicleOptionsForPax(10)).not.toContain('SEDAN');
    expect(vehicleOptionsForPax(20)).toEqual(['MINI_BUS']);
  });
});

describe('fallbackQuestion', () => {
  it('always produces a sendable question (the bot never goes silent)', () => {
    const stages: Trip[] = [
      {},
      { destination: 'Kashmir', region: 'Kashmir' },
      {
        destination: 'Kashmir',
        region: 'Kashmir',
        travelMonth: 'Dec',
        nights: 5,
      },
      {
        destination: 'Kashmir',
        region: 'Kashmir',
        travelMonth: 'Dec',
        nights: 5,
        tripType: 'FAMILY',
        adults: 4,
        children: 0,
        roomOccupancy: 'DOUBLE',
        mealPlan: 'BREAKFAST_DINNER',
        vehicleType: 'SUV_MUV',
        starCategory: 3,
      },
    ];
    for (const trip of stages) {
      const q = fallbackQuestion(trip);
      expect(q.text.length).toBeGreaterThan(10);
      // Button-bound options must fit Meta's 20-char title cap.
      for (const o of q.options.slice(0, 3)) {
        expect(o.length).toBeLessThanOrEqual(20);
      }
    }
  });
});
