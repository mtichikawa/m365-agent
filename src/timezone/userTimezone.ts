// [excerpt: was `import { TIMEZONE } from './config.js'` — server default timezone from env]
const TIMEZONE = process.env.TZ ?? 'America/New_York';

/** Per-user IANA timezone cache, populated at startup from Graph mailbox settings. */
const _userTzMap = new Map<string, string>();

/** Store the resolved IANA timezone for a specific user. */
export function setUserTimezone(userId: string, tz: string): void {
  _userTzMap.set(userId, tz);
}

/**
 * The IANA timezone for a specific user.
 * Falls back to the first stored timezone, then the server's TIMEZONE env var.
 */
export function getUserTimezone(userId?: string): string {
  if (userId) {
    const tz = _userTzMap.get(userId);
    if (tz) return tz;
  }
  // Fallback: first stored timezone (single-user or system context), then env var.
  const first = _userTzMap.values().next().value;
  return first ?? TIMEZONE;
}

/**
 * Parse a Graph dateTimeTimeZone. Without a `Prefer: outlook.timezone` header
 * Graph returns UTC with no zone suffix ("2026-10-19T16:00:00.0000000"), and
 * `new Date()` reads a zone-less string as the server's local time, which
 * shifts every event by the server's UTC offset. Throws on a non-UTC zone
 * rather than guess at it.
 */
export function parseGraphDateTime(t: { dateTime: string; timeZone?: string }): Date {
  if (/(Z|[+-]\d\d:?\d\d)$/.test(t.dateTime)) return new Date(t.dateTime);
  if (t.timeZone && t.timeZone !== 'UTC') {
    throw new Error(`Unexpected Graph timeZone "${t.timeZone}" (expected UTC)`);
  }
  return new Date(`${t.dateTime}Z`);
}

/**
 * Format a Date (or ISO string) for display in the user's timezone.
 * Returns e.g. "Wed, Apr 2, 9:00 AM"
 */
export function formatInUserTz(
  date: Date | string,
  opts: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  },
  userId?: string,
): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat('en-US', { timeZone: getUserTimezone(userId), ...opts }).format(d);
}
