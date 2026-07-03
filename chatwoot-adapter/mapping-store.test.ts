import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginStorage, PluginMappingsCapability, IncomingMessage } from '../types/openwa';
import { MappingStore } from './mapping-store.ts';

const msg = (id: string, chatId = 'c@wa'): IncomingMessage =>
  ({ id, from: 'x', to: 'y', chatId, body: 'hi', type: 'chat', timestamp: 0, fromMe: false, isGroup: false }) as IncomingMessage;

function fakeStorage(): PluginStorage {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => (m.has(k) ? (m.get(k) as T) : null),
    set: async (k: string, v: unknown) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
    list: async () => [...m.keys()],
  };
}
function fakeMappings(sink: unknown[] = []): PluginMappingsCapability {
  return {
    upsert: async (key, id) => void sink.push([key, id]),
    get: async () => null,
    getByProvider: async () => null,
  };
}

test('link writes forward + a session-scoped reverse and mirrors ctx.mappings.upsert', async () => {
  const upserts: unknown[] = [];
  const store = new MappingStore(fakeStorage(), fakeMappings(upserts));
  await store.link('sess', 'c@wa', 'inst', { conversationId: 55, contactId: 9, sourceId: 'src' });
  assert.deepEqual(await store.getByChat('sess', 'c@wa'), { conversationId: 55, contactId: 9, sourceId: 'src' });
  // Scoped lookup for the owning session resolves; so does the unscoped/legacy lookup (back-compat).
  assert.deepEqual(await store.getByConversation(55, 'sess'), { sessionId: 'sess', chatId: 'c@wa' });
  assert.deepEqual(await store.getByConversation(55), { sessionId: 'sess', chatId: 'c@wa' });
  assert.deepEqual(upserts, [[{ sessionId: 'sess', chatId: 'c@wa', instanceId: 'inst' }, '55']]);
});

test('two tenants sharing a conversationId are isolated when looked up with their own session', async () => {
  const store = new MappingStore(fakeStorage(), fakeMappings());
  // Both Chatwoot accounts autoincrement to id 55; each session maps it to a different WA chat.
  await store.link('sessA', 'alice@wa', 'instA', { conversationId: 55, contactId: 1, sourceId: 'a' });
  await store.link('sessB', 'bob@wa', 'instB', { conversationId: 55, contactId: 2, sourceId: 'b' });
  assert.deepEqual(await store.getByConversation(55, 'sessA'), { sessionId: 'sessA', chatId: 'alice@wa' });
  assert.deepEqual(await store.getByConversation(55, 'sessB'), { sessionId: 'sessB', chatId: 'bob@wa' });
});

test('hasSeen/markSeen: scoped markers isolate tenants; unscoped stays global', async () => {
  const store = new MappingStore(fakeStorage(), fakeMappings());
  assert.equal(await store.hasSeen('cw', '5', 'sessA'), false);
  await store.markSeen('cw', '5', 'sessA');
  assert.equal(await store.hasSeen('cw', '5', 'sessA'), true); // marked for A
  assert.equal(await store.hasSeen('cw', '5', 'sessB'), false); // NOT for B — no cross-tenant drop
  assert.equal(await store.hasSeen('wa', '5', 'sessA'), false); // different kind
});

test('patch merges over the existing forward doc', async () => {
  const store = new MappingStore(fakeStorage(), fakeMappings());
  await store.link('s', 'c', 'i', { conversationId: 1, contactId: 2, sourceId: 'x' });
  await store.patch('s', 'c', { handoverState: 'human' });
  assert.deepEqual(await store.getByChat('s', 'c'), { conversationId: 1, contactId: 2, sourceId: 'x', handoverState: 'human' });
});

test('enqueueRetry persists an entry; listRetries returns it; deleteRetry removes it; countRetries counts', async () => {
  const store = new MappingStore(fakeStorage(), fakeMappings());
  const dropped = await store.enqueueRetry({ sessionId: 'sess', chatId: 'c@wa', msg: msg('m1'), enqueuedAt: 100 }, 500);
  assert.equal(dropped, null);
  assert.equal(await store.countRetries(), 1);
  const [e] = await store.listRetries();
  assert.equal(e.msg.id, 'm1');
  assert.equal(e.attempts, 0);
  assert.equal(e.sessionId, 'sess');
  await store.deleteRetry(e.key);
  assert.equal(await store.countRetries(), 0);
});

