import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleInbound, type InboundDeps } from './inbound.ts';
import { KeyedAsyncLock } from './chat-lock.ts';
import type { IncomingMessage } from '../types/openwa';

const msg = {
  id: 'm1', from: '621@c.us', to: 'y', chatId: '621@c.us', body: 'hello', type: 'chat',
  timestamp: 0, fromMe: false, isGroup: false, senderPhone: '+621', contact: { pushName: 'Budi' },
} as IncomingMessage;

function deps(
  over: {
    client?: Record<string, unknown>;
    store?: Record<string, unknown>;
    engine?: Record<string, unknown>;
    log?: (m: string, e?: unknown) => void;
  } = {},
) {
  let contacts = 0;
  let convs = 0;
  const posted: Array<{ id: number; c: string }> = [];
  const store = new Map<string, unknown>();
  const client = {
    searchContact: async () => null,
    createContact: async () => { contacts++; return { id: 9, sourceId: 'src' }; },
    findOpenConversation: async () => null,
    createConversation: async () => { convs++; return 55; },
    postText: async (id: number, c: string) => { posted.push({ id, c }); return { id: 1 }; },
    postMedia: async () => ({ id: 2 }),
    ...over.client,
  };
  // unlinkByChatId + unlinkByConversationId default to actual map deletes against the SAME backing `store`
  // the default getByChat / link use, so a recovery path that calls one of them actually clears the
  // cached row (matches the real PluginStorage's semantics). Tests that need to introspect the call can
  // still override them.
  const mapping = {
    getByChat: async (s: string, c: string) => store.get(`${s}:${c}`) ?? null,
    getByConversation: async () => null,
    link: async (s: string, c: string, _i: string, l: unknown) => void store.set(`${s}:${c}`, l),
    hasSeen: async () => false,
    markSeen: async () => {},
    unlinkByChatId: async (s: string, c: string) => void store.delete(`${s}:${c}`),
    unlinkByConversationId: async () => {},
    ...over.store,
  };
  // Default: identity canonicalization (@lid resolution exercised explicitly below).
  const engine = { canonicalChatId: async (_s: string, c: string) => c, ...over.engine };
  const d = {
    lock: new KeyedAsyncLock(), client, store: mapping, engine, instanceId: 'inst',
    relayGroups: true, relayMedia: true, log: over.log ?? (() => {}),
  } as unknown as InboundDeps;
  return { deps: d, counts: () => ({ contacts, convs }), posted };
}

test('a migrated contact (@lid inbound, @c.us-keyed conversation) reuses the EXISTING conversation via dual-lookup, no split', async () => {
  const { deps: d, posted, counts } = deps({
    engine: { canonicalChatId: async (_s: string, c: string) => (c === '621@lid' ? '621@c.us' : c) },
    store: {
      getByChat: async (_s: string, c: string) =>
        c === '621@c.us' ? { conversationId: 77, contactId: 9, sourceId: 'src', name: 'Budi' } : null,
    },
  });
  const lidMsg = { ...msg, id: 'x1', chatId: '621@lid' } as IncomingMessage;
  await handleInbound(d, 'sess', 'Engine', lidMsg);
  assert.deepEqual(posted, [{ id: 77, c: 'hello' }]); // posted into the existing @c.us conversation
  assert.deepEqual(counts(), { contacts: 0, convs: 0 }); // no duplicate conversation created
});

test('cold lid (@lid unresolvable) still creates — documented residual closed by RESOLVE_LID_TO_PHONE', async () => {
  const { deps: d, posted, counts } = deps({
    engine: { canonicalChatId: async (_s: string, c: string) => c }, // cold: @lid stays @lid
  });
  const lidMsg = { ...msg, id: 'x2', chatId: '621@lid' } as IncomingMessage;
  await handleInbound(d, 'sess', 'Engine', lidMsg);
  assert.equal(posted.length, 1);
  assert.deepEqual(counts(), { contacts: 1, convs: 1 }); // no @c.us mapping resolvable while cold → creates
});

test('canonicalChatId throwing (session down) falls back to the raw id and still relays — never drops the message', async () => {
  const { deps: d, posted } = deps({
    engine: { canonicalChatId: async () => { throw new Error('session not active'); } },
  });
  await handleInbound(d, 'sess', 'Engine', msg);
  assert.equal(posted.length, 1); // relayed via the raw fallback, not lost before markSeen/enqueue
});

