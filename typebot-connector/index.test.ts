import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginContext, HookHandler, HookContext } from '../types/openwa';
import Plugin, { readConfig } from './index.ts';

test('readConfig: defaults, normalization, and fail-fast', () => {
  const c = readConfig({ publicId: 'bot', apiHost: 'https://typebot.io' });
  assert.equal(c.apiHost, 'https://typebot.io');
  assert.equal(c.respondInGroups, true);
  assert.equal(c.sessionTimeoutMinutes, 30);
  assert.equal(readConfig({ publicId: 'bot', apiHost: 'https://my.host/' }).apiHost, 'https://my.host');
  assert.throws(() => readConfig({}), /publicId/);
  assert.throws(() => readConfig({ publicId: 'bot' }), /apiHost is required/);
  assert.throws(() => readConfig({ publicId: 'b', apiHost: 'http://x' }), /https/);
  assert.throws(() => readConfig({ publicId: 'b', apiHost: 'https://u:p@x' }), /credentials/);
});

test('onEnable registers a message:received hook that returns {continue:true}', async () => {
  let registered: { event: string; handler: HookHandler; priority?: number } | undefined;
  const ctx = {
    config: { publicId: 'bot', apiHost: 'https://typebot.io' },
    logger: { log() {}, debug() {}, warn() {}, error() {} },
    storage: { get: async () => null, set: async () => {}, delete: async () => {}, list: async () => [] },
    net: { fetch: async () => ({ ok: true, status: 200, headers: {}, body: '{}' }) },
    conversations: { send: async () => {} },
    registerHook: (event: string, handler: HookHandler, priority?: number) => void (registered = { event, handler, priority }),
  } as unknown as PluginContext;

  await new Plugin().onEnable(ctx);
  assert.equal(registered?.event, 'message:received');
  const result = await registered!.handler({ event: 'message:received', data: undefined, timestamp: new Date(), source: 'Engine' });
  assert.deepEqual(result, { continue: true });
});

test('message:received hook resolves synchronously (claiming an in-scope chat) without awaiting a hanging Typebot turn', async () => {
  let registered: { event: string; handler: HookHandler; priority?: number } | undefined;
  const ctx = {
    config: { publicId: 'bot', apiHost: 'https://typebot.io' },
    logger: { log() {}, debug() {}, warn() {}, error() {} },
    storage: { get: async () => null, set: async () => {}, delete: async () => {}, list: async () => [] },
    net: { fetch: () => new Promise(() => {}) },
    conversations: { send: async () => {} },
    registerHook: (event: string, handler: HookHandler, priority?: number) => void (registered = { event, handler, priority }),
  } as unknown as PluginContext;

  await new Plugin().onEnable(ctx);
  const populated = {
    event: 'message:received',
    sessionId: 'sess',
    source: 'Engine',
    timestamp: new Date(),
    data: {
      id: 'm', from: 'x', to: 'y', chatId: 'c@c.us', body: 'hi', type: 'chat',
      timestamp: 0, fromMe: false, isGroup: false,
    },
  } as unknown as HookContext;
  // In scope (real Engine message, not our own, has a chat) — claimed even though net.fetch never
  // resolves, proving the claim is decided before the floated handleTurn call, not after it.
  assert.deepEqual(await registered!.handler(populated), { continue: false });
});

// ── Co-installation: claim + priority (PLUGIN-STANDARD.md) ─────────────────────────────────────────

// Minimal ctx builder for the tests below — the two tests above build their own inline ctx per case (a
// live vs. a hanging net.fetch); this one only needs a valid config + an overridable registerHook.
function makeCtx(overrides: {
  config?: Record<string, unknown>;
  registerHook?: (event: string, handler: HookHandler, priority?: number) => void;
} = {}) {
  return {
    config: overrides.config ?? { publicId: 'bot', apiHost: 'https://typebot.io' },
    logger: { log() {}, debug() {}, warn() {}, error() {} },
    storage: { get: async () => null, set: async () => {}, delete: async () => {}, list: async () => [] },
    net: { fetch: async () => ({ ok: true, status: 200, headers: {}, body: '{}' }) },
    conversations: { send: async () => {} },
    registerHook: overrides.registerHook ?? (() => {}),
  };
}

// Enables a fresh Plugin and fires one message:received from `source`, returning the synchronous
// {continue} result. The floated handleTurn call is out of scope — never awaited here.
async function runHook(opts: { source: string; isGroup: boolean }) {
  let handler: HookHandler | undefined;
  const ctx = makeCtx({ registerHook: (_e, h) => { handler = h; } });
  await new Plugin().onEnable(ctx as never);
  return handler!({
    event: 'message:received',
    source: opts.source,
    sessionId: 's1',
    timestamp: new Date(),
    data: {
      id: 'm', from: 'x@c.us', to: 'y', chatId: 'c@c.us', body: 'hi', type: 'chat',
      timestamp: 0, fromMe: false, isGroup: opts.isGroup,
    },
  });
}

test('registers at the typebot responder priority', async () => {
  let registered: { event: string; handler: HookHandler; priority?: number } | undefined;
  const ctx = makeCtx({
    registerHook: (event: string, handler: HookHandler, priority?: number) =>
      void (registered = { event, handler, priority }),
  });
  await new Plugin().onEnable(ctx as never);
  assert.equal(registered?.priority, 85);
});

test('claims an in-scope chat and passes an out-of-scope one on', async () => {
  const inScopeResult = await runHook({ source: 'Engine', isGroup: false });
  assert.equal(inScopeResult.continue, false, 'this bot owns every chat it is in scope for');

  const outOfScope = await runHook({ source: 'Webhook', isGroup: false });
  assert.equal(outOfScope.continue, true, 'not from the engine — not ours');
});
