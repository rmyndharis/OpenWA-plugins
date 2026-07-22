import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleSent } from './sent.ts';
import type { InboundDeps } from './relay.ts';
import { KeyedAsyncLock } from './chat-lock.ts';
import type { IncomingMessage } from '../types/openwa';

// A fromMe send composed on a linked phone / the OpenWA API (chatId = the recipient).
const own = {
  id: 'o1', from: 'me@c.us', to: '621@c.us', chatId: '621@c.us', body: 'from my phone', type: 'chat',
  timestamp: 0, fromMe: true, isGroup: false,
} as IncomingMessage;

function deps(
  over: {
    client?: Record<string, unknown>;
    store?: Record<string, unknown>;
    engine?: Record<string, unknown>;
    relayGroups?: boolean;
    relayMedia?: boolean;
  } = {},
) {
  let contacts = 0;
  let convs = 0;
  const posted: Array<{ id: number; c: string; type?: string }> = [];
  const seen = new Set<string>();
  const links = new Map<string, unknown>();
  const client = {
    searchContact: async () => null,
    createContact: async () => { contacts++; return { id: 9, sourceId: 'src' }; },
    findOpenConversation: async () => null,
    createConversation: async () => { convs++; return 55; },
    postText: async (id: number, c: string, o?: { messageType?: string }) => { posted.push({ id, c, type: o?.messageType }); return { id: 1 }; },
    postMedia: async (id: number, c: string, _f: unknown, o?: { messageType?: string }) => { posted.push({ id, c, type: o?.messageType }); return { id: 2 }; },
    ...over.client,
  };
  const store = {
    getByChat: async (s: string, c: string) => links.get(`${s}:${c}`) ?? null,
    link: async (s: string, c: string, _i: string, l: unknown) => void links.set(`${s}:${c}`, l),
    hasSeen: async (_k: string, id: string, scope?: string) => seen.has(`${scope ?? ''}:${id}`),
    markSeen: async (_k: string, id: string, scope?: string) => void seen.add(`${scope ?? ''}:${id}`),
    ...over.store,
  };
  // Default: identity canonicalization (@lid resolution tested explicitly below).
  const engine = { canonicalChatId: async (_s: string, c: string) => c, ...over.engine };
  const d = {
    lock: new KeyedAsyncLock(), client, store, engine, instanceId: 'inst',
    relayGroups: over.relayGroups ?? true, relayMedia: over.relayMedia ?? true, backfillLimit: 0, backfillAllOnce: false,
    log: () => {},
  } as unknown as InboundDeps;
  return { deps: d, counts: () => ({ contacts, convs }), posted, seen };
}

test('an own send to an UNMAPPED chat is dropped — relay-into-existing only, never creates (no split)', async () => {
  const { deps: d, posted, counts } = deps(); // default store has no mapping for this chat
  await handleSent(d, 'sess', 'Engine', own);
  assert.equal(posted.length, 0);
  assert.deepEqual(counts(), { contacts: 0, convs: 0 });
});

test('reuses an existing mapped conversation and does NOT create a contact', async () => {
  const { deps: d, posted, counts } = deps({
    store: { getByChat: async () => ({ conversationId: 77, contactId: 9, sourceId: 'src', name: 'Budi' }) },
  });
  await handleSent(d, 'sess', 'Engine', own);
  assert.deepEqual(posted, [{ id: 77, c: 'from my phone', type: 'outgoing' }]);
  assert.deepEqual(counts(), { contacts: 0, convs: 0 });
});

test('skips when the WA id is already seen — an agent reply the adapter itself sent does not echo', async () => {
  const { deps: d, posted } = deps();
  await d.store.markSeen('wa', 'o1', 'sess'); // outbound.relay marked it when it sent the agent reply
  await handleSent(d, 'sess', 'Engine', own);
  assert.equal(posted.length, 0);
});

test('is at-most-once: the same send processed twice posts once', async () => {
  const { deps: d, posted } = deps({
    store: { getByChat: async () => ({ conversationId: 55, contactId: 9, sourceId: 'src', name: 'x' }) },
  });
  await handleSent(d, 'sess', 'Engine', own);
  await handleSent(d, 'sess', 'Engine', own);
  assert.equal(posted.length, 1);
});

test('relays own media as an OUTGOING attachment when relayMedia (postMedia, not postText)', async () => {
  let mediaOpts: { messageType?: string } | undefined;
  const { deps: d, posted } = deps({
    store: { getByChat: async () => ({ conversationId: 55, contactId: 9, sourceId: 'src', name: 'x' }) },
    client: { postMedia: async (_id: number, _c: string, _f: unknown, o: { messageType?: string }) => { mediaOpts = o; return { id: 2 }; } },
  });
  const media = { ...own, id: 'o2', body: '', type: 'image', media: { mimetype: 'image/jpeg', data: 'AAA' } } as IncomingMessage;
  await handleSent(d, 'sess', 'Engine', media);
  assert.equal(mediaOpts?.messageType, 'outgoing');
  assert.equal(posted.length, 0); // postText path was not taken
});

test('a phone-composed location (no coords in the message:sent payload) posts a location placeholder, not an empty bubble', async () => {
  const { deps: d, posted } = deps({
    store: { getByChat: async () => ({ conversationId: 55, contactId: 9, sourceId: 'src', name: 'x' }) },
  });
  const loc = { ...own, id: 'o3', body: '', type: 'location' } as IncomingMessage; // no msg.location
  await handleSent(d, 'sess', 'Engine', loc);
  assert.deepEqual(posted, [{ id: 55, c: '📍 Location', type: 'outgoing' }]);
});

