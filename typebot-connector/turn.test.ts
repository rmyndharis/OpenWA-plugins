import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, PluginConversationsCapability, ConversationSendEnvelope, PluginStorage } from '../types/openwa';
import type { TypebotConfig, NormalizedResponse } from './typebot-types.ts';
import { KeyedAsyncLock } from './chat-lock.ts';
import { SessionStore } from './session-store.ts';
import { handleTurn, type TurnDeps } from './turn.ts';
import { TypebotHttpError } from './typebot-client.ts';

const cfg: TypebotConfig = { apiHost: 'https://typebot.io', publicId: 'bot', respondInGroups: true, sessionTimeoutMinutes: 30, passContactVariables: true };

function fakeStorage(): PluginStorage {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => (m.has(k) ? (m.get(k) as T) : null),
    set: async (k, v) => void m.set(k, v),
    delete: async k => void m.delete(k),
    list: async (p = '') => [...m.keys()].filter(k => k.startsWith(p)),
  };
}

const msg = (over: Partial<IncomingMessage> = {}): IncomingMessage =>
  ({ id: 'm', from: 'x', to: 'y', chatId: 'c@c.us', body: 'hi', type: 'chat', timestamp: 0,
     fromMe: false, isGroup: false, ...over }) as IncomingMessage;

function deps(clientOver: Partial<Record<'startChat' | 'continueChat' | 'uploadFile', unknown>>, storage = fakeStorage()) {
  const sent: ConversationSendEnvelope[] = [];
  const conversations: PluginConversationsCapability = { send: async e => void sent.push(e) };
  const client = {
    startChat: async () => (typeof clientOver.startChat === 'function' ? (clientOver.startChat as any)() : clientOver.startChat) ?? { sessionId: 'S1', bubbles: [], input: { kind: 'text', blockId: 'b', attachmentsEnabled: false } },
    continueChat: async (_s: string, _m: unknown) => (typeof clientOver.continueChat === 'function' ? (clientOver.continueChat as any)(_s, _m) : clientOver.continueChat) ?? { bubbles: [], input: undefined },
    uploadFile: async (_s: string, _b: string, _f: unknown) => (typeof clientOver.uploadFile === 'function' ? (clientOver.uploadFile as any)(_s, _b, _f) : clientOver.uploadFile) ?? 'https://cdn/f',
  };
  const store = new SessionStore(storage);
  const d: TurnDeps = { cfg, client: client as any, store, lock: new KeyedAsyncLock(), conversations, now: () => 1000, log: () => {} };
  return { d, sent, store };
}

test('first message → startChat, sends parts, persists state', async () => {
  const startChat: NormalizedResponse = { sessionId: 'S1', bubbles: [{ kind: 'text', markdown: 'Hi' }], input: { kind: 'text', blockId: 'b', attachmentsEnabled: false } };
  const { d, sent, store } = deps({ startChat });
  await handleTurn(d, 'sess', 'Engine', msg());
  assert.deepEqual(sent.map(s => s.text), ['Hi']);
  assert.equal(sent[0].chatId, 'c@c.us');
  const state = await store.get('sess:c@c.us');
  assert.equal(state?.sessionId, 'S1');
});

test('with state → continueChat; flow-end (no input) clears state', async () => {
  const { d, store } = deps({ continueChat: { bubbles: [{ kind: 'text', markdown: 'Done' }], input: undefined } });
  await store.set('sess:c@c.us', { sessionId: 'S1', awaiting: { kind: 'text', blockId: 'b', attachmentsEnabled: false }, lastActivity: 1000 });
  await handleTurn(d, 'sess', 'Engine', msg({ body: 'ok' }));
  assert.equal(await store.get('sess:c@c.us'), null);
});

test('out-of-scope message is ignored (no send, no state)', async () => {
  const { d, sent, store } = deps({});
  await handleTurn(d, 'sess', 'Webhook', msg());
  assert.equal(sent.length, 0);
  assert.equal(await store.get('sess:c@c.us'), null);
});

test('group message replies with a quote (replyTo set)', async () => {
  const startChat: NormalizedResponse = { sessionId: 'S1', bubbles: [{ kind: 'text', markdown: 'Hi' }] };
  const { d, sent } = deps({ startChat });
  await handleTurn(d, 'sess', 'Engine', msg({ isGroup: true, chatId: 'g@g.us', author: 'a@c.us' }));
  assert.equal(sent[0].replyTo, 'm');
});

