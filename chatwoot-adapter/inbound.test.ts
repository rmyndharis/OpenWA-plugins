import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleInbound, type InboundDeps } from './inbound.ts';
import { KeyedAsyncLock } from './chat-lock.ts';
import type { IncomingMessage } from '../types/openwa';

const msg = {
  id: 'm1', from: '621@c.us', to: 'y', chatId: '621@c.us', body: 'hello', type: 'chat',
  timestamp: 0, fromMe: false, isGroup: false, senderPhone: '+621', contact: { pushName: 'Budi' },
} as IncomingMessage;

function makeDeps(
  over: {
    client?: Record<string, unknown>;
    store?: Record<string, unknown>;
    engine?: Record<string, unknown>;
    backfillLimit?: number;
    onBackfillExhausted?: (chatId: string) => void;
  } = {},
) {
  let contacts = 0;
  let convs = 0;
  const posted: Array<{ id: number; c: string }> = [];
  // Same postText calls as `posted`, reshaped to {conversationId, type, body} — the shape the backfill
  // regression tests need to tell a replayed history line (body 'earlier') from the live message.
  const posts: Array<{ conversationId: number; type: string; body: string }> = [];
  const lost: string[] = [];
  const store = new Map<string, unknown>();
  const client = {
    searchContact: async () => null,
    createContact: async () => { contacts++; return { id: 9, sourceId: 'src' }; },
    findOpenConversation: async () => null,
    createConversation: async () => { convs++; return 55; },
    postText: async (id: number, c: string, o?: { messageType?: string }) => {
      posted.push({ id, c });
      posts.push({ conversationId: id, type: o?.messageType ?? 'incoming', body: c });
      return { id: 1 };
    },
    postMedia: async () => ({ id: 2 }),
    ...over.client,
  };
  const mapping = {
    getByChat: async (s: string, c: string) => store.get(`${s}:${c}`) ?? null,
    getByConversation: async () => null,
    link: async (s: string, c: string, _i: string, l: unknown) => void store.set(`${s}:${c}`, l),
    hasSeen: async () => false,
    markSeen: async () => {},
    patch: async () => {},
    ...over.store,
  };
  // Default: identity canonicalization (@lid resolution exercised explicitly below).
  const engine = { canonicalChatId: async (_s: string, c: string) => c, ...over.engine };
  const d = {
    lock: new KeyedAsyncLock(), client, store: mapping, engine, instanceId: 'inst',
    relayGroups: true, relayMedia: true, backfillLimit: over.backfillLimit ?? 0, log: () => {},
    onInboundLost: (msgId: string) => void lost.push(msgId),
    onBackfillExhausted: over.onBackfillExhausted ?? (() => {}),
  } as unknown as InboundDeps;
  return { deps: d, counts: () => ({ contacts, convs }), posted, posts, lost };
}

