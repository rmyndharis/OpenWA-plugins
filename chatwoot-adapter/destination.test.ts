import { test } from 'node:test';
import assert from 'node:assert/strict';
import ChatwootAdapter from './index.ts';
import { MappingStore, destinationIdentity } from './mapping-store.ts';
import { RETRY_INTERVAL_MS } from './retry.ts';
import type { HookContext, IncomingMessage, PluginContext, WebhookRequest } from '../types/openwa';

const initial = { baseUrl: 'https://chat.example.com', accountId: 3, inboxId: 7, apiToken: 'token', relayOwnMessages: false };
const message = (id: string): IncomingMessage => ({
  id, from: '621@c.us', to: 'me', chatId: '621@c.us', body: id, type: 'chat',
  timestamp: 1, fromMe: false, isGroup: false,
});
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

function setup() {
  const data = new Map<string, unknown>();
  const hooks: Record<string, (h: HookContext) => Promise<unknown>> = {};
  let webhook: (req: WebhookRequest) => Promise<unknown>;
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  const mirrored: string[] = [];
  const core = new Map<string, { providerConversationId: string }>();
  const sends: unknown[] = [];
  const ctx = {
    config: { ...initial },
    storage: {
      get: async (key: string) => structuredClone(data.get(key) ?? null),
      set: async (key: string, value: unknown) => void data.set(key, structuredClone(value)),
      delete: async (key: string) => void data.delete(key),
      list: async (prefix = '') => [...data.keys()].filter(key => key.startsWith(prefix)),
    },
    mappings: { upsert: async (key: unknown, id: string) => { mirrored.push(id); core.set(JSON.stringify(key), { providerConversationId: id }); }, get: async (key: unknown) => core.get(JSON.stringify(key)) ?? null, getByProvider: async () => null },
    conversations: { send: async (envelope: unknown) => { sends.push(envelope); return { messageId: 'sent' }; } },
    handover: { set: async () => {} },
    net: { fetch: async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      requests.push({ url, method, body: init?.body });
      let body: unknown = { id: 901 };
      if (url.includes('/contacts/search')) body = { payload: [] };
      else if (/\/contacts\/\d+\/conversations$/.test(url)) body = { payload: [] };
      else if (url.endsWith('/contacts')) body = { payload: { contact: { id: 18, contact_inboxes: [{ inbox: { id: Number(ctx.config.inboxId) }, source_id: 'new-source' }] } } };
      else if (url.endsWith('/conversations')) body = { id: 56 };
      return { ok: true, status: 200, headers: {}, body: JSON.stringify(body) };
    } },
    engine: { canonicalChatId: async (_s: string, chat: string) => chat, getChatHistory: async () => [], getChats: async () => [] },
    logger: { log: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
    registerHook: (name: string, cb: typeof hooks[string]) => void (hooks[name] = cb),
    registerWebhook: (_name: string, cb: typeof webhook) => void (webhook = cb),
  } as unknown as PluginContext;
  const store = new MappingStore(ctx.storage, ctx.mappings);
  const emit = async (id: string, fromMe = false) => {
    await hooks[fromMe ? 'message:sent' : 'message:received']({
      sessionId: 'sess', source: 'Engine', event: fromMe ? 'message:sent' : 'message:received',
      data: { ...message(id), fromMe }, timestamp: new Date(),
    } as HookContext);
    await flush();
  };
  return { ctx, store, requests, mirrored, sends, emit, data, webhook: (req: WebhookRequest) => webhook(req) };
}

test('destination changes rebuild mappings and do not reuse old contact or conversation numbers', async () => {
  for (const changed of [
    { ...initial, baseUrl: 'https://next.example.com' },
    { ...initial, accountId: 4 },
    { ...initial, inboxId: 8 },
  ]) {
    const h = setup();
    await h.store.forDestination(initial).link('sess', '621@c.us', 'sess', { conversationId: 55, contactId: 17, sourceId: 'old' });
    h.requests.length = 0;
    const adapter = new ChatwootAdapter();
    await adapter.onEnable(h.ctx);
    await h.emit('initial');
    h.requests.length = 0;
    h.ctx.config = changed;
    await h.emit('fresh');
    assert.ok(h.requests.some(r => r.url.includes('/contacts/search')));
    assert.ok(h.requests.some(r => r.url.endsWith('/conversations/56/messages')));
    assert.ok(h.requests.every(r => !r.url.includes('/contacts/17') && !r.url.includes('/conversations/55')));
    assert.equal((await h.store.forDestination(initial).getByChat('sess', '621@c.us'))?.conversationId, 55);
    await adapter.onDisable();
  }
});

