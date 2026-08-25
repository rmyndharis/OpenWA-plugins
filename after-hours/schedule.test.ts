import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSchedule, assertValidTimezone, isAfterHours } from './schedule.ts';

// Mon–Fri 09:00–17:00, Sat 09:00–13:00, Sun closed.
const sched = parseSchedule(
  JSON.stringify({
    mon: '09:00-17:00', tue: '09:00-17:00', wed: '09:00-17:00', thu: '09:00-17:00',
    fri: '09:00-17:00', sat: '09:00-13:00', sun: null,
  }),
);

test('parseSchedule rejects bad input', () => {
  assert.throws(() => parseSchedule('not json'));
  assert.throws(() => parseSchedule('[]'), /object/i);
  assert.throws(() => parseSchedule(JSON.stringify({ xyz: '09:00-17:00' })), /unknown day/i);
  assert.throws(() => parseSchedule(JSON.stringify({ mon: '9:00-17:00' })), /HH:MM/i);
  assert.throws(() => parseSchedule(JSON.stringify({ mon: null, sun: null })), /no open days/i);
  assert.throws(() => parseSchedule(JSON.stringify({ mon: '09:00-17:00-junk' })), /HH:MM/i);
});

test('parseSchedule yields minute windows and treats null/absent as closed', () => {
  assert.deepEqual(sched.mon, { openMin: 540, closeMin: 1020 });
  assert.deepEqual(sched.sat, { openMin: 540, closeMin: 780 });
  assert.equal(sched.sun, undefined);
});

test('assertValidTimezone throws only on an unknown timezone', () => {
  assert.doesNotThrow(() => assertValidTimezone('Asia/Jakarta'));
  assert.doesNotThrow(() => assertValidTimezone('UTC'));
  assert.throws(() => assertValidTimezone('Not/AZone'), /timezone/i);
});

test('isAfterHours respects the window in the given timezone', () => {
  // 2026-06-22 is a Monday. 03:00Z = 10:00 in Jakarta (+7) → inside 09:00–17:00.
  assert.equal(isAfterHours(new Date('2026-06-22T03:00:00Z'), sched, 'Asia/Jakarta'), false);
  // 11:00Z = 18:00 Jakarta → after close.
  assert.equal(isAfterHours(new Date('2026-06-22T11:00:00Z'), sched, 'Asia/Jakarta'), true);
});

test('isAfterHours is timezone-relative (same instant, different zones)', () => {
  const instant = new Date('2026-06-22T11:00:00Z'); // Mon 11:00 UTC, Mon 18:00 Jakarta
  assert.equal(isAfterHours(instant, sched, 'UTC'), false); // 11:00 ∈ 09:00–17:00
  assert.equal(isAfterHours(instant, sched, 'Asia/Jakarta'), true); // 18:00 after close
});

test('isAfterHours: closed day and the local-midnight edge', () => {
  // 2026-06-21 is a Sunday → closed → after-hours.
  assert.equal(isAfterHours(new Date('2026-06-21T05:00:00Z'), sched, 'Asia/Jakarta'), true);
  // 2026-06-21T17:00Z = Mon 00:00 in Jakarta → local day Monday, 00:00 < 09:00 → after-hours
  // (also exercises the hour '24' → %24 normalization).
  assert.equal(isAfterHours(new Date('2026-06-21T17:00:00Z'), sched, 'Asia/Jakarta'), true);
});

test('an overnight window and an all-day window are accepted and honoured', () => {
  // "22:00-06:00" and "00:00-00:00" are ordinary business hours. The parser rejected both, which made
  // the whole schedule unparseable rather than just that day, and the comparison only understood a
  // window that opens and closes on the same date.
  const sch = parseSchedule(JSON.stringify({ mon: '22:00-06:00', wed: '00:00-00:00' }));
  // 2026-08-10 is a Monday. A window belongs to the day it OPENS on, so `mon: 22:00-06:00` runs from
  // Monday 22:00 until TUESDAY 06:00. Reading both halves out of the Monday entry made the plugin
  // silent on Monday morning, which nothing declared open, and talkative on Tuesday morning, which the
  // Monday window covers.
  const at = (d: number, h: number, m: number) => isAfterHours(new Date(Date.UTC(2026, 7, d, h, m)), sch, 'UTC');
  assert.equal(at(10, 23, 20), false, 'Monday late evening is inside the Monday window');
  assert.equal(at(11, 5, 0), false, 'Tuesday early morning is the Monday window spilling over');
  assert.equal(at(11, 6, 0), true, 'the window closes at 06:00, so Tuesday 06:00 is outside it');
  assert.equal(at(10, 5, 0), true, 'Monday morning is closed: Sunday declared no window to spill over');
  assert.equal(at(10, 10, 0), true, 'mid-morning is outside it');
  assert.equal(at(12, 3, 0), false, '00:00-00:00 is open all day');
  assert.equal(at(13, 3, 0), true, 'an all-day window ends at midnight and never spills into Thursday');
  assert.throws(() => parseSchedule(JSON.stringify({ mon: '09:00-09:00' })), /use 00:00-00:00/);
});

test('an overnight window spills across the Sunday-to-Monday week boundary', () => {
  // The previous-day lookup indexes a 7-element array, so Monday's predecessor has to wrap to Sunday
  // rather than fall off the front.
  const sch = parseSchedule(JSON.stringify({ sun: '22:00-06:00' }));
  const at = (d: number, h: number, m: number) => isAfterHours(new Date(Date.UTC(2026, 7, d, h, m)), sch, 'UTC');
  assert.equal(at(9, 23, 0), false, 'Sunday evening is inside the Sunday window');
  assert.equal(at(10, 5, 0), false, 'Monday morning is the Sunday window spilling over');
  assert.equal(at(10, 7, 0), true, 'Monday after 06:00 is closed');
});

test('consecutive overnight windows cover the whole night, both days', () => {
  // Two wrapped windows back to back: each morning is covered by the PREVIOUS day's entry, so a
  // schedule of nothing but overnight shifts must have no closed gap at 03:00 on either day.
  const sch = parseSchedule(JSON.stringify({ mon: '22:00-06:00', tue: '22:00-06:00' }));
  const at = (d: number, h: number, m: number) => isAfterHours(new Date(Date.UTC(2026, 7, d, h, m)), sch, 'UTC');
  assert.equal(at(11, 3, 0), false, 'Tuesday 03:00 is covered by the Monday window');
  assert.equal(at(12, 3, 0), false, 'Wednesday 03:00 is covered by the Tuesday window');
  assert.equal(at(11, 12, 0), true, 'Tuesday midday sits between the two windows');
});