test('reusing a @c.us mapping via @lid dual-lookup patches the name under the @c.us key (no repeated updateContact)', async () => {
  const patches: Array<[string, { name?: string }]> = [];
  const renames: string[] = [];
  const { deps: d } = deps({
    engine: { canonicalChatId: async (_s: string, c: string) => (c === '621@lid' ? '621@c.us' : c) },
    store: {
      getByChat: async (_s: string, c: string) =>
        c === '621@c.us' ? { conversationId: 77, contactId: 9, sourceId: 'src', name: 'Old Name' } : null,
      patch: async (_s: string, c: string, p: { name?: string }) => void patches.push([c, p]),
    },
    client: { updateContact: async (_id: number, name: string) => void renames.push(name) },
  });
  const lidMsg = { ...msg, id: 'x3', chatId: '621@lid', contact: { pushName: 'Budi' } } as IncomingMessage;
  await handleInbound(d, 'sess', 'Engine', lidMsg);
  assert.deepEqual(renames, ['Budi']); // the @c.us contact is renamed correctly
  assert.deepEqual(patches, [['621@c.us', { name: 'Budi' }]]); // and the name is recorded under the @c.us key
});

test('a failed relay queues the message for retry (at-least-once), not dropped', async () => {
  const enqueued: string[] = [];
  const { deps: d } = deps({
    client: { postText: async () => { throw new Error('chatwoot 503'); } },
    store: { enqueueRetry: async (e: { msg: { id: string } }) => void enqueued.push(e.msg.id) },
  });
  await handleInbound(d, 'sess', 'Engine', msg);
  assert.deepEqual(enqueued, ['m1']); // conversation resolved, post failed → queued (not silently dropped)
});

test('creates contact + conversation and posts an incoming message', async () => {
  const { deps: d, posted, counts } = deps();
  await handleInbound(d, 'sess', 'Engine', msg);
  assert.deepEqual(posted, [{ id: 55, c: 'hello' }]);
  assert.deepEqual(counts(), { contacts: 1, convs: 1 });
});

test('two concurrent inbounds for a NEW chat make exactly ONE contact + conversation', async () => {
  const { deps: d, counts } = deps();
  await Promise.all([
    handleInbound(d, 'sess', 'Engine', msg),
    handleInbound(d, 'sess', 'Engine', { ...msg, id: 'm2' }),
  ]);
  assert.deepEqual(counts(), { contacts: 1, convs: 1 }); // per-chat lock + re-read prevents cold-start dupes
});

test('skips fromMe and is idempotent (already seen → no post)', async () => {
  const { deps: d, posted } = deps({ store: { hasSeen: async () => true } });
  await handleInbound(d, 'sess', 'Engine', msg);
  await handleInbound(d, 'sess', 'Engine', { ...msg, fromMe: true });
  assert.equal(posted.length, 0);
});

test('forwards the quote context (source_id + in_reply_to_external_id) on a reply (#606)', async () => {
  let opts: unknown;
  const { deps: d } = deps({
    client: { postText: async (_id: number, _c: string, o: unknown) => { opts = o; return { id: 1 }; } },
  });
  const reply = { ...msg, id: 'r1', quotedMessage: { id: 'orig', body: 'earlier' } } as IncomingMessage;
  await handleInbound(d, 'sess', 'Engine', reply);
  assert.deepEqual(opts, { sourceId: 'r1', inReplyToExternalId: 'orig', messageType: 'incoming' });
});

test('relays an inbound voice note as a Chatwoot voice message (#607)', async () => {
  let call: { file: { filename: string; contentType: string }; o: { isVoiceMessage?: boolean; sourceId?: string } } | undefined;
  const { deps: d } = deps({
    client: {
      postMedia: async (_id: number, _c: string, file: never, o: never) => { call = { file, o }; return { id: 2 }; },
    },
  });
  const voice = { ...msg, id: 'v1', body: '', type: 'voice', media: { mimetype: 'audio/ogg; codecs=opus', data: 'AAA' } } as IncomingMessage;
  await handleInbound(d, 'sess', 'Engine', voice);
  assert.equal(call!.file.filename, 'voice.ogg');
  assert.equal(call!.o.isVoiceMessage, true);
  assert.equal(call!.o.sourceId, 'v1');
});

test('a voice note with an omitted blob posts a placeholder, not an empty bubble (#607)', async () => {
  const { deps: d, posted } = deps();
  const voice = { ...msg, id: 'v2', body: '', type: 'voice', media: { mimetype: 'audio/ogg', omitted: true, sizeBytes: 999999 } } as IncomingMessage;
  await handleInbound(d, 'sess', 'Engine', voice);
  assert.deepEqual(posted, [{ id: 55, c: '🎤 Voice message' }]);
});