test('group: media parts omit replyTo (OpenWA rejects replyTo on media); text parts keep it', async () => {
  const startChat: NormalizedResponse = {
    sessionId: 'S1',
    bubbles: [{ kind: 'text', markdown: 'Hi' }, { kind: 'image', url: 'https://x/i.png' }],
  };
  const { d, sent } = deps({ startChat });
  await handleTurn(d, 'sess', 'Engine', msg({ isGroup: true, chatId: 'g@g.us', author: 'a@c.us' }));
  const textPart = sent.find(s => s.type === 'text');
  const mediaPart = sent.find(s => s.type === 'image');
  assert.equal(textPart?.replyTo, 'm'); // text is quoted to disambiguate the sender
  assert.equal(mediaPart?.mediaUrl, 'https://x/i.png');
  assert.equal(mediaPart?.replyTo, undefined); // media MUST NOT carry replyTo (0.8.2 throws)
});

test('upload failure → fallback text sent, continueChat not called, state intact', async () => {
  let continueChatCalls = 0;
  const { d, sent, store } = deps({
    uploadFile: () => { throw new Error('network fail'); },
    continueChat: () => { continueChatCalls++; return { bubbles: [], input: undefined }; },
  });
  await store.set('sess:c@c.us', { sessionId: 'S1', awaiting: { kind: 'file', blockId: 'b' }, lastActivity: 1000 });
  await handleTurn(d, 'sess', 'Engine', msg({ media: { mimetype: 'image/png', filename: 'p.png', data: 'AAA' } }));
  assert.ok(sent.some(s => typeof s.text === 'string' && s.text.includes('Sorry, that upload failed')));
  assert.equal(continueChatCalls, 0);
  const state = await store.get('sess:c@c.us');
  assert.ok(state);
  assert.equal(state?.sessionId, 'S1');
  assert.equal(state?.awaiting.kind, 'file');
});

test('expired session (404) → clear + startChat restart, new state persisted', async () => {
  const restarted: NormalizedResponse = {
    sessionId: 'S2',
    bubbles: [{ kind: 'text', markdown: 'Restarted' }],
    input: { kind: 'text', blockId: 'b2', attachmentsEnabled: false },
  };
  const { d, sent, store } = deps({
    continueChat: () => { throw new TypebotHttpError(404, 'gone'); },
    startChat: restarted,
  });
  await store.set('sess:c@c.us', { sessionId: 'S1', awaiting: { kind: 'text', blockId: 'b', attachmentsEnabled: false }, lastActivity: 1000 });
  await handleTurn(d, 'sess', 'Engine', msg({ body: 'hello again' }));
  assert.deepEqual(sent.map(s => s.text), ['Restarted']);
  const state = await store.get('sess:c@c.us');
  assert.equal(state?.sessionId, 'S2');
});

// ── Contact variables (0.1.1) ───────────────────────────────────────────────────────────────────────
// Proven on a live 0.12.1 host: the same published flow rendered `num=[628999000]` when the Chat API was
// called directly, and `num=[]` when driven through this plugin — because senderPhone is assigned by the
// host only AFTER the message:received chain, and only for @lid senders.

/** Same shape as `deps` above, but the client records the prefilledVariables startChat was called with. */
function depsCapturingVars() {
  const seen: Array<Record<string, string>> = [];
  const conversations: PluginConversationsCapability = { send: async () => {} };
  const client = {
    startChat: async (o: { prefilledVariables?: Record<string, string> }) => {
      seen.push(o?.prefilledVariables ?? {});
      return { sessionId: 'S1', bubbles: [], input: undefined };
    },
    continueChat: async () => ({ bubbles: [], input: undefined }),
    uploadFile: async () => 'https://cdn/f',
  };
  const d: TurnDeps = {
    cfg, client: client as any, store: new SessionStore(fakeStorage()), lock: new KeyedAsyncLock(),
    conversations, now: () => 1000, log: () => {},
  };
  return { d, seen };
}

