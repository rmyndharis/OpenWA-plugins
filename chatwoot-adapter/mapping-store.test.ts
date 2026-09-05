import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginStorage, PluginMappingsCapability, IncomingMessage } from '../types/openwa';
import { MappingStore, SEEN_SHARDS, SEEN_TTL_MS, shardOf } from './mapping-store.ts';

// The store shards on `${scope}:${kind}:${id}`, so this finds a second message id that lands in the same
// bucket as `id` — the only way to exercise the on-write pruning deterministically.
function idInSameShardAs(kind: 'wa' | 'cw', id: string, scope: string): string {
  const target = shardOf(`${scope}:${kind}:${id}`);
  for (let i = 0; i < 100_000; i++) {
    const candidate = `collide-${i}`;
    if (shardOf(`${scope}:${kind}:${candidate}`) === target) return candidate;
  }
  throw new Error('no colliding id found');
}

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

test('markSeen round-trips through hasSeen, and scope+kind isolate markers', async () => {
  const store = new MappingStore(fakeStorage(), fakeMappings());
  await store.markSeen('wa', 'm1', 'sess', 1000);
  assert.equal(await store.hasSeen('wa', 'm1', 'sess'), true);
  assert.equal(await store.hasSeen('wa', 'm1', 'other-sess'), false); // another tenant
  assert.equal(await store.hasSeen('cw', 'm1', 'sess'), false); // the other marker kind
  assert.equal(await store.hasSeen('wa', 'm2', 'sess'), false);
});

// The property the sharding exists for. The host re-stats every storage key on EVERY write, so a key per
// message made each inbound message cost O(total markers) syscalls on the gateway's event loop.
test('marker storage stays bounded at SEEN_SHARDS keys no matter how many messages are seen', async () => {
  const storage = fakeStorage();
  const store = new MappingStore(storage, fakeMappings());
  for (let i = 0; i < 2000; i++) await store.markSeen('wa', `m${i}`, 'sess', 1000 + i);
  const keys = await storage.list();
  assert.ok(keys.length <= SEEN_SHARDS, `expected <= ${SEEN_SHARDS} keys, got ${keys.length}`);
  // Every one of them is still individually recallable.
  assert.equal(await store.hasSeen('wa', 'm0', 'sess'), true);
  assert.equal(await store.hasSeen('wa', 'm1999', 'sess'), true);
});

test('a bucket drops its own expired entries when it is next written', async () => {
  const store = new MappingStore(fakeStorage(), fakeMappings());
  await store.markSeen('wa', 'old', 'sess', 0);
  assert.equal(await store.hasSeen('wa', 'old', 'sess'), true);
  // Land a second marker in the SAME shard, one TTL later: writing the bucket ages 'old' out of it.
  const collide = idInSameShardAs('wa', 'old', 'sess');
  await store.markSeen('wa', collide, 'sess', SEEN_TTL_MS + 1);
  assert.equal(await store.hasSeen('wa', 'old', 'sess'), false);
  assert.equal(await store.hasSeen('wa', collide, 'sess'), true);
});

