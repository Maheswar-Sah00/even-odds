import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, formatRemaining } from '../../src/lib/format.ts';

describe('date formatting', () => {
  it('formats a datetime in a program timezone with the zone name (regression: Intl "Invalid option")', () => {
    expect(formatDateTime('2027-01-10T14:00:00.000Z', 'America/New_York')).toBe('Jan 10, 2027, 9:00 AM EST');
    expect(() => formatDateTime('2027-01-10T14:00:00.000Z')).not.toThrow();
  });

  it('formats a date-only value without shifting the day', () => {
    expect(formatDate('2018-12-10T00:00:00.000Z')).toBe('Dec 10, 2018');
  });
});

describe('countdown formatting', () => {
  it('rounds down to the largest two units', () => {
    expect(formatRemaining(48 * 3600_000)).toBe('2 days');
    expect(formatRemaining(27 * 3600_000 + 5 * 60_000)).toBe('1 day 3 hours');
    expect(formatRemaining(61 * 60_000)).toBe('1 hour 1 minute');
    expect(formatRemaining(45 * 60_000 + 59_000)).toBe('45 minutes');
    expect(formatRemaining(30_000)).toBe('under a minute');
    expect(formatRemaining(0)).toBe('no time');
  });
});
