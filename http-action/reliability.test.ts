import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claim, prune, allowCooldown, type StorageLike, DEDUP_TTL_MS } from './reliability.ts';

// Minimal in-memory StorageLike for tests. `listFail`/`getFail` simulate storage errors.
function fakeStore(opts: { listFail?: boolean; getFail?: boolean; setFail?: boolean } = {}): StorageLike & { m: Map<string, unknown> } {
  const m = new Map<string, unknown>();
  return {
    m,
    get: async (key: string) => {
      if (opts.getFail) throw new Error('get');
      return m.has(key) ? m.get(key) : null;
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

// ---- claim (dedup, fail-closed) ----

test('claim: first sighting of a message is claimed', async () => {
  const s = fakeStore();
  assert.equal(await claim(s, 'sess', 'm1', 10000, 1000), true);
  assert.equal(s.m.get('dedup:sess:m1'), 1000);
});

test('claim: a re-sighting within the TTL is rejected (dedup)', async () => {
  const s = fakeStore();
  await claim(s, 'sess', 'm1', 10000, 1000);
  assert.equal(await claim(s, 'sess', 'm1', 10000, 1500), false); // 500 < 10000
});

test('claim: a re-sighting after the TTL is re-claimed', async () => {
  const s = fakeStore();
  await claim(s, 'sess', 'm1', 10000, 1000);
  assert.equal(await claim(s, 'sess', 'm1', 10000, 12000), true); // 11000 > 10000
  assert.equal(s.m.get('dedup:sess:m1'), 12000); // marker refreshed
});

test('claim: distinct message ids are independent', async () => {
  const s = fakeStore();
  assert.equal(await claim(s, 'sess', 'm1', 10000, 1000), true);
  assert.equal(await claim(s, 'sess', 'm2', 10000, 1000), true);
});

test('claim: a storage get error fails CLOSED (drop, never double-process)', async () => {
  const s = fakeStore({ getFail: true });
  assert.equal(await claim(s, 'sess', 'm1', 10000, 1000), false);
});

test('claim: a storage set error fails CLOSED (drop)', async () => {
  const s = fakeStore({ setFail: true });
  assert.equal(await claim(s, 'sess', 'm1', 10000, 1000), false);
});

// ---- prune (throttled, best-effort, bound growth) ----

test('prune: deletes markers older than the TTL, keeps the rest', async () => {
  const s = fakeStore();
  s.m.set('dedup:sess:old', 1000);
  s.m.set('dedup:sess:fresh', 50000);
  const out = await prune(s, 60000, 10000, 1000);
  assert.equal(out.ran, true);
  assert.equal(out.pruned, 1);
  assert.equal(s.m.has('dedup:sess:old'), false);
  assert.equal(s.m.has('dedup:sess:fresh'), true);
});

test('prune: is throttled by the interval (skips when recently run)', async () => {
  const s = fakeStore();
  s.m.set('dedup:__prune__', 59500);
  s.m.set('dedup:sess:old', 1000); // would be pruned, but we should not run
  const out = await prune(s, 60000, 10000, 1000); // 60000-59500 = 500 < 1000 → not due
  assert.equal(out.ran, false);
  assert.equal(s.m.has('dedup:sess:old'), true); // untouched
});

test('prune: runs once past the interval', async () => {
  const s = fakeStore();
  s.m.set('dedup:__prune__', 50000);
  s.m.set('dedup:sess:old', 1000);
  const out = await prune(s, 60000, 10000, 20000); // 60000-50000 = 10000 < 20000 → not due
  assert.equal(out.ran, false);
  const out2 = await prune(s, 80000, 10000, 20000); // 80000-50000 = 30000 >= 20000 → due
  assert.equal(out2.ran, true);
});

test('prune: ignores keys outside the dedup prefix (defensive)', async () => {
  const s = fakeStore();
  s.m.set('dedup:sess:old', 1000);
  s.m.set('other:kind:key', 1000); // unrelated
  const out = await prune(s, 60000, 10000, 1000);
  assert.equal(out.pruned, 1);
  assert.equal(s.m.has('other:kind:key'), true); // untouched
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
  assert.equal(allowCooldown(m, 'c1', 3999, 3000), false); // 2999 < 3000
});

test('allowCooldown: allows after the window elapses', () => {
  const m = new Map<string, number>();
  allowCooldown(m, 'c1', 1000, 3000);
  assert.equal(allowCooldown(m, 'c1', 4000, 3000), true); // 3000, not < 3000
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
