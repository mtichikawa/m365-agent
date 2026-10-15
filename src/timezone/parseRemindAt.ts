// [excerpt: from src/agent/tools-utils.ts — the two functions below, verbatim]
import { getUserTimezone } from './userTimezone.js';
import { getContextUserId } from './requestContext.js';

/**
 * Convert a wall-clock date/time (year, month 1-12, day, hour 0-23, minute) in an
 * IANA timezone to a UTC ISO 8601 string.
 *
 * Uses Intl to measure the actual UTC offset at that moment, so DST transitions
 * are handled correctly without any external library.
 */
export function wallClockToUTC(year: number, month: number, day: number, hour: number, minute: number, tz: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  // Approximate UTC anchor (off by at most the UTC offset, typically ≤14h).
  const approx = new Date(`${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00Z`);
  // Ask Intl what wall-clock time that UTC instant shows in the target timezone.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false,
  }).formatToParts(approx);
  const get = (type: string) => parseInt(parts.find((p) => p.type === type)!.value, 10);
  // Reconstruct what the local clock showed as a UTC epoch.
  const shownMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  // The difference is the offset; correcting gives the true UTC instant.
  return new Date(approx.getTime() + (approx.getTime() - shownMs)).toISOString();
}

/**
 * Parse a relative time expression into an absolute ISO datetime.
 * Supports: "in X hours/minutes/days", "tomorrow at 9am", ISO 8601
 */
export function parseRemindAt(input: string): string {
  const trimmed = input.trim();
  const tz = getUserTimezone(getContextUserId());

  // ANY explicit date+time — naive, or with a "Z"/offset — is interpreted as
  // the user's LOCAL wall-clock, converted with their timezone. We deliberately
  // STRIP any Z/offset the model added: for a personal reminder the user always
  // means their local time ("8 AM" = 8 AM in their zone), and the model is an
  // unreliable UTC converter. This is model-proof — it does NOT depend on the
  // model following "don't add Z" (found in Teams Store certification review). The only
  // absolute path is the relative "in X" case below (elapsed time).
  const dt = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/i,
  );
  if (dt) {
    return wallClockToUTC(+dt[1], +dt[2], +dt[3], +dt[4], +dt[5], tz);
  }

  const now = new Date();

  // "in X hours/minutes/days"
  const relativeMatch = trimmed.match(
    /^in\s+(\d+)\s+(minute|minutes|min|mins|hour|hours|hr|hrs|day|days)$/i,
  );
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2].toLowerCase();
    if (unit.startsWith('min')) {
      now.setMinutes(now.getMinutes() + amount);
    } else if (unit.startsWith('h')) {
      now.setHours(now.getHours() + amount);
    } else if (unit.startsWith('d')) {
      now.setDate(now.getDate() + amount);
    }
    return now.toISOString();
  }

  // "tomorrow at 9am" or "tomorrow at 14:00"
  const tomorrowMatch = trimmed.match(
    /^tomorrow\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i,
  );
  if (tomorrowMatch) {
    let hours = parseInt(tomorrowMatch[1], 10);
    const minutes = tomorrowMatch[2] ? parseInt(tomorrowMatch[2], 10) : 0;
    const meridiem = tomorrowMatch[3]?.toLowerCase();
    if (meridiem === 'pm' && hours < 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;
    // Get tomorrow's YYYY-MM-DD in the user's timezone.
    const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
    const [y, mo, d] = todayStr.split('-').map(Number);
    // Advance by 1 day (UTC midnight arithmetic is fine here — we only need the date).
    const tomorrowStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(Date.UTC(y, mo - 1, d + 1)));
    const [ty, tmo, td] = tomorrowStr.split('-').map(Number);
    return wallClockToUTC(ty, tmo, td, hours, minutes, tz);
  }

  // Time-of-day today: "today at 9am", "at 9am", "9am", "9:30 pm", "14:00".
  // Interpreted in the user's timezone. Require am/pm, a colon, or
  // a today/at prefix so we don't grab a bare stray number.
  const timeMatch = trimmed.match(
    /^(?:today\s+at\s+|at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i,
  );
  if (
    timeMatch &&
    (timeMatch[3] || timeMatch[2] != null || /^(?:today\s+at|at)\s/i.test(trimmed))
  ) {
    let hours = parseInt(timeMatch[1], 10);
    const minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const meridiem = timeMatch[3]?.toLowerCase();
    if (meridiem === 'pm' && hours < 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;
    const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
    const [y, mo, d] = todayStr.split('-').map(Number);
    return wallClockToUTC(y, mo, d, hours, minutes, tz);
  }

  // Fallback: anything else Date can parse, taken as-is. Not timezone-aware:
  // a bare date ("2026-06-15") becomes UTC midnight (a known gap; see ROADMAP).
  const fallback = new Date(trimmed);
  if (!isNaN(fallback.getTime())) {
    return fallback.toISOString();
  }

  throw new Error(
    `Could not parse reminder time: "${input}". Use "today/tomorrow at 9am", "in X hours/minutes", or a local ISO time (YYYY-MM-DDThh:mm).`,
  );
}
