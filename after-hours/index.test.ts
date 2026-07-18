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

// Regression: the message hook must re-read ctx.config per event (not a snapshot cached at enable) so a
// per-session override resolved by the host for the firing session is honored. Mutating the config AFTER
// enable must be visible to the next hook fire. We prove it by corrupting the config post-enable and
// asserting the hook warns + skips (a cached snapshot would still hold the valid enable-time value).
test('onMessage re-reads ctx.config per event (per-session config is not cached at enable)', async () => {
  // Use a schedule whose window never covers the current wall-clock minute, so any message is after-hours.
  const alwaysClosed = JSON.stringify({ mon: '00:00-00:01', tue: '00:00-00:01', wed: '00:00-00:01', thu: '00:00-00:01', fri: '00:00-00:01', sat: '00:00-00:01', sun: '00:00-00:01' });
  let liveConfig: Record<string, unknown> = { schedule: alwaysClosed, awayMessage: 'Closed', cooldownSec: 0 };
  const warnings: string[] = [];
  let registered = false;
  let handler: (hook: any) => Promise<void> = async () => {}; // default no-op; overwritten on registerHook
  const ctx: any = {
    get config() { return liveConfig; }, // simulate the host's per-session getter
    logger: { log() {}, debug() {}, warn: (m: string) => warnings.push(m), error() {} },
    registerHook: (_e: string, h: any) => { handler = h; registered = true; },
    messages: { reply: async () => ({ messageId: '', timestamp: 0 }), sendText: async () => ({ messageId: '', timestamp: 0 }) },
  };
  const { default: AfterHours } = await import('./index.ts');
  const plugin = new AfterHours();
  await plugin.onEnable(ctx);
  assert.ok(registered, 'hook registered');

  // Corrupt the config AFTER enable. A snapshot cached at enable would not see this; a per-event read does.
  liveConfig = { schedule: 'NOT JSON', awayMessage: 'x' };
  await handler({ source: 'Engine', sessionId: 's1', timestamp: new Date(),
    data: { id: 'm1', chatId: 'c@x', body: 'hi', fromMe: false, isGroup: false } });
  assert.ok(warnings.some(w => /config invalid/.test(w)), 'corrupted post-enable config was re-read and warned');
});
