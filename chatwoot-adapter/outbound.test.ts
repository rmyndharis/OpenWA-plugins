import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { handleOutbound, type OutboundDeps } from './outbound.ts';
import { KeyedAsyncLock } from './chat-lock.ts';
import { MappingStore } from './mapping-store.ts';
import type { WebhookRequest, PluginStorage, PluginMappingsCapability } from '../types/openwa';

function req(body: unknown): WebhookRequest {
  const s = JSON.stringify(body);
  return { instanceId: 'inst', sessionId: 'sess', method: 'POST', headers: {}, query: {}, body: s, rawBody: s, verified: true, deliveryId: 'd1' };
}
function reqScoped(sessionId: string, body: unknown): WebhookRequest {
  const s = JSON.stringify(body);
  return { instanceId: sessionId, sessionId, method: 'POST', headers: {}, query: {}, body: s, rawBody: s, verified: true, deliveryId: 'd1' };
}

function fakeStorage(): PluginStorage {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => (m.has(k) ? (m.get(k) as T) : null),
    set: async (k: string, v: unknown) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
    list: async () => [...m.keys()],
  };
}
const fakeMappings: PluginMappingsCapability = { upsert: async () => {}, get: async () => null, getByProvider: async () => null };

function deps(over: { store?: Record<string, unknown> } = {}) {
  const sent: Array<{ sessionId?: string; chatId?: string; type: string; text?: string }> = [];
  const handovers: Array<[unknown, string]> = [];
  const d = {
    lock: new KeyedAsyncLock(),
    conversations: { send: async (e: { sessionId?: string; chatId?: string; type: string; text?: string }) => void sent.push(e) },
    handover: { set: async (k: unknown, s: string) => void handovers.push([k, s]) },
    store: {
      hasSeen: async () => false,
      markSeen: async () => {},
      getByConversation: async () => ({ sessionId: 'sess', chatId: 'c@wa' }),
      ...over.store,
    },
    inboxId: 7,
    log: () => {},
  } as unknown as OutboundDeps;
  return { sent, handovers, deps: d };
}

test('relays an outgoing agent reply with an explicit chatId', async () => {
  const { deps: d, sent } = deps();
  const r = await handleOutbound(
    d,
    req({ event: 'message_created', message_type: 'outgoing', private: false, id: 5, content: 'hi', inbox: { id: 7 }, conversation: { id: 55 } }),
  );
  assert.deepEqual(r, { status: 200 });
  assert.deepEqual(sent, [{ sessionId: 'sess', chatId: 'c@wa', type: 'text', text: 'hi' }]);
});

test('drops the incoming echo and private notes', async () => {
  const { deps: d, sent } = deps();
  await handleOutbound(d, req({ message_type: 'incoming', inbox: { id: 7 }, conversation: { id: 55 }, content: 'x' }));
  await handleOutbound(d, req({ message_type: 'outgoing', private: true, inbox: { id: 7 }, conversation: { id: 55 }, content: 'note' }));
  assert.equal(sent.length, 0);
});

test('handover: assign→human, unassign→bot, resolve→closed', async () => {
  const { deps: d, handovers } = deps();
  await handleOutbound(d, req({ event: 'conversation_updated', conversation: { id: 55, meta: { assignee: { id: 3 } } }, changed_attributes: [{ assignee_id: { previous_value: null, current_value: 3 } }] }));
  await handleOutbound(d, req({ event: 'conversation_updated', conversation: { id: 55, meta: { assignee: null } }, changed_attributes: [{ assignee_id: { previous_value: 3, current_value: null } }] }));
  await handleOutbound(d, req({ event: 'conversation_updated', conversation: { id: 55, status: 'resolved' }, changed_attributes: [{ status: { previous_value: 'open', current_value: 'resolved' } }] }));
  assert.deepEqual(handovers.map(h => h[1]), ['human', 'bot', 'closed']);
});

test('status→open with no assignee change is a no-op (never infer human from status)', async () => {
  const { deps: d, handovers } = deps();
  await handleOutbound(d, req({ event: 'conversation_updated', conversation: { id: 55, status: 'open' }, changed_attributes: [{ status: { previous_value: 'pending', current_value: 'open' } }] }));
  assert.equal(handovers.length, 0);
});

test('golden: a captured Chatwoot message_created drives exactly one conversations.send', async () => {
  const { deps: d, sent } = deps();
  const raw = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/message_created.json'), 'utf8');
  const r = await handleOutbound(d, { instanceId: 'inst', method: 'POST', headers: {}, query: {}, body: raw, rawBody: raw, verified: true, deliveryId: 'g1' });
  assert.deepEqual(r, { status: 200 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'Hi! How can I help you today?');
});

test('cross-tenant: two accounts sharing conversation id 55 route to the correct WA chat, no dedup cross-drop', async () => {
  const store = new MappingStore(fakeStorage(), fakeMappings);
  await store.link('sessA', 'alice@wa', 'instA', { conversationId: 55, contactId: 1, sourceId: 'a' });
  await store.link('sessB', 'bob@wa', 'instB', { conversationId: 55, contactId: 2, sourceId: 'b' });
  const sent: Array<{ sessionId?: string; chatId?: string; text?: string }> = [];
  const d = {
    lock: new KeyedAsyncLock(),
    conversations: { send: async (e: { sessionId?: string; chatId?: string; text?: string }) => void sent.push(e) },
    handover: { set: async () => {} },
    store,
    inboxId: 7,
    log: () => {},
  } as unknown as OutboundDeps;
  const evt = (content: string) => ({ event: 'message_created', message_type: 'outgoing', private: false, id: 5, content, inbox: { id: 7 }, conversation: { id: 55 } });
  await handleOutbound(d, reqScoped('sessA', evt('for alice')));
  await handleOutbound(d, reqScoped('sessB', evt('for bob'))); // same conversation id 55 AND same message id 5
  assert.deepEqual(sent, [
    { sessionId: 'sessA', chatId: 'alice@wa', type: 'text', text: 'for alice' },
    { sessionId: 'sessB', chatId: 'bob@wa', type: 'text', text: 'for bob' },
  ]);
});

test('a transient send failure does not poison dedup: the retry re-sends the reply', async () => {
  const store = new MappingStore(fakeStorage(), fakeMappings);
  await store.link('sess', 'c@wa', 'inst', { conversationId: 55, contactId: 1, sourceId: 'a' });
  let fail = true;
  const sent: Array<{ text?: string }> = [];
  const d = {
    lock: new KeyedAsyncLock(),
    conversations: {
      send: async (e: { text?: string }) => {
        if (fail) { fail = false; throw new Error('session down'); }
        sent.push(e);
      },
    },
    handover: { set: async () => {} },
    store,
    inboxId: 7,
    log: () => {},
  } as unknown as OutboundDeps;
  const body = { event: 'message_created', message_type: 'outgoing', private: false, id: 9, content: 'hi', inbox: { id: 7 }, conversation: { id: 55 } };
  await assert.rejects(handleOutbound(d, reqScoped('sess', body))); // first attempt throws → surfaces for retry
  await handleOutbound(d, reqScoped('sess', body)); // retry: NOT suppressed by a premature dedup mark
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'hi');
});

test('handover guards a non-object changed_attributes element (no throw / retry loop)', async () => {
  const { deps: d, handovers } = deps();
  const r = await handleOutbound(d, req({ event: 'conversation_updated', conversation: { id: 55 }, changed_attributes: [null, 'x', { assignee_id: { current_value: 3 } }] }));
  assert.deepEqual(r, { status: 200 });
  assert.deepEqual(handovers.map(h => h[1]), ['human']); // the valid element is still read
});
