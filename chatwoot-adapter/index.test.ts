import { test } from 'node:test';
import assert from 'node:assert/strict';
import ChatwootAdapter from './index.ts';
import { MAX_PENDING_RETRIES } from './retry.ts';
import type { PluginContext } from '../types/openwa';

function fakeCtx(config: Record<string, unknown>) {
  const hooks: string[] = [];
  const routes: string[] = [];
  const cbs: Record<string, (h: unknown) => Promise<{ continue: boolean }>> = {};
  let fetches = 0;
  const storageMap = new Map<string, unknown>();
  const ctx = {
    config,
    storage: {
      get: async (k: string) => (storageMap.has(k) ? storageMap.get(k) : null),
      set: async (k: string, v: unknown) => void storageMap.set(k, v),
      delete: async (k: string) => void storageMap.delete(k),
      list: async () => [...storageMap.keys()],
    },
    mappings: { upsert: async () => {}, get: async () => null, getByProvider: async () => null },
    net: { fetch: async () => { fetches++; return { ok: true, status: 200, headers: {}, body: '{}' }; } },
    conversations: { send: async () => ({}) },
    handover: { set: async () => ({}) },
    engine: { canonicalChatId: async (_s: string, c: string) => c },
    logger: { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    registerHook: (event: string, cb: (h: unknown) => Promise<{ continue: boolean }>) => { hooks.push(event); cbs[event] = cb; },
    registerWebhook: (route: string) => void routes.push(route),
  } as unknown as PluginContext;
  return { ctx, hooks, routes, cbs, fetches: () => fetches, storageMap };
}

const goodConfig = { baseUrl: 'https://chat.acme.com', apiToken: 'tok', accountId: 3, inboxId: 7 };

test('onEnable registers the message:received + message:sent hooks and the chatwoot ingress route', async () => {
  const { ctx, hooks, routes } = fakeCtx(goodConfig);
  await new ChatwootAdapter().onEnable(ctx);
  assert.deepEqual(hooks, ['message:received', 'message:sent']);
  assert.deepEqual(routes, ['chatwoot']);
});

test('message:sent is registered even when relayOwnMessages=false (gate is per-event, not at enable)', async () => {
  const { ctx, hooks } = fakeCtx({ ...goodConfig, relayOwnMessages: false });
  await new ChatwootAdapter().onEnable(ctx);
  assert.ok(hooks.includes('message:sent'));
});

test('relayOwnMessages=false gates the message:sent handler off (no Chatwoot API call)', async () => {
  const { ctx, cbs, fetches } = fakeCtx({ ...goodConfig, relayOwnMessages: false });
  await new ChatwootAdapter().onEnable(ctx);
  const r = await cbs['message:sent']({
    sessionId: 'sess',
    source: 'Engine',
    data: { id: 'x', fromMe: true, chatId: 'c@wa', body: 'hi', type: 'chat', isGroup: false },
  });
  await new Promise(res => setImmediate(res)); // let any detached work settle (there should be none)
  assert.deepEqual(r, { continue: true });
  assert.equal(fetches(), 0);
});

test('healthCheck reports the pending retry backlog (healthy — pending is transient)', async () => {
  const { ctx, storageMap } = fakeCtx(goodConfig);
  storageMap.set('retry:sess:m1', { sessionId: 'sess', chatId: 'c@wa', msg: { id: 'm1' }, attempts: 1, enqueuedAt: 1 });
  const adapter = new ChatwootAdapter();
  await adapter.onEnable(ctx);
  const h = await adapter.healthCheck();
  assert.equal(h.healthy, true);
  assert.match(h.message ?? '', /1 inbound message\(s\) pending retry/);
  await adapter.onDisable();
});

test('healthCheck is UNHEALTHY when the retry queue is saturated (at capacity → dropping oldest)', async () => {
  const { ctx, storageMap } = fakeCtx(goodConfig);
  for (let i = 0; i < MAX_PENDING_RETRIES; i++) {
    storageMap.set(`retry:sess:m${i}`, { sessionId: 'sess', chatId: 'c', msg: { id: `m${i}` }, attempts: 1, enqueuedAt: i });
  }
  const adapter = new ChatwootAdapter();
  await adapter.onEnable(ctx);
  const h = await adapter.healthCheck();
  assert.equal(h.healthy, false); // active data loss must not read as healthy
  assert.match(h.message ?? '', /queue full, dropping oldest/);
  await adapter.onDisable();
});

test('healthCheck is healthy with an empty queue; onDisable/onUnload run cleanly (timer cleared)', async () => {
  const { ctx } = fakeCtx(goodConfig);
  const adapter = new ChatwootAdapter();
  await adapter.onEnable(ctx);
  assert.deepEqual(await adapter.healthCheck(), { healthy: true, message: undefined });
  await adapter.onDisable();
  await adapter.onUnload();
});

test('onEnable throws on missing / invalid config', async () => {
  const { ctx } = fakeCtx({ baseUrl: 'https://x' }); // missing apiToken, accountId, inboxId
  await assert.rejects(new ChatwootAdapter().onEnable(ctx), /missing\/invalid config/);
});

test('onEnable rejects a non-https or credentialed baseUrl (fail fast, not per-message)', async () => {
  // The host net allowlist only admits an https, credential-free host, so these would otherwise enable
  // "healthy" and then silently fail every inbound relay.
  await assert.rejects(new ChatwootAdapter().onEnable(fakeCtx({ ...goodConfig, baseUrl: 'http://chat.acme.com' }).ctx), /https/);
  await assert.rejects(new ChatwootAdapter().onEnable(fakeCtx({ ...goodConfig, baseUrl: 'https://user:pw@chat.acme.com' }).ctx), /credential/);
  await assert.rejects(new ChatwootAdapter().onEnable(fakeCtx({ ...goodConfig, baseUrl: 'not a url' }).ctx), /valid URL/);
});
