import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, toFlowNodes } from './index.ts';

test('parseConfig requires greeting and at least one option', () => {
  assert.throws(() => parseConfig({ options: [{ key: '1', text: 'a' }] }), /greeting is required/);
  assert.throws(() => parseConfig({ greeting: 'hi' }), /at least one menu option/);
  assert.throws(() => parseConfig({ greeting: 'hi', options: [] }), /at least one menu option/);
});

test('parseConfig builds the flow and defaults', () => {
  const c = parseConfig({ greeting: 'menu', options: [{ key: '1', text: 'A' }] });
  assert.equal(c.flow.trigger, '');
  assert.equal(c.flow.greeting, 'menu');
  assert.deepEqual(c.flow.options, { '1': { text: 'A', options: undefined } });
  assert.equal(c.respondInGroups, false);

  const c2 = parseConfig({ greeting: 'menu', trigger: 'hi', respondInGroups: true, options: [{ key: '1', text: 'A' }] });
  assert.equal(c2.flow.trigger, 'hi');
  assert.equal(c2.respondInGroups, true);
});

test('toFlowNodes nests recursively and rejects bad nodes', () => {
  const nodes = toFlowNodes([{ key: '1', text: 'A', options: [{ key: '1', text: 'A1' }] }]);
  assert.deepEqual(nodes, { '1': { text: 'A', options: { '1': { text: 'A1', options: undefined } } } });
  assert.equal(toFlowNodes([]), undefined);
  assert.equal(toFlowNodes('x'), undefined);
  assert.throws(() => toFlowNodes([{ key: '', text: 'A' }]), /non-empty "key"/);
  assert.throws(() => toFlowNodes([{ key: '1', text: '' }]), /needs "text"/);
  assert.throws(() => toFlowNodes([{ key: '1', text: 'A' }, { key: '1', text: 'B' }]), /duplicate option key/);
});

test('toFlowNodes accepts keys that collide with Object.prototype names, but rejects __proto__', () => {
  const nodes = toFlowNodes([{ key: 'toString', text: 'A' }, { key: 'constructor', text: 'B' }]);
  assert.equal(nodes!['toString'].text, 'A'); // no spurious "duplicate" on the first use
  assert.equal(nodes!['constructor'].text, 'B');
  // a genuine duplicate of such a key still throws
  assert.throws(() => toFlowNodes([{ key: 'toString', text: 'A' }, { key: 'toString', text: 'B' }]), /duplicate option key/);
  // __proto__ would set the prototype rather than an own key — reject it outright
  assert.throws(() => toFlowNodes([{ key: '__proto__', text: 'A' }]), /not allowed/);
});

// Regression: the message hook must re-read ctx.config per event (not a snapshot cached at enable) so a
// per-session override resolved by the host for the firing session is honored. We prove it by corrupting
// the config post-enable and asserting the hook warns + skips (a cached snapshot would drive the flow with
// the stale enable-time menu).
test('onMessage re-reads ctx.config per event (per-session config is not cached at enable)', async () => {
  let liveConfig: Record<string, unknown> = { greeting: 'menu', options: [{ key: '1', text: 'A' }] };
  const warnings: string[] = [];
  let registered = false;
  let handler: (hook: any) => Promise<unknown> = async () => {}; // default no-op; overwritten on registerHook
  const ctx: any = {
    get config() { return liveConfig; }, // simulate the host's per-session getter
    logger: { log() {}, debug() {}, warn: (m: string) => warnings.push(m), error() {} },
    registerHook: (_e: string, h: any) => { handler = h; registered = true; },
    storage: { get: async () => null, set: async () => {}, delete: async () => {}, list: async () => [] },
    messages: { reply: async () => ({ messageId: '', timestamp: 0 }), sendText: async () => ({ messageId: '', timestamp: 0 }) },
  };
  const { default: ChatFlow } = await import('./index.ts');
  const plugin = new ChatFlow();
  await plugin.onEnable(ctx);
  assert.ok(registered, 'hook registered');

  // Corrupt the config AFTER enable. A snapshot cached at enable would not see this; a per-event read does.
  liveConfig = { greeting: '', options: [] };
  await handler({ source: 'Engine', sessionId: 's1', timestamp: new Date(),
    data: { id: 'm1', chatId: 'c@x', body: 'hi', fromMe: false, isGroup: false } });
  assert.ok(warnings.some(w => /config invalid/.test(w)), 'corrupted post-enable config was re-read and warned');
});
