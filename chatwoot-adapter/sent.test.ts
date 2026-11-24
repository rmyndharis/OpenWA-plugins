import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleSent } from './sent.ts';
import { handleOutbound, type OutboundDeps } from './outbound.ts';
import type { InboundDeps } from './relay.ts';
import { KeyedAsyncLock } from './chat-lock.ts';
import { MappingStore } from './mapping-store.ts';
import type { IncomingMessage, PluginHandoverCapability, HandoverState, PluginMappingsCapability, PluginStorage, WebhookRequest } from '../types/openwa';
type HandoverKey = Parameters<PluginHandoverCapability['set']>[0];

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
    handover?: Record<string, unknown>;
    relayGroups?: boolean;
    relayMedia?: boolean;
    log?: (m: string, e?: unknown) => void;
  } = {},
) {
  let contacts = 0;
  let convs = 0;
  const posted: Array<{ id: number; c: string; type?: string }> = [];
  const seen = new Set<string>();
  const links = new Map<string, unknown>();
  const handovers: Array<[HandoverKey, HandoverState]> = [];
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
    log: over.log ?? (() => {}),
    handover: {
      set: async (k: HandoverKey, s: HandoverState) => void handovers.push([k, s]),
      ...over.handover,
    },
    // Both callbacks are required on InboundDeps; the cast would hide an omitted one.
    onInboundLost: () => {},
    onRelayError: () => {},
    onBackfillExhausted: () => {},
  } as unknown as InboundDeps;
  return { deps: d, counts: () => ({ contacts, convs }), posted, seen, handovers };
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

test('a 404 on an own-send relay mid-flight rebuilds the mapping via ensureConversation and posts once', async () => {
  // Operator deleted the Chatwoot conversation out-of-band: the cached conv id is dead. sent.ts's normal
  // posture is "relay-into-existing-only, never create" (mirrors the lid-migration no-split invariant),
  // but on a 404 specifically the dangling mapping has to be dropped and a fresh conversation must be
  // minted so the phone-composed delivery isn't silently lost. Symmetrical to inbound.ts's recovery.
  const unlinksChat: string[] = [];
  const unlinksConv: number[] = [];
  const posts: Array<{ id: number; type?: string }> = [];
  const searchCalls: string[] = [];
  let createConvCalls = 0;
  // Seed the stale mapping in a closure-scoped map so unlinkByChatId actually clears it (matching what
  // the real PluginStorage would do). Without this, a static getByChat stub would keep returning the
  // dead row after unlink and ensureConversation would short-circuit.
  const links = new Map<string, unknown>([
    ['sess:621@c.us', { conversationId: 55, contactId: 9, sourceId: 'oldSrc', name: 'x' }],
  ]);
  const { deps: d } = deps({
    store: {
      getByChat: async (_s: string, c: string) => links.get(`sess:${c}`) ?? null,
      link: async (_s: string, c: string, _i: string, l: unknown) => void links.set(`sess:${c}`, l),
      unlinkByChatId: async (_s: string, c: string) => { unlinksChat.push(c); links.delete(`sess:${c}`); },
      unlinkByConversationId: async (_s: string, conv: number) => void unlinksConv.push(conv),
    },
    client: {
      postText: async (id: number, _c: string, o?: { messageType?: string }) => {
        posts.push({ id, type: o?.messageType });
        if (id === 55) {
          const e = new Error(`Chatwoot POST .../conversations/${id}/messages -> 404`) as Error & { status?: number };
          e.status = 404;
          throw e;
        }
        return { id: 1 };
      },
      searchContact: async (identifier: string) => { searchCalls.push(identifier); return { id: 9, sourceId: 'newSrc' }; },
      findOpenConversation: async () => null, // no orphan — rebuild mints a fresh one
      createConversation: async () => { createConvCalls++; return 77; },
    },
  });
  await handleSent(d, 'sess', 'Engine', own);
  assert.deepEqual(unlinksChat, ['621@c.us'], 'forward mapping dropped under the canonical key');
  assert.deepEqual(unlinksConv, [55], 'scoped + legacy reverse mappings dropped');
  assert.deepEqual(posts, [
    { id: 55, type: 'outgoing' },
    { id: 77, type: 'outgoing' },
  ], 'first post 404s against the dead id; second post succeeds against the rebuilt one');
  assert.deepEqual(searchCalls, ['621@c.us'], 'ensureConversation re-resolves the contact by JID');
  assert.equal(createConvCalls, 1, 'one fresh Chatwoot conversation minted (ensureConversation -> createConversation)');
});

