import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from './index.ts';
import { allowCooldown as allowReply } from './cooldown.ts';

const schedule = JSON.stringify({ mon: '09:00-17:00', sun: null });

// Minimal ctx builder shared by the two tests below. The file's regression/throttle tests further down
// build their own inline ctx (they need a live `config` getter or attempt-counting), so this one only
// needs static overrides.
function makeCtx(overrides: {
  config?: Record<string, unknown>;
  registerHook?: (event: string, handler: unknown, priority?: number) => void;
  reply?: (sessionId: string, chatId: string, quoted: string, text: string) => Promise<{ messageId: string; timestamp: number }>;
} = {}) {
  return {
    config: overrides.config ?? {},
    logger: { log() {}, debug() {}, warn() {}, error() {} },
    registerHook: overrides.registerHook ?? (() => {}),
    messages: {
      reply: overrides.reply ?? (async () => ({ messageId: 'x', timestamp: 0 })),
      sendText: async () => ({ messageId: 'x', timestamp: 0 }),
    },
  };
}

// Schedule opens only Thursday 09:00-17:00 UTC; runHook() below pins the clock to a Thursday well before
// that window opens (same construction as "a failed away reply is throttled" further down), so
// isAfterHours is deterministically true regardless of when the suite runs.
const closedNowConfig = {
  schedule: JSON.stringify({ thu: '09:00-17:00' }),
  timezone: 'UTC',
  awayMessage: 'tutup',
  cooldownSec: 3600,
};

// Enables a plugin per distinct config object and fires message:received carrying `body`, returning the
// {continue} result the host would see. Reuses the SAME plugin instance (and its cooldown/backoff state)
// across calls that pass the identical config reference — a fresh instance per call would reset the
// cooldown map and hide the very suppression the cooldown test exists to prove; a real host likewise
// keeps one plugin instance alive across messages for an enabled session.
const sessions = new WeakMap<object, (hook: unknown) => Promise<{ continue: boolean }>>();

async function runHook(config: Record<string, unknown>, body: string) {
  let handler = sessions.get(config);
  if (!handler) {
    const ctx = makeCtx({ config, registerHook: (_e, h) => { handler = h as (hook: unknown) => Promise<{ continue: boolean }>; } });
    const { default: AfterHours } = await import('./index.ts');
    await new AfterHours().onEnable(ctx as never);
    sessions.set(config, handler!);
  }
  return handler!({
    source: 'Engine', sessionId: 's1', timestamp: new Date(),
    data: { id: 'm1', chatId: 'c@x', body, fromMe: false, isGroup: false },
  });
}

// Responder band, last (PLUGIN-STANDARD.md "Co-installation"): the away message is the catch-all that
// speaks only when nothing more specific answered.
test('registers at the after-hours responder priority', async () => {
  let priority: number | undefined;
  const ctx = makeCtx({ config: { schedule, awayMessage: 'Closed' }, registerHook: (_e, _h, p) => { priority = p; } });
  const { default: AfterHours } = await import('./index.ts');
  await new AfterHours().onEnable(ctx as never);
  assert.equal(priority, 95);
});

test('claims only when it actually replied; a cooldown-suppressed message is passed on', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  try {
    const first = await runHook(closedNowConfig, 'anybody there');
    assert.equal(first.continue, false, 'the away message went out — claim it');

    const second = await runHook(closedNowConfig, 'hello again'); // same chat, inside the cooldown
    assert.equal(second.continue, true, 'nothing was sent, so nothing was claimed');
  } finally {
    mock.timers.reset();
  }
});

// A send that throws delivers nothing. Claiming it anyway would silence the chat entirely — every later
// plugin sees a message that was "handled" when in fact no away message ever reached the contact.
test('a reply that throws does not claim the message', async () => {
  let handler: ((hook: unknown) => Promise<{ continue: boolean }>) | undefined;
  const ctx = makeCtx({
    config: closedNowConfig,
    registerHook: (_e, h) => { handler = h as (hook: unknown) => Promise<{ continue: boolean }>; },
    reply: async () => { throw new Error('blocked by plugin'); },
  });
  const { default: AfterHours } = await import('./index.ts');
  await new AfterHours().onEnable(ctx as never);
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  try {
    const result = await handler!({
      source: 'Engine', sessionId: 's1', timestamp: new Date(),
      data: { id: 'm1', chatId: 'c@x', body: 'anybody there', fromMe: false, isGroup: false },
    });
    assert.equal(result.continue, true, 'the send failed — a later plugin may still have an answer');
  } finally {
    mock.timers.reset();
  }
});

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

