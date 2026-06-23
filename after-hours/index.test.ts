import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, allowReply } from './index.ts';

const schedule = JSON.stringify({ mon: '09:00-17:00', sun: null });

test('parseConfig requires schedule and awayMessage', () => {
  assert.throws(() => parseConfig({ awayMessage: 'x' }), /schedule is required/);
  assert.throws(() => parseConfig({ schedule, awayMessage: '' }), /awayMessage is required/);
});

test('parseConfig surfaces a schedule error and an invalid timezone', () => {
  assert.throws(() => parseConfig({ schedule: 'not json', awayMessage: 'x' }), /after-hours: invalid schedule/);
  assert.throws(() => parseConfig({ schedule, awayMessage: 'x', timezone: 'Not/AZone' }), /timezone/i);
});

test('parseConfig applies defaults and reads options', () => {
  const a = parseConfig({ schedule, awayMessage: 'Closed' });
  assert.equal(a.config.timezone, 'UTC');
  assert.equal(a.config.cooldownSec, 3600);
  assert.equal(a.config.respondInGroups, false);
  assert.deepEqual(a.schedule.mon, { openMin: 540, closeMin: 1020 });

  const b = parseConfig({ schedule, awayMessage: 'Closed', timezone: 'Asia/Jakarta', cooldownSec: 30, respondInGroups: true });
  assert.equal(b.config.timezone, 'Asia/Jakarta');
  assert.equal(b.config.cooldownSec, 30);
  assert.equal(b.config.respondInGroups, true);
});

test('parseConfig falls back to 3600 when cooldownSec is not a finite number', () => {
  assert.equal(parseConfig({ schedule, awayMessage: 'x', cooldownSec: 'abc' }).config.cooldownSec, 3600);
});

test('allowReply enforces the per-chat cooldown and caps the map', () => {
  const map = new Map<string, number>();
  assert.equal(allowReply(map, 'c1', 1000, 60000), true);
  assert.equal(allowReply(map, 'c1', 1000 + 59999, 60000), false);
  assert.equal(allowReply(map, 'c1', 1000 + 60000, 60000), true);
  assert.equal(allowReply(map, 'c2', 0, 0), true);
  assert.equal(allowReply(map, 'c2', 0, 0), true);

  const big = new Map<string, number>();
  for (let i = 0; i < 5001; i++) allowReply(big, `k-${i}`, i, 60000);
  assert.equal(big.size, 5000);
  assert.equal(big.has('k-0'), false);
});

test('allowReply eviction is recency-aware: re-touching a key protects it', () => {
  const map = new Map<string, number>();
  for (let i = 0; i < 5000; i++) allowReply(map, `k-${i}`, i, 0);
  allowReply(map, 'k-0', 10000, 0); // re-touch -> most recently used
  allowReply(map, 'k-new', 10001, 0); // overflow -> evict genuinely-oldest
  assert.equal(map.size, 5000);
  assert.equal(map.has('k-0'), true); // protected by recent touch
  assert.equal(map.has('k-1'), false); // now the oldest, evicted
});