test('relays a shared location as a text bubble with a maps link (#609 P2)', async () => {
  const { deps: d, posted } = deps();
  const loc = { ...msg, id: 'loc1', body: '', type: 'location', location: { latitude: -6.2, longitude: 106.8, description: 'Office' } } as IncomingMessage;
  await handleInbound(d, 'sess', 'Engine', loc);
  assert.equal(posted.length, 1);
  assert.match(posted[0].c, /📍 Office/);
  assert.match(posted[0].c, /maps\.google\.com\/\?q=-6\.2,106\.8/);
});

test('relays a sticker as a webp image attachment (#609 P2)', async () => {
  let file: { filename: string; contentType: string } | undefined;
  const { deps: d } = deps({
    client: { postMedia: async (_id: number, _c: string, f: never) => { file = f; return { id: 2 }; } },
  });
  const sticker = { ...msg, id: 's1', body: '', type: 'sticker', media: { mimetype: 'image/webp', data: 'AAA' } } as IncomingMessage;
  await handleInbound(d, 'sess', 'Engine', sticker);
  assert.equal(file!.filename, 'sticker.webp');
  assert.equal(file!.contentType, 'image/webp');
});

test('refreshes an @lid contact name once a real pushName arrives (#609)', async () => {
  const updates: Array<[number, string]> = [];
  const patches: Array<{ name?: string }> = [];
  const { deps: d } = deps({
    client: { updateContact: async (id: number, name: string) => void updates.push([id, name]) },
    store: {
      getByChat: async () => ({ conversationId: 55, contactId: 9, sourceId: 'src', name: '621@lid' }),
      patch: async (_s: string, _c: string, p: { name?: string }) => void patches.push(p),
    },
  });
  const lidMsg = { ...msg, id: 'x1', chatId: '621@lid', contact: { pushName: 'Budi' } } as IncomingMessage;
  await handleInbound(d, 'sess', 'Engine', lidMsg);
  assert.deepEqual(updates, [[9, 'Budi']]);
  assert.deepEqual(patches, [{ name: 'Budi' }]);
});

test('does not rename when the stored name already matches (#609)', async () => {
  const updates: unknown[] = [];
  const { deps: d } = deps({
    client: { updateContact: async (id: number, name: string) => void updates.push([id, name]) },
    store: { getByChat: async () => ({ conversationId: 55, contactId: 9, sourceId: 'src', name: 'Budi' }) },
  });
  await handleInbound(d, 'sess', 'Engine', { ...msg, chatId: '621@lid', contact: { pushName: 'Budi' } } as IncomingMessage);
  assert.equal(updates.length, 0);
});

test('never renames a group contact from a member pushName (#609)', async () => {
  const updates: unknown[] = [];
  const { deps: d } = deps({
    client: { updateContact: async (...a: unknown[]) => void updates.push(a) },
    store: { getByChat: async () => ({ conversationId: 55, contactId: 9, sourceId: 'src', name: 'Group 12@g.us' }) },
  });
  const grp = { ...msg, isGroup: true, chatId: '12@g.us', author: '621@c.us', contact: { pushName: 'Budi' } } as IncomingMessage;
  await handleInbound(d, 'sess', 'Engine', grp);
  assert.equal(updates.length, 0);
});