test('a migrated contact (@lid inbound, @c.us-keyed conversation) reuses the EXISTING conversation via dual-lookup, no split', async () => {
  const { deps: d, posted, counts } = makeDeps({
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
  const { deps: d, posted, counts } = makeDeps({
    engine: { canonicalChatId: async (_s: string, c: string) => c }, // cold: @lid stays @lid
  });
  const lidMsg = { ...msg, id: 'x2', chatId: '621@lid' } as IncomingMessage;
  await handleInbound(d, 'sess', 'Engine', lidMsg);
  assert.equal(posted.length, 1);
  assert.deepEqual(counts(), { contacts: 1, convs: 1 }); // no @c.us mapping resolvable while cold → creates
});

test('canonicalChatId throwing (session down) falls back to the raw id and still relays — never drops the message', async () => {
  const { deps: d, posted } = makeDeps({
    engine: { canonicalChatId: async () => { throw new Error('session not active'); } },
  });
  await handleInbound(d, 'sess', 'Engine', msg);
  assert.equal(posted.length, 1); // relayed via the raw fallback, not lost before markSeen/enqueue
});

test('reusing a @c.us mapping via @lid dual-lookup patches the name under the @c.us key (no repeated updateContact)', async () => {
  const patches: Array<[string, { name?: string }]> = [];
  const renames: string[] = [];
  const { deps: d } = makeDeps({
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
  const { deps: d } = makeDeps({
    client: { postText: async () => { throw new Error('chatwoot 503'); } },
    store: { enqueueRetry: async (e: { msg: { id: string } }) => void enqueued.push(e.msg.id) },
  });
  await handleInbound(d, 'sess', 'Engine', msg);
  assert.deepEqual(enqueued, ['m1']); // conversation resolved, post failed → queued (not silently dropped)
});

test('creates contact + conversation and posts an incoming message', async () => {
  const { deps: d, posted, counts } = makeDeps();
  await handleInbound(d, 'sess', 'Engine', msg);
  assert.deepEqual(posted, [{ id: 55, c: 'hello' }]);
  assert.deepEqual(counts(), { contacts: 1, convs: 1 });
});

test('two concurrent inbounds for a NEW chat make exactly ONE contact + conversation', async () => {
  const { deps: d, counts } = makeDeps();
  await Promise.all([
    handleInbound(d, 'sess', 'Engine', msg),
    handleInbound(d, 'sess', 'Engine', { ...msg, id: 'm2' }),
  ]);
  assert.deepEqual(counts(), { contacts: 1, convs: 1 }); // per-chat lock + re-read prevents cold-start dupes
});

test('skips fromMe and is idempotent (already seen → no post)', async () => {
  const { deps: d, posted } = makeDeps({ store: { hasSeen: async () => true } });
  await handleInbound(d, 'sess', 'Engine', msg);
  await handleInbound(d, 'sess', 'Engine', { ...msg, fromMe: true });
  assert.equal(posted.length, 0);
});

test('forwards the quote context (source_id + in_reply_to_external_id) on a reply (#606)', async () => {
  let opts: unknown;
  const { deps: d } = makeDeps({
    client: { postText: async (_id: number, _c: string, o: unknown) => { opts = o; return { id: 1 }; } },
  });
  const reply = { ...msg, id: 'r1', quotedMessage: { id: 'orig', body: 'earlier' } } as IncomingMessage;
  await handleInbound(d, 'sess', 'Engine', reply);
  assert.deepEqual(opts, { sourceId: 'r1', inReplyToExternalId: 'orig', messageType: 'incoming' });
});

test('relays an inbound voice note as a Chatwoot voice message (#607)', async () => {
  let call: { file: { filename: string; contentType: string }; o: { isVoiceMessage?: boolean; sourceId?: string } } | undefined;
  const { deps: d } = makeDeps({
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
  const { deps: d, posted } = makeDeps();
  const voice = { ...msg, id: 'v2', body: '', type: 'voice', media: { mimetype: 'audio/ogg', omitted: true, sizeBytes: 999999 } } as IncomingMessage;
  await handleInbound(d, 'sess', 'Engine', voice);
  assert.deepEqual(posted, [{ id: 55, c: '🎤 Voice message' }]);
});

test('relays a shared location as a text bubble with a maps link (#609 P2)', async () => {
  const { deps: d, posted } = makeDeps();
  const loc = { ...msg, id: 'loc1', body: '', type: 'location', location: { latitude: -6.2, longitude: 106.8, description: 'Office' } } as IncomingMessage;
  await handleInbound(d, 'sess', 'Engine', loc);
  assert.equal(posted.length, 1);
  assert.match(posted[0].c, /📍 Office/);
  assert.match(posted[0].c, /maps\.google\.com\/\?q=-6\.2,106\.8/);
});

test('relays a sticker as a webp image attachment (#609 P2)', async () => {
  let file: { filename: string; contentType: string } | undefined;
  const { deps: d } = makeDeps({
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
  const { deps: d } = makeDeps({
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
  const { deps: d } = makeDeps({
    client: { updateContact: async (id: number, name: string) => void updates.push([id, name]) },
    store: { getByChat: async () => ({ conversationId: 55, contactId: 9, sourceId: 'src', name: 'Budi' }) },
  });
  await handleInbound(d, 'sess', 'Engine', { ...msg, chatId: '621@lid', contact: { pushName: 'Budi' } } as IncomingMessage);
  assert.equal(updates.length, 0);
});

test('never renames a group contact from a member pushName (#609)', async () => {
  const updates: unknown[] = [];
  const { deps: d } = makeDeps({
    client: { updateContact: async (...a: unknown[]) => void updates.push(a) },
    store: { getByChat: async () => ({ conversationId: 55, contactId: 9, sourceId: 'src', name: 'Group 12@g.us' }) },
  });
  const grp = { ...msg, isGroup: true, chatId: '12@g.us', author: '621@c.us', contact: { pushName: 'Budi' } } as IncomingMessage;
  await handleInbound(d, 'sess', 'Engine', grp);
  assert.equal(updates.length, 0);
});

// Helpers for the create-contact phone assertions below: capture the (identifier, name, phone) triple
// every createContact call was made with. Phone is the new behavior under test (resolvePhone feeds it).
function captureCreateContact() {
  const calls: Array<{ identifier: string; name: string; phone: string | undefined }> = [];
  const client = {
    createContact: async (identifier: string, name: string, phone?: string) => {
      calls.push({ identifier, name, phone });
      return { id: 9, sourceId: 'src' };
    },
  };
  return { calls, client };
}

test('@lid inbound with senderPhone set (RESOLVE_LID_TO_PHONE=true) creates the contact with the real phone', async () => {
  const { calls, client } = captureCreateContact();
  const { deps: d } = makeDeps({ client });
  // senderPhone is what the host populates when the env flag is on — MSISDN digits, no `+` guaranteed.
  const lid = { ...msg, id: 'lid-pn', chatId: '118367890123478@lid' } as IncomingMessage;
  lid.senderPhone = '1234567890';
  await handleInbound(d, 'sess', 'Engine', lid);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].phone, '+1234567890');
});

test('@lid inbound with a warm lid->phone mapping (canonicalChatId resolves) creates the contact with the real phone', async () => {
  const { calls, client } = captureCreateContact();
  const { deps: d } = makeDeps({
    client,
    // The engine's in-memory lidMappingStore returns the chat's `<phone>@c.us` once any reply to them
    // has warmed it, with RESOLVE_LID_TO_PHONE off.
    engine: { canonicalChatId: async (_s: string, c: string) => (c === '118367890123478@lid' ? '1234567890@c.us' : c) },
  });
  const lid = { ...msg, id: 'lid-warm', chatId: '118367890123478@lid' } as IncomingMessage;
  lid.senderPhone = undefined;
  await handleInbound(d, 'sess', 'Engine', lid);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].phone, '+1234567890');
});

test('@lid inbound with COLD lid mapping (RESOLVE_LID_TO_PHONE off, no reply yet) creates the contact without a phone — no regression vs pre-fix behavior', async () => {
  const { calls, client } = captureCreateContact();
  const { deps: d } = makeDeps({
    client,
    engine: { canonicalChatId: async (_s: string, c: string) => c }, // unresolved → @lid stays @lid
  });
  const lid = { ...msg, id: 'lid-cold', chatId: '118367890123478@lid' } as IncomingMessage;
  lid.senderPhone = undefined;
  await handleInbound(d, 'sess', 'Engine', lid);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].phone, undefined); // genuinely unknown — pre-fix behavior preserved
});

test('plain `@c.us` inbound without senderPhone creates the contact with the phone (resolved from the chatId user-part)', async () => {
  const { calls, client } = captureCreateContact();
  const { deps: d } = makeDeps({ client });
  // senderPhone on the host is lid-only, so a plain @c.us sender usually has no senderPhone at all.
  const c_us = { ...msg, id: 'cn1', chatId: '1234567890@c.us' } as IncomingMessage;
  c_us.senderPhone = undefined;
  await handleInbound(d, 'sess', 'Engine', c_us);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].phone, '+1234567890');
});

test('a group inbound creates the group contact without a phone, regardless of senderPhone', async () => {
  const { calls, client } = captureCreateContact();
  const { deps: d } = makeDeps({ client });
  const grp = { ...msg, id: 'g1', isGroup: true, chatId: '120363@g.us', author: '621@c.us' } as IncomingMessage;
  grp.senderPhone = '1234567890';
  await handleInbound(d, 'sess', 'Engine', grp);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].phone, undefined); // groups never get a phone
  assert.equal(calls[0].name, 'Group 120363@g.us');
});

