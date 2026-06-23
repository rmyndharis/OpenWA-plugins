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
  assert.throws(() => parseSchedule(JSON.stringify({ mon: '17:00-09:00' })), /before close/i);
  assert.throws(() => parseSchedule(JSON.stringify({ mon: null, sun: null })), /no open days/i);
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
