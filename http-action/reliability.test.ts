import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasSeen, markSeen, prune, allowCooldown, type StorageLike, DEDUP_TTL_MS } from './reliability.ts';

// Minimal in-memory StorageLike for tests. Flags simulate storage errors.
function fakeStore(opts: { listFail?: boolean; getFail?: boolean; setFail?: boolean } = {}): StorageLike & { m: Map<string, unknown> } {
  const m = new Map<string, unknown>();
  return {
    m,
    get: async <T>(key: string): Promise<T | null> => {
      if (opts.getFail) throw new Error('get');
      return m.has(key) ? (m.get(key) as T) : null;
    },
    set: async (key: string, val: unknown) => {
      if (opts.setFail) throw new Error('set');
      m.set(key, val);
    },
    delete: async (key: string) => { m.delete(key); },
    list: async (prefix?: string) => {
      if (opts.listFail) throw new Error('list');
      return [...m.keys()].filter((k) => (prefix ? k.startsWith(prefix) : true));
    },
  };
}

// ---- hasSeen (presence-based, fail-closed) ----

test('hasSeen: false before a message is marked', async () => {
  const s = fakeStore();
  assert.equal(await hasSeen(s, 'sess', 'm1'), false);
});

test('hasSeen: true after markSeen', async () => {
  const s = fakeStore();
  await markSeen(s, 'sess', 'm1', 1000);
  assert.equal(await hasSeen(s, 'sess', 'm1'), true);
});

test('hasSeen: distinct message ids are independent', async () => {
  const s = fakeStore();
  await markSeen(s, 'sess', 'm1', 1000);
  assert.equal(await hasSeen(s, 'sess', 'm2'), false);
});

test('hasSeen: a storage get error fails CLOSED (drop, never double-process)', async () => {
  const s = fakeStore({ getFail: true });
  assert.equal(await hasSeen(s, 'sess', 'm1'), true);
});

test('hasSeen: presence-based — robust to the stored value type (does not require a number)', async () => {
  // Simulate a storage backend that returns the marker in a different shape; presence still wins.
  const s = fakeStore();
  s.m.set('dedup:sess:m1', { t: '1000' }); // t stringified, not a number
  assert.equal(await hasSeen(s, 'sess', 'm1'), true);
});

test('markSeen: a storage set error is swallowed (best-effort)', async () => {
  const s = fakeStore({ setFail: true });
  await markSeen(s, 'sess', 'm1', 1000); // does not throw
});

// ---- prune (throttled, best-effort, reads {t} objects) ----

test('prune: deletes markers older than the TTL, keeps the rest', async () => {
  const s = fakeStore();
  s.m.set('dedup:sess:old', { t: 1000 });
  s.m.set('dedup:sess:fresh', { t: 50000 });
  const out = await prune(s, 60000, 10000, 1000);
  assert.equal(out.ran, true);
  assert.equal(out.pruned, 1);
  assert.equal(s.m.has('dedup:sess:old'), false);
  assert.equal(s.m.has('dedup:sess:fresh'), true);
});

test('prune: is throttled by the interval (skips when recently run)', async () => {
  const s = fakeStore();
  s.m.set('dedup:__prune__', { t: 59500 });
  s.m.set('dedup:sess:old', { t: 1000 });
  const out = await prune(s, 60000, 10000, 1000); // 500 < 1000 → not due
  assert.equal(out.ran, false);
  assert.equal(s.m.has('dedup:sess:old'), true);
});

test('prune: ignores keys outside the dedup prefix (defensive)', async () => {
  const s = fakeStore();
  s.m.set('dedup:sess:old', { t: 1000 });
  s.m.set('other:kind:key', { t: 1000 });
  const out = await prune(s, 60000, 10000, 1000);
  assert.equal(out.pruned, 1);
  assert.equal(s.m.has('other:kind:key'), true);
});

test('prune: leaves a malformed (non-{t}) marker alone rather than deleting blindly', async () => {
  const s = fakeStore();
  s.m.set('dedup:sess:weird', 'not-an-object'); // no .t number → not aged out by prune
  const out = await prune(s, 60000, 10000, 1000);
  assert.equal(out.pruned, 0);
  assert.equal(s.m.has('dedup:sess:weird'), true);
});

test('prune: never throws on storage errors (best-effort)', async () => {
  const s = fakeStore({ listFail: true });
  const out = await prune(s, 60000, 10000, 1000);
  assert.equal(out.ran, true);
  assert.equal(out.pruned, 0);
});

// ---- allowCooldown (in-memory, fail-open, LRU-capped) ----

test('allowCooldown: first call allows', () => {
  const m = new Map<string, number>();
  assert.equal(allowCooldown(m, 'c1', 1000, 3000), true);
});

test('allowCooldown: blocks within the window', () => {
  const m = new Map<string, number>();
  allowCooldown(m, 'c1', 1000, 3000);
  assert.equal(allowCooldown(m, 'c1', 3999, 3000), false);
});

test('allowCooldown: allows after the window elapses', () => {
  const m = new Map<string, number>();
  allowCooldown(m, 'c1', 1000, 3000);
  assert.equal(allowCooldown(m, 'c1', 4000, 3000), true);
});

test('allowCooldown: distinct chats are independent', () => {
  const m = new Map<string, number>();
  assert.equal(allowCooldown(m, 'c1', 1000, 3000), true);
  assert.equal(allowCooldown(m, 'c2', 1000, 3000), true);
});

test('DEDUP_TTL_MS export is a positive number (3 days)', () => {
  assert.ok(DEDUP_TTL_MS > 0);
  assert.equal(DEDUP_TTL_MS, 3 * 24 * 60 * 60 * 1000);
});
