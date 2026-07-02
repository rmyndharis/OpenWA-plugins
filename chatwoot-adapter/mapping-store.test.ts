import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginStorage, PluginMappingsCapability } from '../types/openwa';
import { MappingStore } from './mapping-store.ts';

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
