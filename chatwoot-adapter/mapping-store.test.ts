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

test('link writes forward + reverse and mirrors ctx.mappings.upsert', async () => {
  const upserts: unknown[] = [];
  const store = new MappingStore(fakeStorage(), fakeMappings(upserts));
  await store.link('sess', 'c@wa', 'inst', { conversationId: 55, contactId: 9, sourceId: 'src' });
  assert.deepEqual(await store.getByChat('sess', 'c@wa'), { conversationId: 55, contactId: 9, sourceId: 'src' });
  assert.deepEqual(await store.getByConversation(55), { sessionId: 'sess', chatId: 'c@wa' });
  assert.deepEqual(upserts, [[{ sessionId: 'sess', chatId: 'c@wa', instanceId: 'inst' }, '55']]);
});

test('seen is an idempotent check-and-set, namespaced by kind', async () => {
  const store = new MappingStore(fakeStorage(), fakeMappings());
  assert.equal(await store.seen('wa', 'm1'), false); // first time → not seen, now marked
  assert.equal(await store.seen('wa', 'm1'), true); // second time → seen
  assert.equal(await store.seen('cw', 'm1'), false); // different namespace
});

test('patch merges over the existing forward doc', async () => {
  const store = new MappingStore(fakeStorage(), fakeMappings());
  await store.link('s', 'c', 'i', { conversationId: 1, contactId: 2, sourceId: 'x' });
  await store.patch('s', 'c', { handoverState: 'human' });
  assert.deepEqual(await store.getByChat('s', 'c'), { conversationId: 1, contactId: 2, sourceId: 'x', handoverState: 'human' });
});
