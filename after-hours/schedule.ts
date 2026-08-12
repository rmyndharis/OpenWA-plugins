export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export interface DayWindow {
  openMin: number;
  closeMin: number;
}
export type Schedule = Partial<Record<DayKey, DayWindow>>;

const DAYS: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
/** Intl 'short' weekday (en-US) → our key. */
const WEEKDAY_TO_KEY: Record<string, DayKey> = {
  Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat', Sun: 'sun',
};

/** "HH:MM" (2-digit) → minutes since midnight, or null if malformed. */
function parseHHMM(s: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Parse + validate a weekly schedule JSON: `{ mon..sun: "HH:MM-HH:MM" | null }`. `null`/absent = closed.
 * Throws on a non-object, an unknown day, a malformed window, `open >= close`, or no open days.
 */
export function parseSchedule(json: string): Schedule {
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('schedule must be a JSON object mapping days to windows');
  }

  const schedule: Schedule = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const day = key.toLowerCase() as DayKey;
    if (!DAYS.includes(day)) throw new Error(`schedule: unknown day "${key}"`);
    if (value === null) continue; // closed
    if (typeof value !== 'string') throw new Error(`schedule: ${day} must be "HH:MM-HH:MM" or null`);
    const m = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(value);
    const openMin = m ? parseHHMM(m[1]) : null;
    const closeMin = m ? parseHHMM(m[2]) : null;
    if (openMin === null || closeMin === null) {
      throw new Error(`schedule: ${day} window "${value}" is not "HH:MM-HH:MM"`);
    }
    // An overnight window ("22:00-06:00") and a 24-hour one ("00:00-00:00") are both ordinary business
    // hours; rejecting them made the whole schedule unparseable rather than just that day. They are
    // stored as-is and interpreted by the comparison, which already handles a wrapped window.
    if (openMin === closeMin && value.trim() !== '00:00-00:00') {
      throw new Error(`schedule: ${day} open and close are the same ("${value}") — use 00:00-00:00 for all day`);
    }
    schedule[day] = { openMin, closeMin };
  }

  if (Object.keys(schedule).length === 0) throw new Error('schedule has no open days');
  return schedule;
}

/** Throw if `tz` is not a valid IANA timezone (Intl rejects it). */
export function assertValidTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new Error(`invalid timezone "${tz}"`);
  }
}

/** True when `date` falls outside the schedule's window for its weekday in `timezone`. */
export function isAfterHours(date: Date, schedule: Schedule, timezone: string): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string): string => parts.find(p => p.type === type)?.value ?? '';
  const day = WEEKDAY_TO_KEY[get('weekday')];
  const minutes = (Number(get('hour')) % 24) * 60 + Number(get('minute'));
  const window = day ? schedule[day] : undefined;
  if (!window) return true; // closed day (or an unmapped weekday — treat as closed)
  // "00:00-00:00" means open all day.
  if (window.openMin === window.closeMin) return false;
  // A normal window opens and closes on the same day; a wrapped one ("22:00-06:00") opens in the
  // evening and closes the next morning, so "inside" is late OR early rather than between.
  if (window.openMin < window.closeMin) return minutes < window.openMin || minutes >= window.closeMin;
  return minutes < window.openMin && minutes >= window.closeMin;
}