test('retry draining holds old destinations and unattributed legacy customer data', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const h = setup();
  await h.store.forDestination(initial).enqueueRetry({ sessionId: 'sess', chatId: '621@c.us', msg: message('old-destination'), enqueuedAt: 1 }, 80);
  await h.store.enqueueRetry({ sessionId: 'sess', chatId: '621@c.us', msg: message('legacy'), enqueuedAt: 2 }, 80);
  const adapter = new ChatwootAdapter();
  await adapter.onEnable(h.ctx);
  h.ctx.config = { ...initial, accountId: 4 };
  await h.emit('capture', true);
  t.mock.timers.tick(RETRY_INTERVAL_MS);
  await flush();
  assert.deepEqual(h.requests, []);
  assert.equal((await h.store.listRetries()).every(e => e.attempts === 0), true);
  assert.equal(await h.store.countRetries(), 2);
  await adapter.onDisable();
});

test('a config update invalidates retry snapshots until a fresh session dispatch', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const h = setup();
  await h.store.forDestination(initial).enqueueRetry({ sessionId: 'sess', chatId: '621@c.us', msg: message('pending'), enqueuedAt: 1 }, 80);
  const adapter = new ChatwootAdapter();
  await adapter.onEnable(h.ctx);
  await h.emit('capture', true);
  h.ctx.config = { ...initial, accountId: 4 };
  await adapter.onConfigChange(h.ctx, h.ctx.config);
  t.mock.timers.tick(RETRY_INTERVAL_MS);
  await flush();
  assert.deepEqual(h.requests, []);
  assert.equal(await h.store.countRetries(), 1);
  await adapter.onDisable();
});

test('own sends only use mappings in their configured destination', async () => {
  const h = setup();
  await h.store.forDestination(initial).link('sess', '621@c.us', 'sess', { conversationId: 55, contactId: 17, sourceId: 'old' });
  const adapter = new ChatwootAdapter();
  await adapter.onEnable(h.ctx);
  await h.emit('initial');
  h.requests.length = 0;
  h.ctx.config = { ...initial, accountId: 4, relayOwnMessages: true };
  await h.emit('own', true);
  assert.deepEqual(h.requests, []);
  await adapter.onDisable();
});

test('a late old-destination contact lookup cannot replace a newer core mapping', async () => {
  const h = setup();
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const lookup = new Promise<void>(resolve => { started = resolve; });
  const fetch = h.ctx.net.fetch;
  h.ctx.net.fetch = async (url, init) => {
    if (url.includes('/accounts/3/contacts/search')) { started(); await gate; }
    return fetch(url, init);
  };
  const adapter = new ChatwootAdapter();
  await adapter.onEnable(h.ctx);
  void h.emit('old');
  await lookup;
  h.ctx.config = { ...initial, accountId: 4 };
  const next = h.emit('new');
  release();
  await next;
  assert.ok(h.requests.every(r => r.method === 'GET' || r.url.includes('/accounts/4/')));
  assert.deepEqual(h.mirrored, [`${destinationIdentity({ ...initial, accountId: 4 })}:56`]);
  assert.equal((await h.store.listRetries())[0]?.destination, h.store.forDestination(initial).destination);
  await adapter.onDisable();
});


test('a recreated conversation imports history already delivered to its deleted predecessor', async () => {
  const h = setup();
  h.ctx.config = { ...initial, backfillLimit: 20 };
  const view = h.store.forDestination(initial);
  await view.link('sess', '621@c.us', 'sess', { conversationId: 55, contactId: 17, sourceId: 'old', backfillDone: true });
  await view.markSeen('wa', 'earlier', 'sess');
  h.ctx.engine.getChatHistory = async () => [message('earlier'), message('current')];
  const fetch = h.ctx.net.fetch;
  h.ctx.net.fetch = async (url, init) => url.endsWith('/conversations/55/messages')
    ? { ok: false, status: 404, statusText: 'Not Found', headers: {}, body: 'missing' }
    : fetch(url, init);
  const adapter = new ChatwootAdapter();
  await adapter.onEnable(h.ctx);
  await h.emit('current');
  const posts = h.requests.filter(r => r.url.endsWith('/conversations/56/messages'));
  assert.deepEqual(posts.map(r => JSON.parse(r.body!).content), ['earlier', 'current']);
  assert.equal((await view.getByChat('sess', '621@c.us'))?.backfillDone, true);
  await adapter.onDisable();
});

