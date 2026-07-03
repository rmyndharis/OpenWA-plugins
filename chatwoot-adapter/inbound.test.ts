import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleInbound, type InboundDeps } from './inbound.ts';
import { KeyedAsyncLock } from './chat-lock.ts';
import type { IncomingMessage } from '../types/openwa';

const msg = {
  id: 'm1', from: '621@c.us', to: 'y', chatId: '621@c.us', body: 'hello', type: 'chat',
  timestamp: 0, fromMe: false, isGroup: false, senderPhone: '+621', contact: { pushName: 'Budi' },
} as IncomingMessage;

function deps(over: { client?: Record<string, unknown>; store?: Record<string, unknown> } = {}) {
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
  const mapping = {
    getByChat: async (s: string, c: string) => store.get(`${s}:${c}`) ?? null,
    getByConversation: async () => null,
    link: async (s: string, c: string, _i: string, l: unknown) => void store.set(`${s}:${c}`, l),
    hasSeen: async () => false,
    markSeen: async () => {},
    ...over.store,
  };
  const d = {
    lock: new KeyedAsyncLock(), client, store: mapping, instanceId: 'inst',
    relayGroups: true, relayMedia: true, log: () => {},
  } as unknown as InboundDeps;
  return { deps: d, counts: () => ({ contacts, convs }), posted };
}

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
  assert.deepEqual(opts, { sourceId: 'r1', inReplyToExternalId: 'orig' });
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