test('a 404 on inbound relay mid-flight rebuilds the mapping and retries once (no retry-queue entry, no duplicate conversation)', async () => {
  // Operator deleted the Chatwoot conversation out-of-band: the cached conv id is dead. The plugin must
  // drop the stale mapping (forward + scoped + legacy reverse), re-resolve through ensureConversation,
  // and re-post the message into a fresh conversation instead of looping the dead id forever.
  const unlinksChat: string[] = [];
  const unlinksConv: number[] = [];
  const postedTo: number[] = [];
  const enqueued: string[] = [];
  // Seed a stale mapping under the chatId that `handleInbound` will look up (msg.chatId = '621@c.us').
  const seeded = new Map<string, unknown>([
    ['sess:621@c.us', { conversationId: 191, contactId: 9, sourceId: 'src' }],
  ]);
  const { deps: d } = deps({
    store: {
      getByChat: async (s: string, c: string) => seeded.get(`${s}:${c}`) ?? null,
      link: async (s: string, c: string, _i: string, l: unknown) => void seeded.set(`${s}:${c}`, l),
      // The default unlinkByChatId in deps() clears the local map — match that semantics against the
      // seeded map so the rebuild's getByChat actually misses.
      unlinkByChatId: async (s: string, c: string) => { unlinksChat.push(c); seeded.delete(`${s}:${c}`); },
      unlinkByConversationId: async (_s: string, conv: number) => void unlinksConv.push(conv),
      enqueueRetry: async (e: { msg: { id: string } }) => void enqueued.push(e.msg.id),
    },
    client: {
      searchContact: async () => ({ id: 9, sourceId: 'src' }), // contact already on Chatwoot — no createContact
      findOpenConversation: async () => null, // the old conv is deleted; no orphan open conv
      createConversation: async () => 192,
      postText: async (id: number) => {
        postedTo.push(id);
        if (id === 191) {
          const e = new Error('Chatwoot POST .../conversations/191/messages -> 404') as Error & { status?: number };
          e.status = 404;
          throw e;
        }
        return { id: 1 };
      },
    },
  });
  await handleInbound(d, 'sess', 'Engine', msg);
  assert.deepEqual(unlinksChat, ['621@c.us'], 'forward mapping dropped');
  assert.deepEqual(unlinksConv, [191], 'scoped + legacy reverse mappings dropped');
  assert.deepEqual(postedTo, [191, 192], 'first post 404s against the dead id; second post succeeds against the rebuilt one');
  assert.deepEqual(enqueued, [], 'no retry-queue entry — the 404 was recovered in-band');
  // The rebuild reuses the existing Chatwoot contact (searchContact hit) so no second createContact fires,
  // and exactly one new conversation is minted for the contact. counts() counts both via the default
  // createContact/createConversation wrappers on the CLIENT overrides above — when an override replaces
  // them, the default counters stop incrementing, so we assert by the recorded calls instead.
  assert.ok(seeded.has('sess:621@c.us'), 'the fresh link is written back under the same chatId');
  const fresh = seeded.get('sess:621@c.us') as { conversationId: number };
  assert.equal(fresh.conversationId, 192, 'mapping now points at the new conversation id');
});

test('a 404 on the REBUILT inbound conversation propagates to the retry queue (no silent loop)', async () => {
  // Catastrophic case: even the freshly-created conversation is already gone, or Chatwoot is fully down.
  // The recovery must NOT swallow the second 404 on the rebuilt conv — the failure has to surface so the
  // existing enqueueRetry + drainRetries (5-attempt cap) takes over.
  const unlinksConv: number[] = [];
  const postedTo: number[] = [];
  const enqueued: string[] = [];
  const logCalls: string[] = [];
  // Seed the SAME stale mapping shape as the previous test.
  const seeded = new Map<string, unknown>([
    ['sess:621@c.us', { conversationId: 55, contactId: 9, sourceId: 'src' }],
  ]);
  const { deps: d } = deps({
    store: {
      getByChat: async (s: string, c: string) => seeded.get(`${s}:${c}`) ?? null,
      link: async (s: string, c: string, _i: string, l: unknown) => void seeded.set(`${s}:${c}`, l),
      unlinkByChatId: async (s: string, c: string) => { seeded.delete(`${s}:${c}`); },
      unlinkByConversationId: async (_s: string, conv: number) => void unlinksConv.push(conv),
      enqueueRetry: async (e: { msg: { id: string } }) => void enqueued.push(e.msg.id),
    },
    client: {
      searchContact: async () => ({ id: 9, sourceId: 'src' }),
      findOpenConversation: async () => null,
      createConversation: async () => 200,
      postText: async (id: number) => {
        postedTo.push(id);
        const e = new Error(`Chatwoot POST .../conversations/${id}/messages -> 404`) as Error & { status?: number };
        e.status = 404;
        throw e; // BOTH the dead id AND the rebuilt id 404 — the recovery cannot succeed
      },
    },
    log: logCalls.push.bind(logCalls),
  });
  await handleInbound(d, 'sess', 'Engine', { ...msg, id: 'm-recover-twice' });
  assert.deepEqual(unlinksConv, [55], 'still unlinks the dead conv mapping once');
  assert.deepEqual(postedTo, [55, 200], 'posts were attempted against the dead id and then the rebuilt one');
  assert.deepEqual(enqueued, ['m-recover-twice'], 'the original 404 surfaces to the retry queue (with the backoff cap)');
  assert.ok(
    logCalls.some(l => /inbound 404-recovery failed/.test(l)),
    'logs the recovery failure so ops can see why the rebuild itself failed',
  );
});
