import { describe, it, expect } from 'vitest';
import { detectEntryContext, parseDealLink, tripFromDealLink } from './entry';

const DEAL_TEXT =
  'Hi Oliday! I\'m interested in the "Andaman Island Escape" deal (5N/6D, Andaman). Can you help?';

describe('parseDealLink', () => {
  it('parses the deal deep link (acceptance 1)', () => {
    expect(parseDealLink(DEAL_TEXT)).toEqual({
      title: 'Andaman Island Escape',
      nights: 5,
      days: 6,
      destination: 'Andaman',
    });
  });

  it('handles smart quotes from mobile keyboards', () => {
    const smart =
      'Hi Oliday! I’m interested in the “Kashmir Delight” deal (5N/6D, Kashmir). Can you help?';
    expect(parseDealLink(smart)).toMatchObject({ title: 'Kashmir Delight' });
  });

  it('returns null for ordinary messages', () => {
    expect(parseDealLink('hi, planning a trip to goa')).toBeNull();
  });
});

describe('tripFromDealLink', () => {
  it('pre-fills destination + nights so the bot never re-asks them', () => {
    const trip = tripFromDealLink(parseDealLink(DEAL_TEXT)!);
    expect(trip).toEqual({
      destination: 'Andaman',
      region: 'Andaman',
      nights: 5,
    });
  });
});

describe('detectEntryContext', () => {
  it('classifies the four §6 contexts', () => {
    expect(detectEntryContext(DEAL_TEXT, undefined)).toBe('deal_link');
    expect(
      detectEntryContext(
        'Hi Oliday! I have a question about planning a trip.',
        undefined
      )
    ).toBe('site_cta');
    expect(
      detectEntryContext('anything', { source_id: '123', headline: 'Andaman!' })
    ).toBe('ad');
    expect(detectEntryContext('hello', undefined)).toBe('cold');
  });

  it('referral wins over text (an ad click may carry any prefill)', () => {
    expect(detectEntryContext(DEAL_TEXT, { ctwa_clid: 'x' })).toBe('ad');
  });
});