// ── Storage failure: the message must never disappear without saying so ─────────────────────────────
// The host rejects EVERY storage.set once a plugin is at its 50 MiB quota. Before 0.6.0 that rejection
// was swallowed: enqueueRetry's .catch logged and returned null, so the "queue full" branch never fired,
// the drop-oldest policy never ran, and healthCheck kept reporting green while messages vanished.

test('a relay failure that also fails to enqueue is reported as LOST, not swallowed', async () => {
  const { deps: d, lost } = makeDeps({
    client: { postText: async () => { throw new Error('chatwoot down'); } },
    store: { enqueueRetry: async () => { throw new Error('storage quota exceeded'); } },
  });
  await handleInbound(d, 'sess', 'Engine', msg);
  assert.deepEqual(lost, ['m1']);
});

test('a relay failure that DOES enqueue is not reported as lost', async () => {
  const queued: unknown[] = [];
  const { deps: d, lost } = makeDeps({
    client: { postText: async () => { throw new Error('chatwoot down'); } },
    store: { enqueueRetry: async (e: unknown) => { queued.push(e); return null; } },
  });
  await handleInbound(d, 'sess', 'Engine', msg);
  assert.equal(queued.length, 1);
  assert.deepEqual(lost, []);
});

// markSeen sits inside the try since 0.6.0. Left outside, a rejected marker write threw straight out of
// the hook with the message neither relayed nor queued — and nothing counted it.
test('a markSeen failure takes the retry path instead of escaping the handler', async () => {
  const queued: unknown[] = [];
  const { deps: d, lost, posted } = makeDeps({
    store: {
      markSeen: async () => { throw new Error('storage quota exceeded'); },
      enqueueRetry: async (e: unknown) => { queued.push(e); return null; },
    },
  });
  await handleInbound(d, 'sess', 'Engine', msg); // must not reject
  assert.equal(queued.length, 1, 'the message is queued for retry');
  assert.deepEqual(lost, []);
  assert.deepEqual(posted, [], 'nothing was relayed');
});