test('a 404 on the REBUILT own-send conversation logs failure (sent is at-most-once, no retry)', async () => {
  // Catastrophic case: the freshly-created conversation is also gone / Chatwoot is wedged. sent.ts is
  // at-most-once (unlike inbound, which enqueues for retry), so the failure must surface once on the log
  // and STOP — never enqueue, never re-create the contact a second time.
  const unlinksConv: number[] = [];
  const logCalls: string[] = [];
  let searchCalls = 0;
  let createConvCalls = 0;
  let postCalls = 0;
  const links = new Map<string, unknown>([
    ['sess:621@c.us', { conversationId: 55, contactId: 9, sourceId: 'x', name: 'x' }],
  ]);
  const { deps: d } = deps({
    store: {
      getByChat: async (_s: string, c: string) => links.get(`sess:${c}`) ?? null,
      link: async (_s: string, c: string, _i: string, l: unknown) => void links.set(`sess:${c}`, l),
      unlinkByChatId: async (_s: string, c: string) => void links.delete(`sess:${c}`),
      unlinkByConversationId: async (_s: string, conv: number) => void unlinksConv.push(conv),
    },
    client: {
      postText: async () => {
        postCalls++;
        const e = new Error('Chatwoot POST .../messages -> 404') as Error & { status?: number };
        e.status = 404;
        throw e;
      },
      searchContact: async () => { searchCalls++; return { id: 9, sourceId: 'src' }; },
      findOpenConversation: async () => null,
      createConversation: async () => { createConvCalls++; return 200; },
    },
    log: (m: string) => { logCalls.push(m); },
  });
  await handleSent(d, 'sess', 'Engine', { ...own, id: 'o-double-404' });
  assert.deepEqual(unlinksConv, [55], 'still unlinks the dead conv mapping once');
  assert.equal(postCalls, 2, 'two posts attempted (one against the dead id, one against the rebuilt one — both 404)');
  assert.equal(searchCalls, 1, 'one rebuild attempt only — no second createContact');
  assert.equal(createConvCalls, 1, 'one rebuild attempt only — no second createConversation');
  assert.ok(
    logCalls.some(l => /own-send 404-recovery failed/.test(l)),
    'logs WHY the rebuild itself failed (the second 404), with its own context',
  );
  assert.ok(
    logCalls.some(l => /own-send relay failed/.test(l)),
    'logs the unrecoverable own-send failure (sent does not retry)',
  );
});

test('an own-send rebuild creates the contact WITH the recipient phone derived from the chat id (#114)', async () => {
  // The 404-recovery test above stubs searchContact to a hit, so createContact never runs there and the
  // phone it would be given is asserted by nothing. This drives the create path: the number must come
  // from the canonical chat id, never from msg.senderPhone, which on an own send would be the account's
  // OWN number and which a plugin's hook payload never carries in the first place.
  const createArgs: Array<[string, string, string | undefined]> = [];
  const links = new Map<string, unknown>([
    ['sess:621@c.us', { conversationId: 55, contactId: 9, sourceId: 'oldSrc', name: 'x' }],
  ]);
  const { deps: d } = deps({
    store: {
      getByChat: async (_s: string, c: string) => links.get(`sess:${c}`) ?? null,
      link: async (_s: string, c: string, _i: string, l: unknown) => void links.set(`sess:${c}`, l),
      unlinkByChatId: async (_s: string, c: string) => void links.delete(`sess:${c}`),
      unlinkByConversationId: async () => {},
    },
    client: {
      postText: async (id: number) => {
        if (id === 55) {
          const e = new Error('Chatwoot POST -> 404') as Error & { status?: number };
          e.status = 404;
          throw e;
        }
        return { id: 1 };
      },
      searchContact: async () => null, // no existing contact: the create path runs
      createContact: async (identifier: string, name: string, phone?: string) => {
        createArgs.push([identifier, name, phone]);
        return { id: 9, sourceId: 'newSrc' };
      },
      findOpenConversation: async () => null,
      createConversation: async () => 77,
    },
  });
  await handleSent(d, 'sess', 'Engine', own);
  assert.deepEqual(createArgs, [['621@c.us', '621@c.us', '+621']]);
});

