/**
 * Asserts parseRemindAt always returns UTC ISO strings, regardless of
 * input format. Reminders are stored in UTC and fired by comparing with
 * Postgres NOW(), also UTC; consistency keeps DST transitions
 * correct (a "remind me in 8 hours" call that crosses a DST boundary
 * still fires 8 elapsed hours later, not 7 or 9).
 */

import { describe, it, expect } from 'vitest';
import { parseRemindAt } from './parseRemindAt.js';
import { setUserTimezone } from './userTimezone.js';
import { _requestContext } from './requestContext.js';

describe('parseRemindAt — UTC consistency', () => {
  it('returns a valid ISO 8601 UTC string for "in 1 hour"', () => {
    const out = parseRemindAt('in 1 hour');
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const delta = new Date(out).getTime() - Date.now();
    expect(delta).toBeGreaterThan(59 * 60_000);
    expect(delta).toBeLessThan(61 * 60_000);
  });

  it('returns a valid ISO UTC string for "in 30 minutes"', () => {
    const out = parseRemindAt('in 30 minutes');
    expect(out).toMatch(/Z$/);
    const delta = new Date(out).getTime() - Date.now();
    expect(delta).toBeGreaterThan(29 * 60_000);
    expect(delta).toBeLessThan(31 * 60_000);
  });

  it('returns a valid ISO UTC string for "in 2 days"', () => {
    const out = parseRemindAt('in 2 days');
    expect(out).toMatch(/Z$/);
    const deltaH = (new Date(out).getTime() - Date.now()) / 3_600_000;
    // 2 days = 48 hours, allow ±1 hour for DST transition during the window
    expect(deltaH).toBeGreaterThan(47);
    expect(deltaH).toBeLessThan(49);
  });

  it('a "Z" ISO is interpreted as the user local wall-clock, NOT honored as UTC (bulletproof #24)', () => {
    // The model's timezone math is not trusted: any Z/offset is stripped and the
    // wall-clock re-applied in the user's zone. Here the user zone IS UTC, so
    // 14:30 maps back to 14:30Z.
    setUserTimezone('u-utc-zone', 'UTC');
    _requestContext.run({ userId: 'u-utc-zone', tenantId: 't' }, () => {
      expect(parseRemindAt('2026-12-15T14:30:00.000Z')).toBe('2026-12-15T14:30:00.000Z');
    });
  });

  it('preserves the date when given a no-time ISO ("just the date")', () => {
    const out = parseRemindAt('2026-06-15');
    expect(out.startsWith('2026-06-15')).toBe(true);
    expect(out).toMatch(/Z$/);
  });
});

// Found in Teams Store certification review: a time is the user's LOCAL
// wall-clock and must be converted with their timezone — not stored as UTC. Before the fix, "8 AM" for an IST (+5:30)
// user was stored as 08:00Z = 1:30 PM IST.
describe('parseRemindAt — user-timezone', () => {
  it('interprets a naive local ISO in the user timezone (IST 8am -> 02:30Z)', () => {
    setUserTimezone('u-ist', 'Asia/Kolkata'); // +5:30
    _requestContext.run({ userId: 'u-ist', tenantId: 't' }, () => {
      expect(parseRemindAt('2026-06-15T08:00')).toBe('2026-06-15T02:30:00.000Z');
    });
  });

  it('strips a "Z"/offset and interprets it as the user LOCAL time (model UTC math not trusted)', () => {
    setUserTimezone('u-ist2', 'Asia/Kolkata');
    _requestContext.run({ userId: 'u-ist2', tenantId: 't' }, () => {
      // Model handed back 08:00 with a "Z"; we strip it and read 08:00 as IST.
      expect(parseRemindAt('2026-06-15T08:00:00.000Z')).toBe('2026-06-15T02:30:00.000Z');
    });
  });

  it('interprets a bare "8am" in the user timezone (renders back to 8am IST)', () => {
    setUserTimezone('u-ist3', 'Asia/Kolkata');
    _requestContext.run({ userId: 'u-ist3', tenantId: 't' }, () => {
      const out = parseRemindAt('8am');
      const hourIst = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false,
      }).format(new Date(out));
      expect(hourIst).toBe('08');
    });
  });
});
