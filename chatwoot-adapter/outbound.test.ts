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

// `rejectReplyTo` models the engine refusing one specific quote target (a message outside the
// engine's retained window), the way ctx.conversations.send surfaces MessageNotFoundError.
function deps(over: { store?: Record<string, unknown>; rejectReplyTo?: string } = {}) {
  const sent: Array<{ sessionId?: string; chatId?: string; type: string; text?: string }> = [];
  const handovers: Array<[unknown, string]> = [];
  const d = {
    lock: new KeyedAsyncLock(),
    conversations: {
      // Mirrors the host facade (core conversation-send-facade.ts): a media envelope carrying BOTH a
      // mediaUrl and a replyTo is rejected outright — the engine media path cannot quote. Modelling it
      // here is what stops a "quoted attachment" envelope from passing the suite and dead-lettering live.
      send: async (e: { sessionId?: string; chatId?: string; type: string; text?: string; mediaUrl?: string; replyTo?: string }) => {
        if (e.replyTo && e.mediaUrl && e.type !== 'text') {
          throw new Error('conversation.send: replyTo is not supported for media messages');
        }
        if (e.replyTo && e.replyTo === over.rejectReplyTo) throw new Error('MessageNotFoundError');
        sent.push(e);
      },
    },
    handover: { set: async (k: unknown, s: string) => void handovers.push([k, s]) },
    engine: { canonicalChatId: async (_s: string, c: string) => c },
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

test('an agent "Reply to" rides out as a WhatsApp quote (replyTo = quoted source_id)', async () => {
  const { deps: d, sent } = deps();
  await handleOutbound(
    d,
    req({
      event: 'message_created', message_type: 'outgoing', private: false, id: 6, content: 'quoted answer',
      inbox: { id: 7 }, conversation: { id: 55 },
      content_attributes: { in_reply_to: 41, in_reply_to_external_id: 'WA_QUOTED_1' },
    }),
  );
  assert.deepEqual(sent, [{ sessionId: 'sess', chatId: 'c@wa', type: 'text', text: 'quoted answer', replyTo: 'WA_QUOTED_1' }]);
});

test('a reply whose quoted message has no external id goes unquoted, not dropped', async () => {
  const { deps: d, sent } = deps();
  await handleOutbound(
    d,
    req({
      event: 'message_created', message_type: 'outgoing', private: false, id: 7, content: 'plain',
      inbox: { id: 7 }, conversation: { id: 55 },
      content_attributes: { in_reply_to: 41 },
    }),
  );
  assert.deepEqual(sent, [{ sessionId: 'sess', chatId: 'c@wa', type: 'text', text: 'plain' }]);
});

test('a quoted reply with an attachment omits replyTo — the media envelope must not carry a quote', async () => {
  // The engine media path cannot quote, and the host REJECTS an envelope that carries both (see the
  // fake send above). Delivering the attachment unquoted beats dead-lettering it for a quote decoration.
  const { deps: d, sent } = deps();
  await handleOutbound(
    d,
    req({
      event: 'message_created', message_type: 'outgoing', private: false, id: 10, content: 'see this',
      inbox: { id: 7 }, conversation: { id: 55 },
      attachments: [{ id: 1, file_type: 'image', data_url: 'https://chat.acme.com/blob/x.jpg' }],
      content_attributes: { in_reply_to_external_id: 'WA_QUOTED_2' },
    }),
  );
  assert.deepEqual(sent, [
    { sessionId: 'sess', chatId: 'c@wa', type: 'image', mediaUrl: 'https://chat.acme.com/blob/x.jpg', text: 'see this' },
  ]);
});

test('an unresolvable quote target still delivers the reply, unquoted', async () => {
  // The quoted message can fall outside the engine's retained window (wwjs keeps ~100 per chat, Baileys
  // 5000 overall), and Chatwoot happily hands back its id anyway. Losing the quote is acceptable; losing
  // the agent's reply to the dead-letter queue is not.
  const { deps: d, sent } = deps({ rejectReplyTo: 'WA_GONE' });
  await handleOutbound(
    d,
    req({
      event: 'message_created', message_type: 'outgoing', private: false, id: 11, content: 'still answers',
      inbox: { id: 7 }, conversation: { id: 55 },
      content_attributes: { in_reply_to: 41, in_reply_to_external_id: 'WA_GONE' },
    }),
  );
  assert.deepEqual(sent, [{ sessionId: 'sess', chatId: 'c@wa', type: 'text', text: 'still answers' }]);
});

test('relays an outbound audio attachment as a WhatsApp voice note (#607)', async () => {
  const { deps: d, sent } = deps();
  await handleOutbound(
    d,
    req({
      event: 'message_created', message_type: 'outgoing', private: false, id: 8, inbox: { id: 7 }, conversation: { id: 55 },
      attachments: [{ id: 1, file_type: 'audio', data_url: 'https://chat.acme.com/blob/a.ogg' }],
    }),
  );
  assert.deepEqual(sent, [
    { sessionId: 'sess', chatId: 'c@wa', type: 'voice', mediaUrl: 'https://chat.acme.com/blob/a.ogg', text: undefined },
  ]);
});

test('relays an outbound image attachment with its caption (#607)', async () => {
  const { deps: d, sent } = deps();
  await handleOutbound(
    d,
    req({
      event: 'message_created', message_type: 'outgoing', private: false, id: 9, content: 'look', inbox: { id: 7 }, conversation: { id: 55 },
      attachments: [{ id: 1, file_type: 'image', data_url: 'https://chat.acme.com/blob/x.jpg' }],
    }),
  );
  assert.deepEqual(sent, [
    { sessionId: 'sess', chatId: 'c@wa', type: 'image', mediaUrl: 'https://chat.acme.com/blob/x.jpg', text: 'look' },
  ]);
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
    engine: { canonicalChatId: async (_s: string, c: string) => c },
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
    engine: { canonicalChatId: async (_s: string, c: string) => c },
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

test('marks the WA send id as seen (scoped by the WA session) so message:sent does not echo the agent reply', async () => {
  const marks: Array<[string, string, string | undefined]> = [];
  const d = {
    lock: new KeyedAsyncLock(),
    // conversations.send returns { messageId, timestamp } — the engine's serialized id of the sent
    // message, which is the same id the subsequent message:sent event carries.
    conversations: { send: async () => ({ messageId: 'WA_9', timestamp: 0 }) },
    handover: { set: async () => {} },
    engine: { canonicalChatId: async (_s: string, c: string) => c },
    store: {
      hasSeen: async () => false,
      markSeen: async (kind: string, id: string, scope?: string) => void marks.push([kind, id, scope]),
      // The WA session that owns this chat (target.sessionId) differs from the delivery scope on purpose.
      getByConversation: async () => ({ sessionId: 'sessX', chatId: 'c@wa' }),
    },
    inboxId: 7,
    log: () => {},
  } as unknown as OutboundDeps;
  await handleOutbound(
    d,
    req({ event: 'message_created', message_type: 'outgoing', private: false, id: 5, content: 'reply', inbox: { id: 7 }, conversation: { id: 55 } }),
  );
  assert.ok(
    marks.some(([k, id, scope]) => k === 'wa' && id === 'WA_9' && scope === 'sessX'),
    `expected a wa:WA_9 marker scoped by the WA session sessX, got ${JSON.stringify(marks)}`,
  );
});

test('relay canonicalizes the WA chat id (via engine.canonicalChatId) so its lock serializes with the own-send handler', async () => {
  const calls: Array<[string, string]> = [];
  const d = {
    lock: new KeyedAsyncLock(),
    conversations: { send: async () => ({ messageId: 'X', timestamp: 0 }) },
    handover: { set: async () => {} },
    engine: {
      canonicalChatId: async (s: string, c: string) => {
        calls.push([s, c]);
        return c === '628@lid' ? '628@c.us' : c;
      },
    },
    store: {
      hasSeen: async () => false,
      markSeen: async () => {},
      getByConversation: async () => ({ sessionId: 'sessX', chatId: '628@lid' }),
    },
    inboxId: 7,
    log: () => {},
  } as unknown as OutboundDeps;
  await handleOutbound(
    d,
    req({ event: 'message_created', message_type: 'outgoing', private: false, id: 5, content: 'r', inbox: { id: 7 }, conversation: { id: 55 } }),
  );
  assert.deepEqual(calls, [['sessX', '628@lid']]); // canonicalized with the target's session + raw chatId, before locking
});

test('handover guards a non-object changed_attributes element (no throw / retry loop)', async () => {
  const { deps: d, handovers } = deps();
  const r = await handleOutbound(d, req({ event: 'conversation_updated', conversation: { id: 55 }, changed_attributes: [null, 'x', { assignee_id: { current_value: 3 } }] }));
  assert.deepEqual(r, { status: 200 });
  assert.deepEqual(handovers.map(h => h[1]), ['human']); // the valid element is still read
});

test('every attachment of a multi-attachment agent reply reaches WhatsApp', async () => {
  // Chatwoot models attachments as a has_many on ONE message_created, so an agent sending three files
  // produces one webhook carrying three. Relaying only the first dropped the rest with no log, and the
  // 'cw' marker written straight after made the loss permanent: a re-delivery short-circuits as seen.
  const { deps: d, sent } = deps();
  await handleOutbound(
    d,
    req({
      event: 'message_created', message_type: 'outgoing', private: false, id: 21, content: 'here are both',
      inbox: { id: 7 }, conversation: { id: 55 },
      attachments: [
        { id: 1, file_type: 'image', data_url: 'https://chat.acme.com/blob/a.jpg' },
        { id: 2, file_type: 'file', data_url: 'https://chat.acme.com/blob/b.pdf' },
      ],
    }),
  );
  assert.equal(sent.length, 2, 'one WhatsApp message per attachment');
  // The caption rides the first only: repeating it would post the agent's text once per file.
  assert.deepEqual(sent, [
    { sessionId: 'sess', chatId: 'c@wa', type: 'image', mediaUrl: 'https://chat.acme.com/blob/a.jpg', text: 'here are both' },
    { sessionId: 'sess', chatId: 'c@wa', type: 'file', mediaUrl: 'https://chat.acme.com/blob/b.pdf', text: undefined },
  ]);
});

test('a mid-reply send failure still leaves the attachments that landed echo-guarded', async () => {
  // The echo guard is claimed per send, not after the whole reply. Without that, a reply whose second
  // attachment fails would leave the first one sent but unguarded: the retry re-sends it (the
  // documented duplicate-over-loss posture) AND its first copy's message:sent would be mirrored back
  // into Chatwoot as a fresh message.
  const marks: string[] = [];
  const { deps: d, sent } = deps({
    store: { markSeen: async (kind: string, id: string) => void marks.push(`${kind}:${id}`) },
  });
  let calls = 0;
  (d as unknown as { conversations: unknown }).conversations = {
    send: async (env: Record<string, unknown>) => {
      calls++;
      if (calls === 2) throw new Error('engine refused');
      sent.push(env as never);
      return { messageId: `WA${calls}` };
    },
  };

  await assert.rejects(() =>
    handleOutbound(
      d,
      req({
        event: 'message_created', message_type: 'outgoing', private: false, id: 31, inbox: { id: 7 },
        conversation: { id: 55 },
        attachments: [
          { id: 1, file_type: 'image', data_url: 'https://chat.acme.com/blob/a.jpg' },
          { id: 2, file_type: 'image', data_url: 'https://chat.acme.com/blob/b.jpg' },
        ],
      }),
    ));

  assert.equal(sent.length, 1, 'only the first attachment went out');
  assert.ok(marks.includes('wa:WA1'), `the first send must still be echo-guarded, saw ${JSON.stringify(marks)}`);
  // The Chatwoot-side marker must NOT be written: the reply did not complete, so the retry must run.
  assert.equal(marks.some((m) => m.startsWith('cw:')), false, JSON.stringify(marks));
});