test('a 404 on a migrated (@lid) own-send unlinks the canonical @c.us mapping and rebuilds cleanly', async () => {
  const unlinksChat: string[] = [];
  const posts: number[] = [];
  const links = new Map<string, unknown>([
    ['sess:628@c.us', { conversationId: 55, contactId: 9, sourceId: 'oldSrc', name: 'Budi' }],
  ]);
  const { deps: d } = deps({
    engine: { canonicalChatId: async (_s: string, c: string) => (c === '628@lid' ? '628@c.us' : c) },
    store: {
      getByChat: async (_s: string, c: string) => links.get(`sess:${c}`) ?? null,
      link: async (_s: string, c: string, _i: string, l: unknown) => void links.set(`sess:${c}`, l),
      unlinkByChatId: async (_s: string, c: string) => { unlinksChat.push(c); links.delete(`sess:${c}`); },
      unlinkByConversationId: async () => {},
    },
    client: {
      postText: async (id: number) => {
        posts.push(id);
        if (id === 55) {
          const e = new Error('Chatwoot POST -> 404') as Error & { status?: number };
          e.status = 404;
          throw e;
        }
        return { id: 1 };
      },
      searchContact: async () => ({ id: 9, sourceId: 'newSrc' }),
      findOpenConversation: async () => null,
      createConversation: async () => 88,
    },
  });
  await handleSent(d, 'sess', 'Engine', { ...own, id: 'o-lid-404', chatId: '628@lid' });
  assert.ok(unlinksChat.includes('628@c.us'), 'must unlink the canonical key where the stale mapping lived');
  assert.deepEqual(posts, [55, 88], 'rebuilt conversation 88 is used instead of reusing stale 55');
});

function fakeSentStorage(): PluginStorage {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => (m.has(k) ? (m.get(k) as T) : null),
    set: async (k: string, v: unknown) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
    list: async () => [...m.keys()],
  };
}

test('sent 404 recovery hands the chat back to the bots when the deleted conversation held it, under the mapping key', async () => {
  const upsertKeys: HandoverKey[] = [];
  const mappings: PluginMappingsCapability = {
    upsert: async key => void upsertKeys.push(key),
    get: async () => null,
    getByProvider: async () => null,
  };
  const mappingStore = new MappingStore(fakeSentStorage(), mappings);
  await mappingStore.link('sess', '628@lid', 'inst', { conversationId: 55, contactId: 9, sourceId: 'oldSrc', name: 'Budi', handoverState: 'human' });

  const posts: number[] = [];
  const { deps: d, handovers } = deps({
    engine: { canonicalChatId: async (_s: string, c: string) => (c === '628@lid' ? '628@c.us' : c) },
    store: {
      getByChat: (s: string, c: string) => mappingStore.getByChat(s, c),
      getByConversation: (id: number) => mappingStore.getByConversation(id),
      link: (s: string, c: string, i: string, l: { conversationId: number; contactId: number; sourceId: string; name?: string }) =>
        mappingStore.link(s, c, i, l),
      hasSeen: (k: 'wa' | 'cw', id: string, scope?: string) => mappingStore.hasSeen(k, id, scope),
      markSeen: (k: 'wa' | 'cw', id: string, scope?: string) => mappingStore.markSeen(k, id, scope),
      unlinkByChatId: (s: string, c: string, id?: number) => mappingStore.unlinkByChatId(s, c, id),
      unlinkByConversationId: (s: string, id: number) => mappingStore.unlinkByConversationId(s, id),
    },
    client: {
      postText: async (id: number) => {
        posts.push(id);
        if (id === 55) throw Object.assign(new Error('Chatwoot POST -> 404'), { status: 404 });
        return { id: 1 };
      },
      searchContact: async () => ({ id: 9, sourceId: 'newSrc' }),
      findOpenConversation: async () => null,
      createConversation: async () => 88,
    },
  });
  await handleSent(d, 'sess', 'Engine', { ...own, id: 'o-404-create', chatId: '628@lid' });
  assert.deepEqual(posts, [55, 88]);
  assert.equal(handovers.length, 1);
  assert.equal(handovers[0][1], 'bot');
  assert.deepEqual(handovers[0][0], upsertKeys[upsertKeys.length - 1]);
  assert.deepEqual(handovers[0][0], { sessionId: 'sess', chatId: '628@lid', instanceId: 'inst' });
});