// Drives the PLUGIN, not a re-implementation. A failed reply must not silence the chat for the whole
// cooldown, and must not remove the throttle either: clearing it outright turned a permanently-blocked
// send (a compliance plugin vetoing message:sending) into one send attempt per inbound message.
test('a failed away reply is throttled, not retried on every message', async () => {
  const AfterHours = (await import('./index.ts')).default;
  const attempts: string[] = [];
  let handler: ((h: unknown) => Promise<unknown>) | undefined;
  const ctx = {
    // Open for one minute starting two minutes from now (UTC), every day — so "now" is deterministically
    // outside business hours whatever time the suite runs at, without needing to inject a clock.
    // The clock is mocked to a fixed instant below (a Thursday, 00:16 UTC), so this window is
    // deterministically closed — no dependence on when the suite happens to run.
    config: { schedule: JSON.stringify({ thu: '09:00-17:00' }), timezone: 'UTC',
              awayMessage: 'tutup', cooldownSec: 3600 },
    logger: { log() {}, debug() {}, warn() {}, error() {} },
    messages: {
      sendText: async () => ({ messageId: 'x', timestamp: 0 }),
      reply: async () => { attempts.push('try'); throw new Error('blocked by plugin'); },
    },
    registerHook: (_e: string, h: (x: unknown) => Promise<unknown>) => { handler = h; },
  } as never;

  const plugin = new AfterHours();
  await plugin.onEnable(ctx);
  const fire = (id: string) =>
    handler!({ source: 'Engine', sessionId: 's1', data: { id, chatId: 'c@wa', body: 'halo', fromMe: false } });

  // Fake the clock so the backoff window is observable. cooldownSec is 3600, so anything that retries
  // within the hour can only be the failure backoff — not the normal cooldown expiring.
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  try {
    await fire('m1');
    assert.equal(attempts.length, 1, 'first message attempts a reply');

    await fire('m2');
    await fire('m3');
    assert.equal(attempts.length, 1, 'a failing send must not be retried on every inbound message');

    mock.timers.tick(30_000);
    await fire('m4');
    assert.equal(attempts.length, 1, 'still inside the backoff window');

    mock.timers.tick(31_000); // now past 60 s since the failure
    await fire('m5');
    assert.equal(attempts.length, 2, 'after the backoff the reply is attempted again, well inside cooldownSec');
  } finally {
    mock.timers.reset();
  }
});

// Regression: the backoff must not be expressible in terms of the CURRENT cooldown. Encoding it as a
// rewound cooldown timestamp meant an operator lowering cooldownSec in the dashboard — config is re-read
// per message — turned the stored value into "long past" and handed back the un-throttled retry storm.
test('a blank cooldownSec falls back to the default instead of disabling the throttle', () => {
  // `Number('')` is 0, and 0 is the documented "reply every time" value, so a blank field silently
  // turned the per-chat throttle off rather than defaulting to 3600.
  const base = { schedule, awayMessage: 'closed' };
  assert.equal(parseConfig({ ...base }).config.cooldownSec, 3600, 'absent means default');
  assert.equal(parseConfig({ ...base, cooldownSec: '' }).config.cooldownSec, 3600, 'empty means default');
  assert.equal(parseConfig({ ...base, cooldownSec: '   ' }).config.cooldownSec, 3600, 'blank means default');
  // An explicit 0 is a real setting and must still disable the throttle.
  assert.equal(parseConfig({ ...base, cooldownSec: 0 }).config.cooldownSec, 0, 'explicit 0 is honoured');
  assert.equal(parseConfig({ ...base, cooldownSec: '0' }).config.cooldownSec, 0, 'explicit "0" is honoured');
  assert.equal(parseConfig({ ...base, cooldownSec: 60 }).config.cooldownSec, 60);
});