// A marker written by <=0.5.7 lives in its own `seen:` key. Missing it on upgrade would re-post an inbound
// message, and via the 'cw' marker would send a Chatwoot reply to the recipient a second time.
test('a pre-0.6.0 per-message marker is still honoured after the upgrade', async () => {
  const storage = fakeStorage();
  const store = new MappingStore(storage, fakeMappings());
  await storage.set('seen:sess:wa:legacy', { t: 1000 });
  assert.equal(await store.hasSeen('wa', 'legacy', 'sess'), true);
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

test('pruneSeen leaves non-legacy keys untouched', async () => {
  const storage = fakeStorage();
  const store = new MappingStore(storage, fakeMappings());
  await store.link('sess', 'c@wa', 'inst', { conversationId: 1, contactId: 2, sourceId: 'x' });
  await store.enqueueRetry({ sessionId: 'sess', chatId: 'c@wa', msg: msg('r1'), enqueuedAt: 0 }, 500);
  await storage.set('seen:sess:wa:old', { t: 0 }); // pre-0.6.0 marker, expired
  await store.markSeen('wa', 'current', 'sess', 9000); // 0.6.0 bucket entry
  const { pruned } = await store.pruneSeen(10_000, 1000);
  assert.equal(pruned, 1); // only the legacy marker
  assert.equal(await store.hasSeen('wa', 'current', 'sess'), true); // bucket survives the prune
  assert.equal(await store.countRetries(), 1); // retry untouched
  assert.deepEqual(await store.getByChat('sess', 'c@wa'), { conversationId: 1, contactId: 2, sourceId: 'x' });
});

// The bug this guards: pruneSeen adopts any `seen:`-prefixed value that has no numeric `.t` by OVERWRITING
// it with `{ t: now }`. A bucket is a plain id->timestamp map with no `.t`, so if buckets shared the `seen:`
// prefix the hourly prune would erase every marker in them.
test('pruneSeen cannot corrupt a marker bucket', async () => {
  const storage = fakeStorage();
  const store = new MappingStore(storage, fakeMappings());
  for (let i = 0; i < 50; i++) await store.markSeen('wa', `m${i}`, 'sess', 1000);
  const { pruned, adopted } = await store.pruneSeen(2000, 1000);
  assert.equal(pruned, 0);
  assert.equal(adopted, 0);
  for (let i = 0; i < 50; i++) assert.equal(await store.hasSeen('wa', `m${i}`, 'sess'), true);
});

// Regression: markSeen is a read-modify-write over a SHARED bucket, and every await in it is an IPC
// round-trip. Two marks that hash to the same bucket — an inbound on one chat and the echo marker for a
// different conversation — used to interleave, and the later write dropped the earlier marker. Losing a
// 'cw' marker re-sends an agent's reply to the contact. The per-chat locks cannot help: a shard is
// shared across chats. The pre-0.6.0 one-key-per-marker scheme had no such window.
function slowStorage(): PluginStorage {
  const m = new Map<string, unknown>();
  const tick = () => new Promise(r => setTimeout(r, 1));
  return {
    get: async <T>(k: string) => { await tick(); return (m.has(k) ? (m.get(k) as T) : null); },
    set: async (k, v) => { await tick(); m.set(k, JSON.parse(JSON.stringify(v))); },
    delete: async k => { await tick(); m.delete(k); },
    list: async (p = '') => [...m.keys()].filter(k => k.startsWith(p)),
  };
}

test('concurrent markSeen into the SAME bucket keeps both markers', async () => {
  const store = new MappingStore(slowStorage(), fakeMappings());
  const scope = 'sess';
  const waId = 'ABCDEF123';
  const target = shardOf(`${scope}:wa:${waId}`);
  let cwId = '';
  for (let i = 1; i < 500_000; i++) {
    if (shardOf(`${scope}:cw:${i}`) === target) { cwId = String(i); break; }
  }
  assert.ok(cwId, 'expected to find an id sharing the shard');

  await Promise.all([store.markSeen('wa', waId, scope), store.markSeen('cw', cwId, scope)]);

  assert.equal(await store.hasSeen('wa', waId, scope), true, 'wa marker lost — an inbound would re-post');
  assert.equal(await store.hasSeen('cw', cwId, scope), true, 'cw marker lost — an agent reply would re-send');
});

// Regression: the legacy-marker fallback must never retire itself. It was gated on a flag that pruneSeen
// cleared whenever its listing came back empty — and the host's list() resolves [] on a read error, so one
// transient failure permanently stopped consulting pre-0.6.0 markers. Missing a 'cw' marker re-sends a
// Chatwoot agent's reply to the contact: a duplicate the customer sees.
test('a failed prune listing does not stop pre-0.6.0 markers being honoured', async () => {
  const storage = fakeStorage();
  const store = new MappingStore(storage, fakeMappings());
  await storage.set('seen:sess:cw:4242', { t: 1000 });   // written by <=0.5.7
  await store.pruneSeen(2000, 1000);                     // a pass whose listing yields nothing useful
  assert.equal(await store.hasSeen('cw', '4242', 'sess'), true,
    'the legacy marker must still be found after a prune that saw an empty listing');
});

test('two sessions sharing a conversation id resolve to their own chat', async () => {
  // Chatwoot conversation ids are per-account autoincrement, so two accounts relayed by one gateway
  // collide as a matter of course. The unscoped reverse key was written on every link, so the last
  // writer won it — and a delivery resolving through it sent one customer's agent reply to another
  // customer's number.
  const store = new MappingStore(fakeStorage(), fakeMappings());
  await store.link('sess-A', '628111@c.us', 'inst', { conversationId: 42, contactId: 1, sourceId: 'a' });
  await store.link('sess-B', '628222@c.us', 'inst', { conversationId: 42, contactId: 2, sourceId: 'b' });

  assert.deepEqual(await store.getByConversation(42, 'sess-A'), { sessionId: 'sess-A', chatId: '628111@c.us' });
  assert.deepEqual(await store.getByConversation(42, 'sess-B'), { sessionId: 'sess-B', chatId: '628222@c.us' });
});

test('unlinking one session leaves another session mapping intact', async () => {
  // The 404 recovery path unlinks by conversation id. It deleted the shared unscoped key too, so
  // recovering tenant A silently dropped tenant B's agent replies until B's next inbound message.
  const store = new MappingStore(fakeStorage(), fakeMappings());
  await store.link('sess-A', '628111@c.us', 'inst', { conversationId: 42, contactId: 1, sourceId: 'a' });
  await store.link('sess-B', '628222@c.us', 'inst', { conversationId: 42, contactId: 2, sourceId: 'b' });

  await store.unlinkByConversationId('sess-A', 42);

  assert.equal(await store.getByConversation(42, 'sess-A'), null);
  assert.deepEqual(await store.getByConversation(42, 'sess-B'), { sessionId: 'sess-B', chatId: '628222@c.us' });
});

test('a reverse mapping written before scoping still resolves', async () => {
  // Back-compat: data already on disk uses the unscoped key. It must keep resolving, otherwise an
  // upgrade silently breaks every existing conversation.
  const storage = fakeStorage();
  await storage.set('wa:77', { sessionId: 'sess-old', chatId: '628999@c.us' });
  const store = new MappingStore(storage, fakeMappings());

  assert.deepEqual(await store.getByConversation(77, 'sess-old'), { sessionId: 'sess-old', chatId: '628999@c.us' });
  assert.deepEqual(await store.getByConversation(77), { sessionId: 'sess-old', chatId: '628999@c.us' });
});

test('a conversation id claimed by two sessions never resolves without a scope', async () => {
  // A delivery that carries no session scope carries no information about which tenant it belongs to.
  // The unscoped reverse key was written on every link, so it held whichever session linked last and a
  // scope-less delivery resolved to that one — sending an agent reply for one customer to a different
  // customer's number. When two sessions claim the same conversation id there is no right answer to
  // guess, and dropping the delivery is the only safe one.
  const store = new MappingStore(fakeStorage(), fakeMappings());
  await store.link('sess-A', '628111@c.us', 'inst', { conversationId: 42, contactId: 1, sourceId: 'a' });
  await store.link('sess-B', '628222@c.us', 'inst', { conversationId: 42, contactId: 2, sourceId: 'b' });

  assert.equal(await store.getByConversation(42), null);
});

// ── Mapping storage is sharded, for the same reason the dedup markers are ────────────────────────────

test('mapping key count stays constant however many chats are relayed', async () => {
  // The host re-measures its quota on EVERY set by stat-ing every key of the plugin, synchronously, on
  // the gateway event loop. Three unpruned keys per chat made every write in the whole plugin O(chats),
  // and it only got worse the longer the install ran.
  const storage = fakeStorage();
  const store = new MappingStore(storage, fakeMappings());
  for (let i = 0; i < 400; i++) {
    await store.link('sess', `chat${i}@wa`, 'inst', { conversationId: i + 1, contactId: i, sourceId: `s${i}` });
  }
  const keys = await storage.list();
  const standalone = keys.filter(k => k.startsWith('conv:') || /^wa:/.test(k));
  assert.equal(standalone.length, 0, 'no per-chat standalone key survives a write');
  assert.ok(keys.length <= SEEN_SHARDS, `bucket count is bounded, got ${keys.length} keys for 400 chats`);
  // and every one of them still resolves
  assert.equal((await store.getByChat('sess', 'chat399@wa'))?.conversationId, 400);
  assert.deepEqual(await store.getByConversation(400, 'sess'), { sessionId: 'sess', chatId: 'chat399@wa' });
});

test('a mapping written by an earlier version still resolves, then is retired on its next write', async () => {
  // Upgrade path. Bucket entries are keyed by the SAME string the standalone key used, so there is no
  // migration pass: the same lookup finds either. Orphaning one would re-create that chat's Chatwoot
  // conversation and split its thread, which is the one outcome this must never have.
  const storage = fakeStorage();
  const store = new MappingStore(storage, fakeMappings());
  await storage.set('conv:sess:old@wa', { conversationId: 55, contactId: 9, sourceId: 'src' });

  assert.equal((await store.getByChat('sess', 'old@wa'))?.conversationId, 55, 'the pre-upgrade key resolves');

  await store.patch('sess', 'old@wa', { name: 'Budi' });
  const after = await store.getByChat('sess', 'old@wa');
  assert.equal(after?.conversationId, 55, 'the merge kept the existing document');
  assert.equal(after?.name, 'Budi');
  assert.equal(await storage.get('conv:sess:old@wa'), null, 'the standalone key is retired once rewritten');
});

test('unlinking removes both copies, so a retired standalone key cannot resurrect a mapping', async () => {
  const storage = fakeStorage();
  const store = new MappingStore(storage, fakeMappings());
  await storage.set('conv:sess:z@wa', { conversationId: 77, contactId: 1, sourceId: 's' });
  await store.unlinkByChatId('sess', 'z@wa');
  assert.equal(await store.getByChat('sess', 'z@wa'), null, 'the fallback must not read back an unlinked mapping');
});

test('two chats sharing a bucket do not erase each other', async () => {
  // A bucket is a read-modify-write shared across chats, and the per-chat locks cannot serialize it
  // because they are keyed by chat. Interleaving would drop one chat's mapping entirely.
  const storage = fakeStorage();
  const store = new MappingStore(storage, fakeMappings());
  const target = shardOf('conv:sess:a@wa');
  let partner = '';
  for (let i = 0; i < 100_000 && !partner; i++) {
    if (shardOf(`conv:sess:p${i}@wa`) === target) partner = `p${i}@wa`;
  }
  assert.ok(partner, 'expected a colliding chat id');

  await Promise.all([
    store.link('sess', 'a@wa', 'inst', { conversationId: 1, contactId: 1, sourceId: 'a' }),
    store.link('sess', partner, 'inst', { conversationId: 2, contactId: 2, sourceId: 'b' }),
  ]);

  assert.equal((await store.getByChat('sess', 'a@wa'))?.conversationId, 1);
  assert.equal((await store.getByChat('sess', partner))?.conversationId, 2);
});

test('an interrupted link leaves the chat unlinked, not half-linked', async () => {
  // The forward key is what ensureConversation short-circuits on, so it must be the LAST write. When
  // it went first, a worker restart or a storage quota rejection before the reverse write left a chat
  // that looked linked but resolved no conversation: inbound kept relaying while every agent reply
  // was dropped, permanently, because nothing re-links a chat whose forward key is present.
  const inner = fakeStorage();
  let failAfter = Infinity;
  const flaky: PluginStorage = {
    ...inner,
    set: async (k: string, v: unknown) => {
      if (failAfter-- <= 0) throw new Error('storage quota exceeded');
      return inner.set(k, v);
    },
  };
  const store = new MappingStore(flaky, fakeMappings());
  const link = { conversationId: 42, contactId: 7, sourceId: 's', name: 'n', backfillDone: false };

  // Fail on the very first write, then on each later one, and assert the same invariant every time:
  // a chat is never reported as linked unless its conversation also resolves back.
  for (let stopAt = 0; stopAt < 4; stopAt++) {
    failAfter = stopAt;
    await store.link('s1', 'c@wa', 'inst', link).catch(() => undefined);
    const fwd = await store.getByChat('s1', 'c@wa');
    if (fwd) {
      assert.ok(
        await store.getByConversation(42, 's1'),
        `link reported at write ${stopAt} but the conversation does not resolve back`,
      );
    }
  }

  // And a complete run links both ways.
  failAfter = Infinity;
  await store.link('s1', 'c@wa', 'inst', link);
  assert.equal((await store.getByChat('s1', 'c@wa'))?.conversationId, 42);
  assert.deepEqual(await store.getByConversation(42, 's1'), { sessionId: 's1', chatId: 'c@wa' });
});