test('sent 404 recovery reusing an existing open conversation does not reset handover', async () => {
  const links = new Map<string, unknown>([
    ['sess:621@c.us', { conversationId: 55, contactId: 9, sourceId: 'oldSrc', name: 'Budi', handoverState: 'human' }],
  ]);
  const posts: number[] = [];
  const { deps: d, handovers } = deps({
    store: {
      getByChat: async (_s: string, c: string) => links.get(`sess:${c}`) ?? null,
      link: async (_s: string, c: string, _i: string, l: unknown) => void links.set(`sess:${c}`, l),
      unlinkByChatId: async (_s: string, c: string) => void links.delete(`sess:${c}`),
      unlinkByConversationId: async () => {},
    },
    client: {
      postText: async (id: number) => {
        posts.push(id);
        if (id === 55) throw Object.assign(new Error('Chatwoot POST -> 404'), { status: 404 });
        return { id: 1 };
      },
      searchContact: async () => ({ id: 9, sourceId: 'newSrc' }),
      findOpenConversation: async () => 88,
    },
  });
  await handleSent(d, 'sess', 'Engine', { ...own, id: 'o-404-reuse' });
  assert.deepEqual(posts, [55, 88]);
  assert.deepEqual(handovers, []);
});

// The recovery cases below share one shape: conversation 55 is gone, the contact still exists, and
// Chatwoot creates 88 in its place.
const rebuildingClient = (posts: number[]) => ({
  postText: async (id: number) => {
    posts.push(id);
    if (id === 55) throw Object.assign(new Error('Chatwoot POST -> 404'), { status: 404 });
    return { id: 1 };
  },
  searchContact: async () => ({ id: 9, sourceId: 'newSrc' }),
  findOpenConversation: async () => null,
  createConversation: async () => 88,
});
const overStore = (mappingStore: MappingStore) => ({
  getByChat: (s: string, c: string) => mappingStore.getByChat(s, c),
  link: (s: string, c: string, i: string, l: { conversationId: number; contactId: number; sourceId: string }) => mappingStore.link(s, c, i, l),
  hasSeen: (k: 'wa' | 'cw', id: string, scope?: string) => mappingStore.hasSeen(k, id, scope),
  markSeen: (k: 'wa' | 'cw', id: string, scope?: string) => mappingStore.markSeen(k, id, scope),
  unlinkByChatId: (s: string, c: string, id?: number) => mappingStore.unlinkByChatId(s, c, id),
  unlinkByConversationId: (s: string, id: number) => mappingStore.unlinkByConversationId(s, id),
});
const noMappings: PluginMappingsCapability = { upsert: async () => {}, get: async () => null, getByProvider: async () => null };

test('sent 404 recovery keeps the handover when the deleted conversation recorded no hold', async () => {
  const mappingStore = new MappingStore(fakeSentStorage(), noMappings);
  await mappingStore.link('sess', '621@c.us', 'inst', { conversationId: 55, contactId: 9, sourceId: 'oldSrc', name: 'Budi' });
  const posts: number[] = [];
  const { deps: d, handovers } = deps({ store: overStore(mappingStore), client: rebuildingClient(posts) });
  await handleSent(d, 'sess', 'Engine', { ...own, id: 'o-404-unheld' });
  assert.deepEqual(posts, [55, 88]);
  assert.deepEqual(handovers, []);
});

test('sent 404 recovery relays into the live conversation of the contact other id form instead of creating one', async () => {
  // One contact, split into a lid thread (60, deleted here) and a phone thread (55, live and held).
  const mappingStore = new MappingStore(fakeSentStorage(), noMappings);
  await mappingStore.link('sess', '123@lid', 'inst', { conversationId: 60, contactId: 10, sourceId: 'lidSrc', handoverState: 'human' });
  await mappingStore.link('sess', '621@c.us', 'inst', { conversationId: 55, contactId: 9, sourceId: 'pnSrc', handoverState: 'human' });
  const posts: number[] = [];
  let created = 0;
  const { deps: d, handovers } = deps({
    engine: { canonicalChatId: async (_s: string, c: string) => (c === '123@lid' ? '621@c.us' : c) },
    store: overStore(mappingStore),
    client: {
      postText: async (id: number) => {
        posts.push(id);
        if (id === 60) throw Object.assign(new Error('Chatwoot POST -> 404'), { status: 404 });
        return { id: 1 };
      },
      searchContact: async () => ({ id: 10, sourceId: 'lidSrc' }),
      findOpenConversation: async () => null,
      createConversation: async () => { created++; return 88; },
    },
  });
  await handleSent(d, 'sess', 'Engine', { ...own, id: 'o-404-twin', chatId: '123@lid' });
  assert.deepEqual(posts, [60, 55]);
  assert.equal(created, 0);
  assert.deepEqual(handovers, []);
  assert.equal(await mappingStore.getByChat('sess', '123@lid'), null);
});

