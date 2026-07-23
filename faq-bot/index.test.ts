import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from './index.ts';
import { allowCooldown as allowFallback } from './cooldown.ts';

const rules = JSON.stringify([{ mode: 'contains', pattern: 'hi', reply: 'hello' }]);

test('parseConfig requires rules', () => {
  assert.throws(() => parseConfig({}), /rules is required/);
  assert.throws(() => parseConfig({ rules: '   ' }), /rules is required/);
});

test('parseConfig surfaces a rules error with the faq-bot prefix', () => {
  assert.throws(() => parseConfig({ rules: 'not json' }), /faq-bot: invalid rules/);
});

test('parseConfig parses rules and applies option defaults', () => {
  const { config, rules: parsed } = parseConfig({ rules });
  assert.equal(parsed.length, 1);
  assert.equal(config.fallbackReply, '');
  assert.equal(config.fallbackCooldownSec, 600);
  assert.equal(config.respondInGroups, false);
});

test('parseConfig reads provided options', () => {
  const { config } = parseConfig({ rules, fallbackReply: 'Maaf', fallbackCooldownSec: 30, respondInGroups: true });
  assert.equal(config.fallbackReply, 'Maaf');
  assert.equal(config.fallbackCooldownSec, 30);
  assert.equal(config.respondInGroups, true);
});

test('allowFallback enforces the per-chat cooldown window', () => {
  const map = new Map<string, number>();
  assert.equal(allowFallback(map, 'c1', 1000, 60000), true); // first time
  assert.equal(allowFallback(map, 'c1', 1000 + 59999, 60000), false); // within window
  assert.equal(allowFallback(map, 'c1', 1000 + 60000, 60000), true); // window elapsed
  assert.equal(allowFallback(map, 'c2', 0, 0), true); // cooldown 0 => always
  assert.equal(allowFallback(map, 'c2', 0, 0), true);
});

test('parseConfig falls back to 600 when fallbackCooldownSec is not a finite number', () => {
  const rules = JSON.stringify([{ mode: 'contains', pattern: 'hi', reply: 'hello' }]);
  assert.equal(parseConfig({ rules, fallbackCooldownSec: 'abc' }).config.fallbackCooldownSec, 600);
});

test('allowFallback caps the map at 5000 entries, dropping the oldest', () => {
  const map = new Map<string, number>();
  for (let i = 0; i < 5001; i++) allowFallback(map, `chat-${i}`, i, 60000);
  assert.equal(map.size, 5000);
  assert.equal(map.has('chat-0'), false); // oldest evicted
  assert.equal(map.has('chat-5000'), true); // newest kept
});

test('allowFallback eviction is recency-aware: re-touching a key protects it from eviction', () => {
  const map = new Map<string, number>();
  for (let i = 0; i < 5000; i++) allowFallback(map, `chat-${i}`, i, 0);
  allowFallback(map, 'chat-0', 10000, 0); // re-touch -> most recently used
  allowFallback(map, 'chat-new', 10001, 0); // overflow -> evict genuinely-oldest
  assert.equal(map.size, 5000);
  assert.equal(map.has('chat-0'), true); // protected by recent touch
  assert.equal(map.has('chat-1'), false); // now the oldest, evicted
});

// Regression: the message hook must re-read ctx.config per event (not a snapshot cached at enable) so a
// per-session override resolved by the host for the firing session is honored. We prove it by corrupting
// the config post-enable and asserting the hook warns + skips (a cached snapshot would hold the valid
// enable-time value and try to match rules that no longer exist).
test('onMessage re-reads ctx.config per event (per-session config is not cached at enable)', async () => {
  let liveConfig: Record<string, unknown> = { rules: JSON.stringify([{ mode: 'contains', pattern: 'hi', reply: 'hello' }]) };
  const warnings: string[] = [];
  let registered = false;
  let handler: (hook: any) => Promise<void> = async () => {}; // default no-op; overwritten on registerHook
  const ctx: any = {
    get config() { return liveConfig; }, // simulate the host's per-session getter
    logger: { log() {}, debug() {}, warn: (m: string) => warnings.push(m), error() {} },
    registerHook: (_e: string, h: any) => { handler = h; registered = true; },
    messages: { reply: async () => ({ messageId: '', timestamp: 0 }), sendText: async () => ({ messageId: '', timestamp: 0 }) },
  };
  const { default: FaqBot } = await import('./index.ts');
  const plugin = new FaqBot();
  await plugin.onEnable(ctx);
  assert.ok(registered, 'hook registered');

  // Corrupt the config AFTER enable. A snapshot cached at enable would not see this; a per-event read does.
  liveConfig = { rules: 'NOT JSON' };
  await handler({ source: 'Engine', sessionId: 's1', timestamp: new Date(),
    data: { id: 'm1', chatId: 'c@x', body: 'hi', fromMe: false, isGroup: false } });
  assert.ok(warnings.some(w => /config invalid/.test(w)), 'corrupted post-enable config was re-read and warned');
});