test('waNumber falls back to the JID digits, since senderPhone is never set at hook time', async () => {
  const { d, seen } = depsCapturingVars();
  await handleTurn(d, 'sess', 'Engine', msg({ from: '6281234567890@c.us' }));
  assert.equal(seen[0].waNumber, '6281234567890');
});

test('a group turn keys waNumber to the AUTHOR, not the group', async () => {
  const { d, seen } = depsCapturingVars();
  await handleTurn(d, 'sess', 'Engine', msg({
    isGroup: true, from: '120363@g.us', chatId: '120363@g.us', author: '6281234567890@c.us',
  }));
  assert.equal(seen[0].waNumber, '6281234567890');
});

test('a @lid sender yields no waNumber — a privacy id is not a phone number', async () => {
  const { d, seen } = depsCapturingVars();
  await handleTurn(d, 'sess', 'Engine', msg({ from: '118367890123478@lid' }));
  assert.equal(seen[0].waNumber, '');
});

// Same regression as http-action: only a real user JID may become {{waNumber}}. A group/channel id is
// numeric too, and feeding one to a flow's CRM lookup is worse than feeding nothing.
test('a non-user JID never becomes waNumber', async () => {
  for (const [from, want] of [
    ['6281234567890@c.us', '6281234567890'],
    ['628123:12@s.whatsapp.net', '628123'],
    ['118367890123478@lid', ''],
    ['120363144038483540@g.us', ''],
    ['120363144038483540@newsletter', ''],
  ] as Array<[string, string]>) {
    const { d, seen } = depsCapturingVars();
    await handleTurn(d, 'sess', 'Engine', msg({ from, author: undefined }));
    assert.equal(seen[0].waNumber, want, `for ${from}`);
  }
});

// Regression: state is persisted BEFORE the send loop (the Typebot server has already advanced), so a
// part that fails must not abort the parts after it — the contact would be left with a half turn while
// the plugin believed the prompt was delivered, and their next message would be matched against an
// input they never saw. Verified in production too: an image whose URL the host refused still let the
// following choice list through.
test('one failed part does not silence the rest of the turn', async () => {
  const sent: ConversationSendEnvelope[] = [];
  let calls = 0;
  const conversations: PluginConversationsCapability = {
    send: async e => {
      calls++;
      if (calls === 1) throw new Error('host refused this media');
      sent.push(e);
    },
  };
  const client = {
    startChat: async () => ({
      sessionId: 'S1',
      bubbles: [{ kind: 'image', url: 'https://x/i.png' }, { kind: 'text', markdown: 'masih terkirim' }],
      input: undefined,
    }),
    continueChat: async () => ({ bubbles: [], input: undefined }),
    uploadFile: async () => 'https://cdn/f',
  };
  const d: TurnDeps = {
    cfg, client: client as any, store: new SessionStore(fakeStorage()), lock: new KeyedAsyncLock(),
    conversations, now: () => 1000, log: () => {},
  };
  await handleTurn(d, 'sess', 'Engine', msg()); // must not reject
  assert.equal(calls, 2, 'every part was attempted');
  assert.deepEqual(sent.map(s => s.text), ['masih terkirim'], 'the part after the failure still went out');
});

test('a rejected state write still delivers the turn the server has already advanced past', async () => {
  // startChat/continueChat advance the Typebot server irreversibly before this write. If the write
  // throwing aborted the turn, the contact would receive none of the bubbles for a step the server has
  // already taken, and their next message would silently restart the flow. Losing the row costs them one
  // restart; losing the bubbles too costs them the restart AND this turn.
  const storage = fakeStorage();
  storage.set = async () => {
    throw new Error('storage quota exceeded');
  };
  const startChat: NormalizedResponse = {
    sessionId: 'S1',
    bubbles: [{ kind: 'text', markdown: 'Halo, ada yang bisa dibantu?' }],
    input: { kind: 'text', blockId: 'b', attachmentsEnabled: false },
  };
  const logged: string[] = [];
  const { d, sent } = deps({ startChat }, storage);
  d.log = (m: string) => void logged.push(m);

  await handleTurn(d, 'sess', 'Engine', msg());

  assert.deepEqual(sent.map(s => s.text), ['Halo, ada yang bisa dibantu?'], 'the turn is still delivered');
  assert.ok(logged.some(l => /state write failed/i.test(l)), 'and the lost row is recorded, not silent');
});
