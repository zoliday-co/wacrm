import { describe, it, expect } from 'vitest';
import {
  FEATURED_EVENTS,
  featuredEventLink,
  featuredEventsSection,
} from './featured';
import { buildVibesPrompt } from './vibes-prompt';
import { buildOlidayPrompt } from './prompt';

const RULE = '═══';

describe('featuredEventsSection', () => {
  it('lists every event with its full page link', () => {
    const section = featuredEventsSection(RULE);
    for (const e of FEATURED_EVENTS) {
      expect(section).toContain(e.name);
      expect(section).toContain(featuredEventLink(e));
    }
  });

  it('links Dev Deepawali 2026 to its landing page', () => {
    const dev = FEATURED_EVENTS.find((e) =>
      e.name.includes('Dev Deepawali 2026')
    );
    expect(dev).toBeDefined();
    // siteUrl() honours OLIDAY_SITE_URL, so assert the path, not the host.
    expect(featuredEventLink(dev!)).toMatch(/\/dev-deepawali-2026$/);
  });
});

describe('prompts carry the featured events', () => {
  it('the Vibes prompt refers featured-event asks to the page', () => {
    const prompt = buildVibesPrompt({
      state: { active: true, tripId: null, fields: {} },
      today: '2026-08-20',
      phone: null,
    });
    expect(prompt).toContain('FEATURED EVENT TRIPS');
    expect(prompt).toContain('/dev-deepawali-2026');
  });

  it('the packages prompt refers featured-event asks to the page', () => {
    const prompt = buildOlidayPrompt({
      trip: {},
      today: '2026-08-20',
      entryContext: null,
      adHeadline: null,
      phone: null,
      shownPackages: [],
    });
    expect(prompt).toContain('FEATURED EVENT TRIPS');
    expect(prompt).toContain('/dev-deepawali-2026');
  });
});