test('sent 404 recovery drops both id forms linked to the deleted conversation and rebuilds once', async () => {
  // A migrated contact whose lid was adopted onto its phone thread: two links, one conversation.
  const mappingStore = new MappingStore(fakeSentStorage(), noMappings);
  await mappingStore.link('sess', '621@c.us', 'inst', { conversationId: 55, contactId: 9, sourceId: 'src', handoverState: 'human' });
  await mappingStore.link('sess', '123@lid', 'inst', { conversationId: 55, contactId: 9, sourceId: 'src' });
  const posts: number[] = [];
  const { deps: d, handovers } = deps({
    engine: { canonicalChatId: async (_s: string, c: string) => (c === '123@lid' ? '621@c.us' : c) },
    store: overStore(mappingStore),
    client: rebuildingClient(posts),
  });
  await handleSent(d, 'sess', 'Engine', { ...own, id: 'o-404-both', chatId: '123@lid' });
  assert.deepEqual(posts, [55, 88]);
  assert.equal(await mappingStore.getByChat('sess', '621@c.us'), null);
  assert.equal((await mappingStore.getByChat('sess', '123@lid'))?.conversationId, 88);
  // The hold was recorded on the other form's link; it belonged to the same deleted conversation.
  assert.deepEqual(handovers.map(h => h[1]), ['bot']);
});

test('sent 404 recovery leaves a link another recovery already moved to a live conversation', async () => {
  const mappingStore = new MappingStore(fakeSentStorage(), noMappings);
  await mappingStore.link('sess', '628@lid', 'inst', { conversationId: 55, contactId: 9, sourceId: 'src', handoverState: 'human' });
  const posts: number[] = [];
  let created = 0;
  const { deps: d, handovers } = deps({
    engine: { canonicalChatId: async (_s: string, c: string) => (c === '628@lid' ? '628@c.us' : c) },
    store: overStore(mappingStore),
    client: {
      postText: async (id: number) => {
        posts.push(id);
        if (id !== 55) return { id: 1 };
        // While this request was out, an inbound recovery relinked the chat and an agent took the result.
        await mappingStore.link('sess', '628@lid', 'inst', { conversationId: 88, contactId: 9, sourceId: 'new', handoverState: 'human', handoverAt: 2000 });
        throw Object.assign(new Error('Chatwoot POST -> 404'), { status: 404 });
      },
      searchContact: async () => ({ id: 9, sourceId: 'new' }),
      findOpenConversation: async () => null,
      createConversation: async () => { created++; return 99; },
    },
  });
  await handleSent(d, 'sess', 'Engine', { ...own, id: 'o-404-moved', chatId: '628@lid' });
  assert.deepEqual(posts, [55, 88]);
  assert.equal(created, 0);
  assert.deepEqual(handovers, []);
  const link = await mappingStore.getByChat('sess', '628@lid');
  assert.deepEqual([link?.conversationId, link?.handoverState, link?.handoverAt], [88, 'human', 2000]);
});