// ── Durable per-chat backfill marker: the trigger reads back the stored state, not a one-shot inference ──

// A distinct base from `msg` above (different chatId: 'c@c.us') so these tests can drive several inbound
// messages into the SAME chat via the store fake's `links` map without colliding with the other fixture's
// hardcoded '621@c.us'.
const msgWith = (over: Partial<IncomingMessage> = {}): IncomingMessage =>
  ({ id: 'm1', from: 'x', to: 'y', chatId: 'c@c.us', body: 'hi', type: 'chat',
     timestamp: 0, fromMe: false, isGroup: false, ...over }) as IncomingMessage;

test('a failed history fetch is retried on the next inbound instead of being lost forever', async () => {
  const links = new Map<string, Record<string, unknown>>();
  let historyCalls = 0;
  const { deps, posts } = makeDeps({
    engine: {
      canonicalChatId: async (_s: string, c: string) => c,
      getChatHistory: async () => {
        historyCalls++;
        if (historyCalls === 1) throw new Error("capability 'engine.getChatHistory' timed out after 30000ms");
        return [
          { id: 'old', from: 'x', to: 'y', chatId: 'c@c.us', body: 'earlier', type: 'chat',
            timestamp: 1, fromMe: false, isGroup: false },
        ];
      },
    },
    store: {
      getByChat: async (_s: string, c: string) => links.get(c) ?? null,
      link: async (_s: string, c: string, _i: string, l: Record<string, unknown>) => void links.set(c, { ...l }),
      patch: async (_s: string, c: string, p: Record<string, unknown>) =>
        void links.set(c, { ...(links.get(c) ?? {}), ...p }),
    },
    backfillLimit: 20,
  });

  await handleInbound(deps, 'sess', 'Engine', msgWith({ id: 'm1', body: 'first' }));
  assert.equal(historyCalls, 1);
  assert.equal(links.get('c@c.us')?.backfillAttempts, 1);
  assert.equal(links.get('c@c.us')?.backfillDone, undefined);
  assert.ok(!posts.some(p => p.body === 'earlier'), 'nothing backfilled on the failed attempt');

  await handleInbound(deps, 'sess', 'Engine', msgWith({ id: 'm2', body: 'second' }));
  assert.equal(historyCalls, 2);
  assert.equal(links.get('c@c.us')?.backfillDone, true);
  assert.ok(posts.some(p => p.body === 'earlier'), 'history landed on the retry');
});

test('backfill stops after MAX_BACKFILL_ATTEMPTS and reports the chat as exhausted', async () => {
  const links = new Map<string, Record<string, unknown>>();
  const exhausted: string[] = [];
  let historyCalls = 0;
  const { deps } = makeDeps({
    engine: {
      canonicalChatId: async (_s: string, c: string) => c,
      getChatHistory: async () => {
        historyCalls++;
        throw new Error('timed out');
      },
    },
    store: {
      getByChat: async (_s: string, c: string) => links.get(c) ?? null,
      link: async (_s: string, c: string, _i: string, l: Record<string, unknown>) => void links.set(c, { ...l }),
      patch: async (_s: string, c: string, p: Record<string, unknown>) =>
        void links.set(c, { ...(links.get(c) ?? {}), ...p }),
    },
    onBackfillExhausted: (chatId: string) => void exhausted.push(chatId),
    backfillLimit: 20,
  });

  for (let i = 1; i <= 5; i++) {
    await handleInbound(deps, 'sess', 'Engine', msgWith({ id: `m${i}`, body: `b${i}` }));
  }
  assert.equal(historyCalls, 3, 'stops attempting after the cap');
  assert.deepEqual(exhausted, ['c@c.us']);
  assert.equal(links.get('c@c.us')?.backfillDone, undefined, 'exhaustion must never be recorded as done');
});