test('healthCheck turns unhealthy when the live config stops parsing', async () => {
  // The host reports a plugin with no healthCheck as healthy, so a config edit that fails validation
  // after enable would leave the dashboard green while the plugin answered nothing at all.
  const { default: AfterHours } = await import('./index.ts');
  let live: Record<string, unknown> = { schedule, awayMessage: 'closed', timezone: 'Asia/Jakarta' };
  const ctx = {
    get config() {
      return live;
    },
    logger: { log() {}, debug() {}, warn() {}, error() {} },
    messages: { reply: async () => ({ messageId: 'x', timestamp: 0 }) },
    registerHook: () => {},
  } as never;

  const plugin = new AfterHours();
  assert.equal((await plugin.healthCheck()).healthy, false, 'not enabled yet');

  await plugin.onEnable(ctx);
  const ok = await plugin.healthCheck();
  assert.equal(ok.healthy, true);
  assert.match(ok.message ?? '', /Asia\/Jakarta/);

  live = { schedule: '{ not json', awayMessage: 'closed' };
  assert.equal((await plugin.healthCheck()).healthy, false, 'a config edit that stops parsing is surfaced');
});

test('lowering cooldownSec mid-backoff does not release the retry storm', async () => {
  const attempts: string[] = [];
  let handler: ((h: unknown) => Promise<unknown>) | undefined;
  const cfg: Record<string, unknown> = {
    schedule: JSON.stringify({ thu: '09:00-17:00' }), timezone: 'UTC',
    awayMessage: 'tutup', cooldownSec: 3600,
  };
  const ctx = {
    get config() { return cfg; },
    logger: { log() {}, debug() {}, warn() {}, error() {} },
    messages: {
      sendText: async () => ({ messageId: 'x', timestamp: 0 }),
      reply: async () => { attempts.push('try'); throw new Error('vetoed'); },
    },
    registerHook: (_e: string, h: (x: unknown) => Promise<unknown>) => { handler = h; },
  } as never;

  const AfterHours = (await import('./index.ts')).default;
  const plugin = new AfterHours();
  await plugin.onEnable(ctx);
  const fire = (id: string) =>
    handler!({ source: 'Engine', sessionId: 's1', data: { id, chatId: 'c@wa', body: 'halo', fromMe: false } });

  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  try {
    await fire('m1');
    assert.equal(attempts.length, 1);
    cfg.cooldownSec = 1;              // operator lowers it while the backoff is still running
    mock.timers.tick(5_000);
    await fire('m2');
    assert.equal(attempts.length, 1, 'the failure backoff must survive a live cooldown change');
    mock.timers.tick(56_000);         // now past 60 s since the failure
    await fire('m3');
    assert.equal(attempts.length, 2, 'and it must still expire on time');
  } finally {
    mock.timers.reset();
  }
});

test('a channel or broadcast post never draws an away reply', async () => {
  // A `@newsletter` post arrives flagged as a non-group chat, so the group gate lets it through and the
  // plugin replied into a channel the account merely follows: a send that always fails, one per post,
  // after consuming that chat's cooldown slot.
  const replies: string[] = [];
  let handler: ((hook: unknown) => Promise<{ continue: boolean }>) | undefined;
  const ctx = makeCtx({
    config: closedNowConfig,
    registerHook: (_e, h) => { handler = h as (hook: unknown) => Promise<{ continue: boolean }>; },
    reply: async (_s: string, chatId: string) => { replies.push(chatId); return { messageId: 'x', timestamp: 0 }; },
  });
  const { default: AfterHours } = await import('./index.ts');
  await new AfterHours().onEnable(ctx as never);

  const fire = (chatId: string) =>
    handler!({
      source: 'Engine', sessionId: 's1', timestamp: new Date(),
      data: { id: `m-${chatId}`, chatId, body: 'hello', fromMe: false, isGroup: false },
    });

  for (const chatId of ['120363000000000000@newsletter', '628123-456@broadcast', 'status@broadcast']) {
    assert.deepEqual(await fire(chatId), { continue: true }, `${chatId} must not be claimed`);
  }
  assert.deepEqual(replies, [], 'nothing may be sent into a channel or broadcast chat');

  // Guard rail: a real 1:1 chat under the same closed schedule still gets the away message, so the
  // test above proves the gate rather than a broken fixture.
  await fire('628123456789@c.us');
  assert.deepEqual(replies, ['628123456789@c.us']);
});