test('sent 404 recovery yields to a handover webhook that reached the new conversation first', async () => {
  const mappingStore = new MappingStore(fakeSentStorage(), noMappings);
  await mappingStore.link('sess', '628@lid', 'inst', { conversationId: 55, contactId: 9, sourceId: 'oldSrc', handoverState: 'human' });
  const posts: number[] = [];
  const { deps: d, handovers } = deps({
    engine: { canonicalChatId: async (_s: string, c: string) => (c === '628@lid' ? '628@c.us' : c) },
    client: rebuildingClient(posts),
  });
  const outbound = {
    lock: d.lock, handover: d.handover, engine: d.engine, store: mappingStore, mappings: noMappings,
    conversations: { send: async () => ({}) }, inboxId: 7, log: () => {},
  } as unknown as OutboundDeps;
  // Chatwoot assigns the new conversation at once. Its webhook takes the mapping key lock, which the
  // own-send does not hold (it holds the canonical one), so it lands between the link and the reset.
  const assigned = JSON.stringify({
    event: 'conversation_updated', id: 88, inbox_id: 7, meta: { assignee: { id: 4, type: 'user' } },
    changed_attributes: [
      { assignee_id: { previous_value: null, current_value: 4 } },
      { updated_at: { previous_value: '2026-11-14T10:00:00.000Z', current_value: '2026-11-14T10:00:01.000Z' } },
    ],
  });
  (d as unknown as { store: Record<string, unknown> }).store = {
    ...overStore(mappingStore),
    link: async (s: string, c: string, i: string, l: { conversationId: number; contactId: number; sourceId: string }) => {
      await mappingStore.link(s, c, i, l);
      await handleOutbound(outbound, { rawBody: assigned, sessionId: 'sess' } as WebhookRequest);
    },
  };
  await handleSent(d, 'sess', 'Engine', { ...own, id: 'o-404-assigned', chatId: '628@lid' });
  assert.deepEqual(posts, [55, 88]);
  assert.deepEqual(handovers.map(h => h[1]), ['human']);
  assert.equal((await mappingStore.getByChat('sess', '628@lid'))?.handoverState, 'human');
});

test('sent 404 recovery resets handover under the mapping key lock, not the canonical one it holds', async () => {
  const mappingStore = new MappingStore(fakeSentStorage(), noMappings);
  await mappingStore.link('sess', '628@lid', 'inst', { conversationId: 55, contactId: 9, sourceId: 'oldSrc', name: 'Budi', handoverState: 'human' });

  let rebuilt!: () => void;
  const rebuiltSignal = new Promise<void>(resolve => (rebuilt = resolve));
  const { deps: d, handovers } = deps({
    engine: { canonicalChatId: async (_s: string, c: string) => (c === '628@lid' ? '628@c.us' : c) },
    store: {
      getByChat: (s: string, c: string) => mappingStore.getByChat(s, c),
      link: async (s: string, c: string, i: string, l: { conversationId: number; contactId: number; sourceId: string }) => {
        await mappingStore.link(s, c, i, l);
        rebuilt();
      },
      hasSeen: (k: 'wa' | 'cw', id: string, scope?: string) => mappingStore.hasSeen(k, id, scope),
      markSeen: (k: 'wa' | 'cw', id: string, scope?: string) => mappingStore.markSeen(k, id, scope),
      unlinkByChatId: (s: string, c: string, id?: number) => mappingStore.unlinkByChatId(s, c, id),
      unlinkByConversationId: (s: string, id: number) => mappingStore.unlinkByConversationId(s, id),
    },
    client: {
      postText: async (id: number) => {
        if (id === 55) throw Object.assign(new Error('Chatwoot POST -> 404'), { status: 404 });
        return { id: 1 };
      },
      searchContact: async () => ({ id: 9, sourceId: 'newSrc' }),
      findOpenConversation: async () => null,
      createConversation: async () => 88,
    },
  });
  // A handover webhook for this chat holds the lock on the mapping's own chat id.
  let release!: () => void;
  const webhook = d.lock.run('sess:628@lid', () => new Promise<void>(resolve => (release = resolve)));
  const run = handleSent(d, 'sess', 'Engine', { ...own, id: 'o-404-lock', chatId: '628@lid' });
  await rebuiltSignal;
  // Everything after the link is in-memory, so two event-loop turns let an unlocked reset run.
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(handovers, []);
  release();
  await webhook;
  await run;
  assert.deepEqual(handovers.map(h => h[1]), ['bot']);
});

test('falls back to msg.chatId when engine.canonicalChatId rejects', async () => {
  const d = deps({
    engine: {
      canonicalChatId: async () => {
        throw new Error('engine unavailable');
      },
    },
  });
  await d.deps.store.link('sess', '628@c.us', 'sess', { conversationId: 12, contactId: 1, sourceId: 's' });
  await assert.doesNotReject(() => handleSent(d.deps, 'sess', 'Engine', { ...own, id: 'o-err', chatId: '628@c.us' }));
  assert.equal(d.posted.length, 1);
});
