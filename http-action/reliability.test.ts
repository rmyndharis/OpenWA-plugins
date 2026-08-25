import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasSeen, markSeen, prune, allowCooldown, shardOf, type StorageLike, DEDUP_SHARDS, DEDUP_TTL_MS } from './reliability.ts';

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

test('dedup key count stays constant however many commands are answered', async () => {
  // The host re-measures its quota on EVERY set by stat-ing every key of the plugin, synchronously, on
  // the gateway event loop. One key per answered message meant a busy install (20 commands a minute
  // holds ~86,000 markers inside the 3-day window) made every write in every plugin stat that many
  // files.
  const storage = fakeStore();
  for (let i = 0; i < 500; i++) await markSeen(storage, 's1', `m${i}`, 1000);
  const keys = await storage.list();
  assert.equal(keys.filter((k) => k.startsWith('dedup:')).length, 0, 'no per-message key is written');
  assert.ok(keys.length <= DEDUP_SHARDS, `bucket count is bounded, got ${keys.length} keys for 500 markers`);
  assert.equal(await hasSeen(storage, 's1', 'm499'), true, 'and every marker still resolves');
  assert.equal(await hasSeen(storage, 's1', 'nope'), false);
});

test('a marker written before bucketing is still honoured', async () => {
  // Missing one would fire a second real request against the operator's backend on redelivery, which is
  // the exact thing dedup exists to prevent.
  const storage = fakeStore();
  await storage.set('dedup:s1:old-msg', { t: 1000 });
  assert.equal(await hasSeen(storage, 's1', 'old-msg'), true);
  assert.equal(await hasSeen(storage, 's1', 'other'), false);
});

test('a bucket ages its own entries out on write, without a global scan', async () => {
  const storage = fakeStore();
  await markSeen(storage, 's1', 'old', 0);
  assert.equal(await hasSeen(storage, 's1', 'old'), true);
  // A later write to the SAME bucket drops the expired entry.
  const id = `s1:old`;
  const partner = (() => {
    for (let i = 0; i < 100_000; i++) if (shardOf(`s1:p${i}`) === shardOf(id)) return `p${i}`;
    throw new Error('no colliding id');
  })();
  await markSeen(storage, 's1', partner, DEDUP_TTL_MS + 1);
  assert.equal(await hasSeen(storage, 's1', 'old'), false, 'the expired marker is gone');
  assert.equal(await hasSeen(storage, 's1', partner), true, 'the fresh one is kept');
});

test('two markers sharing a bucket do not erase each other', async () => {
  // A bucket is a read-modify-write and every await inside it is an IPC round-trip, so interleaving
  // would drop a marker and re-fire a real backend request on redelivery.
  const storage = fakeStore();
  const target = shardOf('s1:a');
  let partner = '';
  for (let i = 0; i < 100_000 && !partner; i++) if (shardOf(`s1:p${i}`) === target) partner = `p${i}`;
  await Promise.all([markSeen(storage, 's1', 'a', 1000), markSeen(storage, 's1', partner, 1000)]);
  assert.equal(await hasSeen(storage, 's1', 'a'), true);
  assert.equal(await hasSeen(storage, 's1', partner), true);
});