test('switching back to a stored destination restores its qualified core mapping', async () => {
  const h = setup();
  const adapter = new ChatwootAdapter();
  await adapter.onEnable(h.ctx);
  await h.emit('first');
  h.ctx.config = { ...initial, accountId: 4 };
  await h.emit('second');
  h.ctx.config = { ...initial };
  await h.emit('third');
  assert.deepEqual(h.mirrored, [
    `${destinationIdentity(initial)}:56`,
    `${destinationIdentity({ ...initial, accountId: 4 })}:56`,
    `${destinationIdentity(initial)}:56`,
  ]);
  await adapter.onDisable();
});

test('ingress cannot use reverse mappings belonging to a previous destination', async () => {
  const h = setup();
  await h.store.forDestination(initial).link('sess', '621@c.us', 'sess', { conversationId: 55, contactId: 17, sourceId: 'old' });
  const adapter = new ChatwootAdapter();
  await adapter.onEnable(h.ctx);
  h.ctx.config = { ...initial, accountId: 4 };
  const body = JSON.stringify({ event: 'message_created', id: 9, account: { id: 4 }, inbox: { id: 7 }, conversation: { id: 55 }, message_type: 'outgoing', private: false, content: 'private' });
  await h.webhook({ sessionId: 'sess', rawBody: body, body, verified: true } as WebhookRequest);
  assert.deepEqual(h.sends, []);
  await adapter.onDisable();
});


test('history import does not repost an agent reply already present in the same conversation', async () => {
  const h = setup();
  h.ctx.config = { ...initial, backfillLimit: 20 };
  await h.store.forDestination(initial).link('sess', '621@c.us', 'sess', { conversationId: 55, contactId: 17, sourceId: 'old', backfillDone: false });
  h.ctx.engine.getChatHistory = async () => [{ ...message('sent'), body: 'agent reply', fromMe: true }];
  const adapter = new ChatwootAdapter();
  await adapter.onEnable(h.ctx);
  const body = JSON.stringify({ event: 'message_created', id: 9, account: { id: 3 }, inbox: { id: 7 }, conversation: { id: 55 }, message_type: 'outgoing', private: false, content: 'agent reply' });
  await h.webhook({ sessionId: 'sess', rawBody: body, body, verified: true } as WebhookRequest);
  h.requests.length = 0;
  await h.emit('current');
  assert.deepEqual(h.requests.filter(r => r.url.endsWith('/messages')).map(r => JSON.parse(r.body!).content), ['current']);
  await adapter.onDisable();
});


test('legacy ingress stays retryable until a current-destination inbound establishes its mapping', async () => {
  const h = setup();
  await h.store.link('sess', '621@c.us', 'sess', { conversationId: 55, contactId: 17, sourceId: 'old' });
  const fetch = h.ctx.net.fetch;
  h.ctx.net.fetch = async (url, init) => {
    if (url.includes('/contacts/search')) return { ok: true, status: 200, statusText: 'OK', headers: {}, body: JSON.stringify({ payload: [{ id: 17, identifier: '621@c.us', contact_inboxes: [{ inbox: { id: 7 }, source_id: 'old' }] }] }) };
    if (url.endsWith('/contacts/17/conversations')) return { ok: true, status: 200, statusText: 'OK', headers: {}, body: JSON.stringify({ payload: [{ id: 55, inbox_id: 7, status: 'open' }] }) };
    return fetch(url, init);
  };
  const adapter = new ChatwootAdapter();
  await adapter.onEnable(h.ctx);
  const body = JSON.stringify({ event: 'message_created', id: 9, account: { id: 3 }, inbox: { id: 7 }, conversation: { id: 55 }, message_type: 'outgoing', private: false, content: 'agent reply' });
  const request = { sessionId: 'sess', rawBody: body, body, verified: true } as WebhookRequest;
  await assert.rejects(h.webhook(request), /mapping.*current destination/i);
  assert.deepEqual(h.sends, []);
  await h.emit('current');
  await h.webhook(request);
  assert.equal(h.sends.length, 1);
  await adapter.onDisable();
});