test('a caption-less own media send (no media object in the message:sent payload) posts a type placeholder, not an empty bubble', async () => {
  const { deps: d, posted } = deps({
    store: { getByChat: async () => ({ conversationId: 55, contactId: 9, sourceId: 'src', name: 'x' }) },
  });
  // The real wwjs message:sent shape for a phone photo without a caption: type only, no media, no body.
  const photo = { ...own, id: 'o9', body: '', type: 'image' } as IncomingMessage;
  await handleSent(d, 'sess', 'Engine', photo);
  assert.deepEqual(posted, [{ id: 55, c: '📷 Photo', type: 'outgoing' }]);
});

test('a migrated contact (@lid send, @c.us-keyed mapping) relays into the EXISTING conversation via dual-lookup, no split', async () => {
  // The recipient migrated to @lid: this message:sent carries chatId=@lid, but the mapping was created
  // under @c.us. Without the canonical fallback lookup this would create a duplicate @lid conversation.
  const lidMsg = { ...own, id: 'o7', chatId: '628@lid' } as IncomingMessage;
  const byChat = new Map<string, unknown>([
    ['sess:628@c.us', { conversationId: 77, contactId: 9, sourceId: 'src', name: 'Budi' }],
  ]);
  const { deps: d, posted, counts } = deps({
    engine: { canonicalChatId: async (_s: string, c: string) => (c === '628@lid' ? '628@c.us' : c) },
    store: { getByChat: async (_s: string, c: string) => byChat.get(`sess:${c}`) ?? null },
  });
  await handleSent(d, 'sess', 'Engine', lidMsg);
  assert.deepEqual(posted, [{ id: 77, c: 'from my phone', type: 'outgoing' }]);
  assert.deepEqual(counts(), { contacts: 0, convs: 0 }); // found via the canonical lookup — nothing created
});

test('an agent reply to a migrated (@lid) contact does not echo: the id-keyed marker is still seen', async () => {
  const lidMsg = { ...own, id: 'o8', chatId: '628@lid' } as IncomingMessage;
  const { deps: d, posted } = deps({
    engine: { canonicalChatId: async (_s: string, c: string) => (c === '628@lid' ? '628@c.us' : c) },
  });
  await d.store.markSeen('wa', 'o8', 'sess'); // outbound.relay marked the WA id it sent (chatId-independent)
  await handleSent(d, 'sess', 'Engine', lidMsg);
  assert.equal(posted.length, 0);
});

test('cold lid->phone table (canonicalChatId cannot resolve @lid) DROPS the own send instead of splitting the @c.us conversation', async () => {
  // Finding 1: on wwjs the lid->phone table is often cold, so canonicalChatId(@lid) returns @lid. The
  // @c.us-keyed mapping is then invisible — but creating a @lid conversation here would split the thread.
  const lidMsg = { ...own, id: 'o10', chatId: '628@lid' } as IncomingMessage;
  const byChat = new Map<string, unknown>([
    ['sess:628@c.us', { conversationId: 77, contactId: 9, sourceId: 'src', name: 'Budi' }],
  ]);
  const { deps: d, posted, counts } = deps({
    engine: { canonicalChatId: async (_s: string, c: string) => c }, // cold: @lid stays @lid
    store: { getByChat: async (_s: string, c: string) => byChat.get(`sess:${c}`) ?? null },
  });
  await handleSent(d, 'sess', 'Engine', lidMsg);
  assert.equal(posted.length, 0); // raw @lid misses; canonical==raw so no 2nd lookup → drop
  assert.deepEqual(counts(), { contacts: 0, convs: 0 }); // crucially: NO duplicate conversation created
});

test('an own send with no engine id is still mirrored, and cannot silence later ones', async () => {
  // An engine that cannot read an id back reports the empty sentinel (Baileys' `?? ''`), which the
  // codebase already treats as a real hazard elsewhere (outbound.ts logs it; the gateway's unique index
  // exempts NULL because '' would collide). Here it collapsed every id-less own send onto ONE dedup key:
  // the first marked `seen:<sess>:wa:`, and every later one was skipped as "already seen" for the
  // marker's whole 3-day life — silently, and only for the operator's Chatwoot thread.
  //
  // An id-less message cannot be de-duplicated by definition, so the choice is which way to fail. A
  // duplicate in the helpdesk is visible and harmless; a missing customer message is neither.
  const { deps: d, posted } = deps({
    store: { getByChat: async () => ({ conversationId: 55, contactId: 9, sourceId: 'src', name: 'x' }) },
  });
  const first = { ...own, id: '' } as IncomingMessage;
  const second = { ...own, id: '', body: 'a different message' } as IncomingMessage;

  await handleSent(d, 'sess', 'Engine', first);
  await handleSent(d, 'sess', 'Engine', second);

  assert.equal(posted.length, 2, 'the second id-less own send was swallowed by the first one\'s marker');
  assert.deepEqual(
    posted.map(p => p.c),
    ['from my phone', 'a different message'],
  );
});

test('respects relayGroups=false for a fromMe group send', async () => {
  const { deps: d, posted } = deps({ relayGroups: false });
  const grp = { ...own, id: 'o4', chatId: '12@g.us', isGroup: true } as IncomingMessage;
  await handleSent(d, 'sess', 'Engine', grp);
  assert.equal(posted.length, 0);
});

test('ignores a non-Engine source (defensive)', async () => {
  const { deps: d, posted } = deps();
  await handleSent(d, 'sess', 'API', own);
  assert.equal(posted.length, 0);
});
