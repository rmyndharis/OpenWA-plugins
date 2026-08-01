import { test } from 'node:test';
import assert from 'node:assert/strict';
import ChatwootAdapter from './index.ts';
import { MAX_PENDING_RETRIES, RETRY_INTERVAL_MS } from './retry.ts';
import type { PluginContext } from '../types/openwa';

function fakeCtx(config: Record<string, unknown>) {
  const hooks: string[] = [];
  const routes: string[] = [];
  const cbs: Record<string, (h: unknown) => Promise<{ continue: boolean }>> = {};
  const priorities: Record<string, number | undefined> = {};
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
    registerHook: (event: string, cb: (h: unknown) => Promise<{ continue: boolean }>, priority?: number) => {
      hooks.push(event);
      cbs[event] = cb;
      priorities[event] = priority;
    },
    registerWebhook: (route: string) => void routes.push(route),
  } as unknown as PluginContext;
  return { ctx, hooks, routes, cbs, fetches: () => fetches, storageMap, priorities };
}

const goodConfig = { baseUrl: 'https://chat.acme.com', apiToken: 'tok', accountId: 3, inboxId: 7 };

test('onEnable registers the message:received + message:sent hooks and the chatwoot ingress route', async () => {
  const { ctx, hooks, routes } = fakeCtx(goodConfig);
  await new ChatwootAdapter().onEnable(ctx);
  assert.deepEqual(hooks, ['message:received', 'message:sent']);
  assert.deepEqual(routes, ['chatwoot']);
});

// Observer band (PLUGIN-STANDARD.md "Co-installation"): must run before any responder, or a claiming
// responder (chat-flow, group-translate) silently ends the chain before the relay ever sees the message.
test('relays at observer priority on both hooks', async () => {
  const { ctx, priorities } = fakeCtx(goodConfig);
  await new ChatwootAdapter().onEnable(ctx);
  assert.deepEqual(priorities, { 'message:received': 20, 'message:sent': 20 });
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

// The retry-drain timer re-relays a queued message via the SAME relayInbound a live inbound uses, but a
// dangling mapping's 404 must NOT trigger the unlink-and-rebuild recovery there: the drain is already a
// re-attempt of a previously failed relay, so rebuilding would mint a fresh orphan Chatwoot conversation on
// every one of its (up to 5) attempts instead of ever converging. That's what relayInbound's `recoverOn404`
// option exists to prevent — this pins that the drain call site actually passes it false.
test('retry drain leaves a dangling mapping alone on a 404 — no rebuild, the retry budget absorbs it', async (t) => {
  const { ctx, storageMap } = fakeCtx(goodConfig);
  // A stale mapping: Chatwoot conversation 55 is gone (operator deleted it out of band) but the mapping
  // still points at it.
  storageMap.set('conv:sess:c@wa', { conversationId: 55, contactId: 9, sourceId: 'src' });
  // Queued as if an earlier live relay against it already failed once.
  storageMap.set('retry:sess:m1', {
    sessionId: 'sess',
    chatId: 'c@wa',
    msg: { id: 'm1', from: 'x', to: 'y', chatId: 'c@wa', body: 'hi', type: 'chat', timestamp: 0, fromMe: false, isGroup: false },
    attempts: 0,
    enqueuedAt: 1,
  });
  // A minimal Chatwoot double: the stale conversation 404s; a contact search + fresh conversation create
  // would succeed if the recovery path ran (it must not).
  const calls: string[] = [];
  ctx.net.fetch = (async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    if (url.includes('/contacts/search')) {
      return {
        ok: true, status: 200, headers: {},
        body: JSON.stringify({ payload: [{ id: 9, identifier: 'c@wa', contact_inboxes: [{ inbox: { id: 7 }, source_id: 'src' }] }] }),
      };
    }
    if (/\/contacts\/\d+\/conversations$/.test(url)) return { ok: true, status: 200, headers: {}, body: JSON.stringify({ payload: [] }) };
    if (method === 'POST' && url.endsWith('/conversations')) return { ok: true, status: 200, headers: {}, body: JSON.stringify({ id: 200 }) };
    if (method === 'POST' && url.endsWith('/conversations/55/messages')) return { ok: false, status: 404, headers: {}, body: 'Not Found' };
    return { ok: true, status: 200, headers: {}, body: '{}' };
  }) as typeof ctx.net.fetch;

  // Fake the retry timer so the drain runs synchronously under test control instead of after a real 30s wait.
  t.mock.timers.enable({ apis: ['setInterval'] });
  const adapter = new ChatwootAdapter();
  await adapter.onEnable(ctx);
  t.mock.timers.tick(RETRY_INTERVAL_MS);
  // The drain's own work (storage + the fetch double above) all settles on real promises; flush them.
  await new Promise(res => setImmediate(res));
  await new Promise(res => setImmediate(res));

  const mapping = storageMap.get('conv:sess:c@wa') as { conversationId: number } | undefined;
  assert.equal(mapping?.conversationId, 55, 'the dangling mapping must be left exactly as it was — no rebuild');
  assert.ok(!calls.some(c => c.startsWith('POST') && c.endsWith('/conversations')), 'no fresh conversation is minted on the drain path');
  const retry = storageMap.get('retry:sess:m1') as { attempts: number } | undefined;
  assert.ok(retry, 'the queued message is kept for the next drain, not treated as delivered');
  assert.equal(retry?.attempts, 1, 'the failed attempt bumps the retry counter — the budget absorbs the 404, nothing else does');

  await adapter.onDisable();
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

test('healthCheck reports chats whose history import gave up', async () => {
  const plugin = new ChatwootAdapter();
  await plugin.onEnable(fakeCtx(goodConfig).ctx);
  // Driving this through the real path needs a hook registration plus three consecutive failing
  // backfills, which inbound.test.ts already covers; this cast pins only the healthCheck wiring.
  (plugin as unknown as { onBackfillExhausted: (c: string) => void }).onBackfillExhausted('c@c.us');
  const health = await plugin.healthCheck();
  assert.match(health.message ?? '', /1 chat\(s\) gave up on history import/);
  // A gave-up history import doesn't touch the live relay, so it must not flip the health verdict.
  assert.equal(health.healthy, true);
});
