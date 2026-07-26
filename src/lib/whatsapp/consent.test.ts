import { describe, it, expect } from 'vitest';
import { isOptInKeyword, isOptOutKeyword } from './consent';

describe('opt-out keywords (acceptance 8)', () => {
  it('matches the promised keyword, whole-message, case-insensitively', () => {
    expect(isOptOutKeyword('STOP')).toBe(true);
    expect(isOptOutKeyword('stop')).toBe(true);
    expect(isOptOutKeyword('  Stop ')).toBe(true);
    expect(isOptOutKeyword('UNSUBSCRIBE')).toBe(true);
    expect(isOptOutKeyword('opt out')).toBe(true);
  });

  it('never fires on messages that merely contain the word', () => {
    expect(isOptOutKeyword("please don't stop the booking")).toBe(false);
    expect(isOptOutKeyword('stop sending me hotel options, show flights')).toBe(
      false
    );
    expect(isOptOutKeyword('')).toBe(false);
  });
});

describe('opt-in keywords', () => {
  it('matches START and friends', () => {
    expect(isOptInKeyword('START')).toBe(true);
    expect(isOptInKeyword('unstop')).toBe(true);
    expect(isOptInKeyword('start planning my trip')).toBe(false);
  });
});