test('enqueueRetry is a no-op for an already-queued message id (does not reset attempts)', async () => {
  const store = new MappingStore(fakeStorage(), fakeMappings());
  await store.enqueueRetry({ sessionId: 'sess', chatId: 'c@wa', msg: msg('m1'), enqueuedAt: 100 }, 500);
  const [e1] = await store.listRetries();
  await store.bumpRetryAttempts(e1.key, 3);
  await store.enqueueRetry({ sessionId: 'sess', chatId: 'c@wa', msg: msg('m1'), enqueuedAt: 200 }, 500); // duplicate id
  assert.equal(await store.countRetries(), 1);
  assert.equal((await store.listRetries())[0].attempts, 3); // not reset
});

test('bumpRetryAttempts updates the attempt count in place', async () => {
  const store = new MappingStore(fakeStorage(), fakeMappings());
  await store.enqueueRetry({ sessionId: 'sess', chatId: 'c@wa', msg: msg('m1'), enqueuedAt: 100 }, 500);
  const [e] = await store.listRetries();
  await store.bumpRetryAttempts(e.key, 2);
  assert.equal((await store.listRetries())[0].attempts, 2);
});

test('enqueueRetry drops the OLDEST entry (by enqueuedAt) when the queue is at capacity', async () => {
  const store = new MappingStore(fakeStorage(), fakeMappings());
  await store.enqueueRetry({ sessionId: 's', chatId: 'c', msg: msg('old'), enqueuedAt: 100 }, 2);
  await store.enqueueRetry({ sessionId: 's', chatId: 'c', msg: msg('mid'), enqueuedAt: 200 }, 2);
  const dropped = await store.enqueueRetry({ sessionId: 's', chatId: 'c', msg: msg('new'), enqueuedAt: 300 }, 2);
  assert.equal(dropped, 'old'); // returns the dropped id for logging
  const ids = (await store.listRetries()).map(e => e.msg.id).sort();
  assert.deepEqual(ids, ['mid', 'new']);
});

test('markSeen stores a timestamped marker and hasSeen stays truthy', async () => {
  const storage = fakeStorage();
  const store = new MappingStore(storage, fakeMappings());
  await store.markSeen('wa', 'm1', 'sess', 1000);
  assert.equal(await store.hasSeen('wa', 'm1', 'sess'), true);
  assert.deepEqual(await storage.get('seen:sess:wa:m1'), { t: 1000 });
});

test('pruneSeen deletes markers older than the TTL and keeps recent ones', async () => {
  const store = new MappingStore(fakeStorage(), fakeMappings());
  const TTL = 1000;
  await store.markSeen('wa', 'old', 'sess', 0); // age 5000 > TTL → pruned
  await store.markSeen('wa', 'fresh', 'sess', 4500); // age 500 < TTL → kept
  const { pruned, adopted } = await store.pruneSeen(5000, TTL);
  assert.equal(pruned, 1);
  assert.equal(adopted, 0);
  assert.equal(await store.hasSeen('wa', 'old', 'sess'), false);
  assert.equal(await store.hasSeen('wa', 'fresh', 'sess'), true);
});

test('pruneSeen adopts a legacy marker (stamps a timestamp, does not delete)', async () => {
  const storage = fakeStorage();
  const store = new MappingStore(storage, fakeMappings());
  await storage.set('seen:sess:wa:legacy', 1); // pre-0.5.2 bare marker
  const { pruned, adopted } = await store.pruneSeen(9000, 1000);
  assert.equal(pruned, 0);
  assert.equal(adopted, 1);
  assert.equal(await store.hasSeen('wa', 'legacy', 'sess'), true); // still present
  assert.deepEqual(await storage.get('seen:sess:wa:legacy'), { t: 9000 }); // now timestamped
});

test('pruneSeen leaves non-seen keys untouched', async () => {
  const store = new MappingStore(fakeStorage(), fakeMappings());
  await store.link('sess', 'c@wa', 'inst', { conversationId: 1, contactId: 2, sourceId: 'x' });
  await store.enqueueRetry({ sessionId: 'sess', chatId: 'c@wa', msg: msg('r1'), enqueuedAt: 0 }, 500);
  await store.markSeen('wa', 'old', 'sess', 0);
  await store.pruneSeen(10_000, 1000);
  assert.equal(await store.hasSeen('wa', 'old', 'sess'), false); // pruned
  assert.equal(await store.countRetries(), 1); // retry untouched
  assert.deepEqual(await store.getByChat('sess', 'c@wa'), { conversationId: 1, contactId: 2, sourceId: 'x' });
});
