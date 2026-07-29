import { describe, it, expect } from 'vitest';
import {
  routeInbound,
  stripVibesTag,
  mergeVibes,
  vibesFallback,
  type VibesState,
} from './vibes';

const TAGGED =
  'Hi Oliday! I\'m interested in the Vibes trip "Your first free trip" — Kochi → Kerala, 3N/4D, Sep 2026. How does Vibes work and how do I join?\n(vibes:a3LiCguszIxhvCa7wswx)';

describe('routeInbound — the orchestration decision', () => {
  it('routes a tagged start to Vibes with the tripId (spec §1)', () => {
    const state = routeInbound(TAGGED, null);
    expect(state).toMatchObject({
      active: true,
      tripId: 'a3LiCguszIxhvCa7wswx',
    });
  });

  it('routes the generic Vibes prefill without a trip', () => {
    const state = routeInbound(
      'Hi Oliday! Tell me about Vibes — travelling with verified people.',
      null
    );
    expect(state).toMatchObject({ active: true, tripId: null });
  });

  it('routes anything else to the packages agent', () => {
    expect(routeInbound('planning a Kashmir trip for 5 nights', null)).toBeNull();
    // "vibes" as casual prose must not reroute a packages chat.
    expect(routeInbound('the vibe there is great right?', null)).toBeNull();
  });

  it('is sticky once a conversation is Vibes-routed', () => {
    const existing: VibesState = {
      active: true,
      tripId: 't123456',
      fields: { name: 'Asha' },
    };
    expect(routeInbound('what about October?', existing)).toBe(existing);
  });

  it('a new tag mid-chat rebinds the trip but keeps collected fields', () => {
    const existing: VibesState = {
      active: true,
      tripId: 'oldTrip99',
      fields: { name: 'Asha', fromCity: 'Pune' },
    };
    const state = routeInbound(TAGGED, existing);
    expect(state).toMatchObject({
      active: true,
      tripId: 'a3LiCguszIxhvCa7wswx',
      fields: { name: 'Asha', fromCity: 'Pune' },
    });
  });

  it('does not reroute a conversation that switched back to packages', () => {
    const inactive: VibesState = { active: false, tripId: 't123456', fields: {} };
    expect(routeInbound('show me Kerala packages', inactive)).toBeNull();
  });
});

describe('stripVibesTag', () => {
  it('removes the machine tag from customer-facing text', () => {
    expect(stripVibesTag(TAGGED)).not.toContain('(vibes:');
    expect(stripVibesTag('Sure! (vibes:abc123def) Done.')).toBe('Sure! Done.');
  });
});

describe('mergeVibes — untrusted model output', () => {
  const base: VibesState = { active: true, tripId: null, fields: {} };

  it('merges valid fields and stage', () => {
    const next = mergeVibes(base, {
      vibeTripId: 'a3LiCguszIxhvCa7wswx',
      extractedFields: {
        name: 'Asha',
        fromCity: 'Pune',
        travelMonth: 'Sep 2026',
        groupType: 'LADIES_ONLY',
        partySize: 2,
        profileCreated: true,
      },
      stage: 'PROFILE',
    });
    expect(next.tripId).toBe('a3LiCguszIxhvCa7wswx');
    expect(next.fields).toMatchObject({
      name: 'Asha',
      fromCity: 'Pune',
      groupType: 'LADIES_ONLY',
      partySize: 2,
      profileCreated: true,
    });
    expect(next.stage).toBe('PROFILE');
  });

  it('drops malformed values and never un-fills a slot', () => {
    const filled: VibesState = {
      active: true,
      tripId: 't123456',
      fields: { name: 'Asha' },
    };
    const next = mergeVibes(filled, {
      vibeTripId: 'nope!!', // invalid chars
      extractedFields: { name: '', groupType: 'MEN_ONLY', partySize: 99 },
      stage: 'NOT_A_STAGE',
    });
    expect(next.tripId).toBe('t123456');
    expect(next.fields.name).toBe('Asha');
    expect(next.fields.groupType).toBeUndefined();
    expect(next.fields.partySize).toBeUndefined();
    expect(next.stage).toBeUndefined();
  });

  it('handoffConfirmed is sticky once true', () => {
    const confirmed = mergeVibes(base, { handoffConfirmed: true });
    const later = mergeVibes(confirmed, { handoffConfirmed: false });
    expect(later.handoffConfirmed).toBe(true);
  });
});

describe('vibesFallback', () => {
  it('always returns a sendable question with tap options', () => {
    const generic = vibesFallback({ active: true, tripId: null, fields: {} });
    expect(generic.text.length).toBeGreaterThan(0);
    expect(generic.options.length).toBeGreaterThan(0);
    const tripBound = vibesFallback({
      active: true,
      tripId: 't123456',
      fields: {},
    });
    expect(tripBound.text.length).toBeGreaterThan(0);
    expect(tripBound.options.length).toBeGreaterThan(0);
  });
});
