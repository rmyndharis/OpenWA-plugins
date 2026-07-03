import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drainRetries, slimForRetry, RETRY_MAX_MEDIA_B64 } from './retry.ts';
import { MappingStore } from './mapping-store.ts';
import { KeyedAsyncLock } from './chat-lock.ts';
import type { PluginStorage, PluginMappingsCapability, IncomingMessage } from '../types/openwa';

function fakeStorage(): PluginStorage {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => (m.has(k) ? (m.get(k) as T) : null),
    set: async (k: string, v: unknown) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
    list: async () => [...m.keys()],
  };
}
const fakeMappings: PluginMappingsCapability = { upsert: async () => {}, get: async () => null, getByProvider: async () => null };
const msg = (id: string, chatId = 'c@wa'): IncomingMessage =>
  ({ id, from: 'x', to: 'y', chatId, body: 'hi', type: 'chat', timestamp: 0, fromMe: false, isGroup: false }) as IncomingMessage;

function deps() {
  const logs: string[] = [];
  return { store: new MappingStore(fakeStorage(), fakeMappings), lock: new KeyedAsyncLock(), log: (m: string) => logs.push(m), logs };
}

test('drain: a successful relay removes the entry and calls relay with (sessionId, chatId, msg)', async () => {
  const d = deps();
  await d.store.enqueueRetry({ sessionId: 'sess', chatId: 'c@wa', msg: msg('m1'), enqueuedAt: 1 }, 500);
  const calls: string[] = [];
  const r = await drainRetries(d, async (s, c, m) => void calls.push(`${s}:${c}:${m.id}`), 5);
  assert.deepEqual(calls, ['sess:c@wa:m1']);
  assert.equal(await d.store.countRetries(), 0);
  assert.equal(r.deadLettered, 0);
});

test('drain: a failing relay increments attempts and keeps the entry (below max)', async () => {
  const d = deps();
  await d.store.enqueueRetry({ sessionId: 'sess', chatId: 'c@wa', msg: msg('m1'), enqueuedAt: 1 }, 500);
  const r = await drainRetries(d, async () => { throw new Error('chatwoot down'); }, 5);
  assert.equal(await d.store.countRetries(), 1);
  assert.equal((await d.store.listRetries())[0].attempts, 1);
  assert.equal(r.deadLettered, 0);
});

test('drain: dead-letters (drops + logs + counts) once attempts reach maxAttempts', async () => {
  const d = deps();
  await d.store.enqueueRetry({ sessionId: 'sess', chatId: 'c@wa', msg: msg('m1'), enqueuedAt: 1 }, 500);
  await d.store.bumpRetryAttempts((await d.store.listRetries())[0].key, 4); // one below max=5
  const r = await drainRetries(d, async () => { throw new Error('chatwoot down'); }, 5);
  assert.equal(await d.store.countRetries(), 0); // dropped from the queue
  assert.equal(r.deadLettered, 1);
  assert.match(d.logs.join('\n'), /dead-lettered after 5 attempts/);
});

test('slimForRetry strips an oversized media blob (so it retries as a placeholder) but keeps small media', () => {
  const big = { ...msg('m1'), media: { mimetype: 'image/jpeg', data: 'A'.repeat(RETRY_MAX_MEDIA_B64 + 1) } } as IncomingMessage;
  const slimmed = slimForRetry(big);
  assert.equal(slimmed.media?.data, undefined);
  assert.equal(slimmed.media?.omitted, true);
  const small = { ...msg('m2'), media: { mimetype: 'image/jpeg', data: 'AAA' } } as IncomingMessage;
  assert.equal(slimForRetry(small).media?.data, 'AAA'); // small media kept for a faithful retry
  assert.equal(slimForRetry(msg('m3')).media, undefined); // no media → unchanged
});

test('drain: a successful relay whose deleteRetry throws is NOT re-posted or bumped (treated as delivered)', async () => {
  let posts = 0;
  let bumps = 0;
  const entry = { key: 'retry:sess:m1', sessionId: 'sess', chatId: 'c@wa', msg: msg('m1'), attempts: 0, enqueuedAt: 1 };
  const store = {
    listRetryKeys: async () => [entry.key],
    getRetry: async () => entry,
    deleteRetry: async () => { throw new Error('storage delete failed'); },
    bumpRetryAttempts: async () => void bumps++,
  } as unknown as MappingStore;
  const logs: string[] = [];
  const r = await drainRetries({ store, lock: new KeyedAsyncLock(), log: (m: string) => logs.push(m) }, async () => void posts++, 5);
  assert.equal(posts, 1); // relayed once
  assert.equal(bumps, 0); // a delete failure after a successful post must NOT bump attempts / re-post
  assert.equal(r.deadLettered, 0);
  assert.match(logs.join('\n'), /deleteRetry after a successful relay failed/);
});

test('drain: processes multiple entries independently (one succeeds, one fails)', async () => {
  const d = deps();
  await d.store.enqueueRetry({ sessionId: 'sess', chatId: 'a@wa', msg: msg('ok', 'a@wa'), enqueuedAt: 1 }, 500);
  await d.store.enqueueRetry({ sessionId: 'sess', chatId: 'b@wa', msg: msg('bad', 'b@wa'), enqueuedAt: 2 }, 500);
  await drainRetries(d, async (_s, _c, m) => { if (m.id === 'bad') throw new Error('down'); }, 5);
  const ids = (await d.store.listRetries()).map(e => e.msg.id);
  assert.deepEqual(ids, ['bad']); // 'ok' relayed + removed; 'bad' remains for retry
});
