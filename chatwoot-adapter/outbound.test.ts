import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { handleOutbound, type OutboundDeps } from './outbound.ts';
import { KeyedAsyncLock } from './chat-lock.ts';
import type { WebhookRequest } from '../types/openwa';

function req(body: unknown): WebhookRequest {
  const s = JSON.stringify(body);
  return { instanceId: 'inst', method: 'POST', headers: {}, query: {}, body: s, rawBody: s, verified: true, deliveryId: 'd1' };
}

function deps(over: { store?: Record<string, unknown> } = {}) {
  const sent: Array<{ sessionId?: string; chatId?: string; type: string; text?: string }> = [];
  const handovers: Array<[unknown, string]> = [];
  const d = {
    lock: new KeyedAsyncLock(),
    conversations: { send: async (e: { sessionId?: string; chatId?: string; type: string; text?: string }) => void sent.push(e) },
    handover: { set: async (k: unknown, s: string) => void handovers.push([k, s]) },
    store: { seen: async () => false, getByConversation: async () => ({ sessionId: 'sess', chatId: 'c@wa' }), ...over.store },
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
