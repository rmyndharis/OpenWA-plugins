import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, PluginConversationsCapability, ConversationSendEnvelope, PluginStorage } from '../types/openwa';
import type { TypebotConfig, NormalizedResponse } from './typebot-types.ts';
import { KeyedAsyncLock } from './chat-lock.ts';
import { SessionStore } from './session-store.ts';
import { handleTurn, type TurnDeps } from './turn.ts';

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
    startChat: async () => (clientOver.startChat as any) ?? { sessionId: 'S1', bubbles: [], input: { kind: 'text', blockId: 'b', attachmentsEnabled: false } },
    continueChat: async (_s: string, _m: unknown) => (typeof clientOver.continueChat === 'function' ? (clientOver.continueChat as any)(_s, _m) : clientOver.continueChat) ?? { bubbles: [], input: undefined },
    uploadFile: async () => (clientOver.uploadFile as string) ?? 'https://cdn/f',
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
