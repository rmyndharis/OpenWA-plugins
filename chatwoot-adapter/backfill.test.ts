import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backfillHistory, backfillAllChats } from './backfill.ts';
import { KeyedAsyncLock } from './chat-lock.ts';
import type { InboundDeps } from './relay.ts';
import type { IncomingMessage } from '../types/openwa';

// Capture what relayMessage posts by observing the client the shared relay calls (text path only here;
// media rendering is covered by the inbound tests).
function makeDeps(
  over: {
    engine?: Record<string, unknown>;
    store?: Record<string, unknown>;
    relayGroups?: boolean;
    backfillLimit?: number;
  } = {},
) {
  const posts: Array<{ conversationId: number; type: string; body: string }> = [];
  const seen = new Set<string>();
  const client = {
    searchContact: async () => null,
    createContact: async () => ({ id: 9, sourceId: 'src' }),
    findOpenConversation: async () => null,
    createConversation: async () => 55,
    postText: async (conversationId: number, body: string, o: { messageType?: string }) => {
      posts.push({ conversationId, type: o?.messageType ?? 'incoming', body });
      return { id: 1 };
    },
    postMedia: async () => ({ id: 2 }),
    updateContact: async () => {},
  };
  const store = {
    hasSeen: async (_k: string, id: string) => seen.has(id),
    markSeen: async (_k: string, id: string) => void seen.add(id),
    getByChat: async () => null,
    link: async () => {},
    patch: async () => {},
    isBulkBackfilled: async () => false,
    setBulkBackfilled: async () => {},
    ...over.store,
  };
  const deps = {
    lock: new KeyedAsyncLock(),
    client,
    store,
    engine: { getChatHistory: async () => [], getChats: async () => [], ...over.engine },
    instanceId: 'inst',
    relayGroups: over.relayGroups ?? true,
    relayMedia: true,
    backfillLimit: over.backfillLimit ?? 20,
    backfillAllOnce: false,
    log: () => {},
  } as unknown as InboundDeps;
  return { deps, posts };
}

const hist = (id: string, ts: number, fromMe: boolean, body: string): IncomingMessage =>
  ({ id, from: 'x', to: 'y', chatId: 'c@c.us', body, type: 'chat', timestamp: ts, fromMe, isGroup: false }) as IncomingMessage;

test('backfillHistory posts oldest→newest with fromMe as outgoing (#609)', async () => {
  const history = [hist('m3', 30, false, 'third'), hist('m1', 10, true, 'first'), hist('m2', 20, false, 'second')];
  const { deps, posts } = makeDeps({ engine: { getChatHistory: async () => history } });
  await backfillHistory(deps, 'sess', 'c@c.us', 55);
  assert.deepEqual(posts, [
    { conversationId: 55, type: 'outgoing', body: 'first' }, // fromMe, oldest first
    { conversationId: 55, type: 'incoming', body: 'second' },
    { conversationId: 55, type: 'incoming', body: 'third' },
  ]);
});

test('backfillHistory skips messages already seen (dedup with the live path)', async () => {
  const seen = new Set(['m1']);
  const history = [hist('m1', 10, false, 'dup'), hist('m2', 20, false, 'new')];
  const { deps, posts } = makeDeps({
    engine: { getChatHistory: async () => history },
    store: {
      hasSeen: async (_k: string, id: string) => seen.has(id),
      markSeen: async (_k: string, id: string) => void seen.add(id),
    },
  });
  await backfillHistory(deps, 'sess', 'c@c.us', 55);
  assert.deepEqual(posts.map(p => p.body), ['new']);
});

test('backfillHistory swallows a getChatHistory failure (best-effort)', async () => {
  const { deps, posts } = makeDeps({
    engine: {
      getChatHistory: async () => {
        throw new Error('engine down');
      },
    },
  });
  await backfillHistory(deps, 'sess', 'c@c.us', 55); // must not throw
  assert.equal(posts.length, 0);
});

test('backfillAllChats sweeps each chat once, skips groups when relayGroups is off, survives a failure (#609)', async () => {
  const chats = [
    { id: 'a@c.us', name: 'A', isGroup: false, unreadCount: 0, timestamp: 1 },
    { id: 'g@g.us', name: 'G', isGroup: true, unreadCount: 0, timestamp: 2 },
    { id: 'b@c.us', name: 'B', isGroup: false, unreadCount: 0, timestamp: 3 },
  ];
  const historyByChat: Record<string, IncomingMessage[]> = {
    'a@c.us': [{ ...hist('a1', 10, false, 'from A'), chatId: 'a@c.us' }],
    'b@c.us': [{ ...hist('b1', 10, false, 'from B'), chatId: 'b@c.us' }],
  };
  let bulkDone = false;
  const { deps, posts } = makeDeps({
    relayGroups: false, // the group chat must be skipped
    engine: {
      getChats: async () => chats,
      getChatHistory: async (_s: string, chatId: string) => historyByChat[chatId] ?? [],
    },
    store: {
      hasSeen: async () => false,
      markSeen: async () => {},
      getByChat: async () => null,
      link: async () => {},
      isBulkBackfilled: async () => bulkDone,
      setBulkBackfilled: async () => {
        bulkDone = true;
      },
    },
  });
  await backfillAllChats(deps, 'sessBulk');
  assert.deepEqual(
    posts.map(p => p.body).sort(),
    ['from A', 'from B'], // group skipped
  );
  assert.equal(bulkDone, true);
  // second call is a no-op once the durable marker is set
  const before = posts.length;
  await backfillAllChats(deps, 'sessBulk');
  assert.equal(posts.length, before);
});
