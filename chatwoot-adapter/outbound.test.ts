import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { handleOutbound, type OutboundDeps } from './outbound.ts';
import { KeyedAsyncLock } from './chat-lock.ts';
import { MappingStore } from './mapping-store.ts';
import type { WebhookRequest, PluginStorage, PluginMappingsCapability, HandoverState } from '../types/openwa';

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
function deps(
  over: {
    store?: Record<string, unknown>;
    rejectReplyTo?: string;
    handoverState?: HandoverState | null;
    mappings?: PluginMappingsCapability | null;
  } = {},
) {
  const sent: Array<{ sessionId?: string; chatId?: string; type: string; text?: string }> = [];
  const handovers: Array<[unknown, string]> = [];
  let currentState: HandoverState | null = over.handoverState ?? null;
  const defaultMappings: PluginMappingsCapability = {
    upsert: async () => {},
    get: async () => (currentState ? { providerConversationId: '55', handoverState: currentState } : null),
    getByProvider: async () => null,
  };
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
    handover: {
      set: async (k: unknown, s: HandoverState) => {
        currentState = s;
        handovers.push([k, s]);
      },
    },
    mappings: over.mappings === null ? undefined : (over.mappings ?? defaultMappings),
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
  return { sent, handovers, getState: () => currentState, deps: d };
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

test('a scoped webhook cannot send or change handover through another session legacy mapping', async () => {
  const store = new MappingStore(fakeStorage(), fakeMappings);
  await store.link('sessA', 'alice@wa', 'instA', { conversationId: 55, contactId: 1, sourceId: 'a' });
  const { deps: d, sent, handovers } = deps();
  d.store = store;
  await handleOutbound(d, reqScoped('sessB', {
    event: 'message_created', message_type: 'outgoing', private: false,
    id: 999, content: 'Private reply', inbox: { id: 7 }, conversation: { id: 55 },
  }));
  await handleOutbound(d, reqScoped('sessB', {
    event: 'conversation_updated',
    conversation: { id: 55, meta: { assignee: { id: 3 } } },
    changed_attributes: [{ assignee_id: { previous_value: null, current_value: 3 } }],
  }));
  assert.deepEqual(sent, []);
  assert.deepEqual(handovers, []);
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

test('handover: assign sets human, unassign sets bot, and resolving while assigned leaves handover unchanged', async () => {
  const { deps: d, handovers } = deps();
  await handleOutbound(d, req({ event: 'conversation_updated', conversation: { id: 55, meta: { assignee: { id: 3 } } }, changed_attributes: [{ assignee_id: { previous_value: null, current_value: 3 } }] }));
  await handleOutbound(d, req({ event: 'conversation_updated', conversation: { id: 55, meta: { assignee: null } }, changed_attributes: [{ assignee_id: { previous_value: 3, current_value: null } }] }));
  await handleOutbound(d, req({ event: 'conversation_updated', conversation: { id: 55, status: 'resolved', meta: { assignee: { id: 3 } } }, changed_attributes: [{ status: { previous_value: 'open', current_value: 'resolved' } }] }));
  await handleOutbound(d, req({ event: 'conversation_status_changed', id: 55, inbox_id: 7, status: 'resolved', meta: { assignee: { id: 3 } }, changed_attributes: null }));
  assert.deepEqual(handovers.map(h => h[1]), ['human', 'bot']);
});

test('root conversation updates apply assignment, removal and resolve-time unassignment in the configured account and inbox', async () => {
  const { deps: d, handovers } = deps();
  d.accountId = 3;
  for (const [status, assignee] of [['open', 3], ['open', null], ['resolved', null]] as const) {
    await handleOutbound(d, req({
      event: 'conversation_updated', id: 55, inbox_id: 7, account_id: 3, status,
      meta: { assignee: assignee ? { id: assignee, name: 'Sam' } : null },
      changed_attributes: [
        ...(status === 'resolved' ? [{ status: { previous_value: 'open', current_value: 'resolved' } }] : []),
        { assignee_id: { previous_value: 3, current_value: assignee } },
      ],
    }));
  }
  assert.deepEqual(handovers.map(h => h[1]), ['human', 'bot', 'bot']);
});

test('conversation updates from another account or inbox never change handover', async () => {
  const { deps: d, handovers } = deps();
  d.accountId = 3;
  const changed_attributes = [{ assignee_id: { previous_value: null, current_value: 3 } }];
  for (const body of [
    { event: 'conversation_updated', id: 55, inbox_id: 8, account_id: 3, changed_attributes },
    { event: 'conversation_updated', id: 55, inbox_id: 7, account_id: 4, changed_attributes },
    { event: 'conversation_updated', conversation: { id: 55, inbox_id: 8 }, account: { id: 3 }, changed_attributes },
    { event: 'conversation_updated', conversation: { id: 55 }, inbox: { id: 7 }, account: { id: 4 }, changed_attributes },
  ]) await handleOutbound(d, req(body));
  assert.deepEqual(handovers, []);
});

test('message events from another account never send a WhatsApp reply', async () => {
  const { deps: d, sent } = deps();
  d.accountId = 3;
  await handleOutbound(d, req({
    event: 'message_created', id: 9, message_type: 'outgoing', private: false,
    account: { id: 4 }, inbox: { id: 7 }, conversation: { id: 55 }, content: 'private reply',
  }));
  assert.deepEqual(sent, []);
});

test('malformed conversation change lists are ignored without retrying the delivery', async () => {
  const { deps: d, handovers } = deps();
  for (const changed_attributes of [null, {}, 'assignee_id', [null, { assignee_id: null }]]) {
    await handleOutbound(d, req({ event: 'conversation_updated', id: 55, inbox_id: 7, changed_attributes }));
  }
  assert.deepEqual(handovers, []);
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


test('explicit unassignment wins over stale assignee metadata', async () => {
  const { deps: d, handovers } = deps();
  await handleOutbound(d, req({ event: 'conversation_updated', id: 55, inbox_id: 7, status: 'open', meta: { assignee: { id: 3 } }, changed_attributes: [{ assignee_id: { previous_value: 3, current_value: null } }] }));
  assert.deepEqual(handovers.map(h => h[1]), ['bot']);
});

test('incomplete or malformed assignee transitions never release a handover', async () => {
  const { deps: d, handovers } = deps();
  for (const value of [{}, [], { current_value: '3' }, { current_value: false }]) {
    await handleOutbound(d, req({ event: 'conversation_updated', id: 55, inbox_id: 7, status: 'open', changed_attributes: [{ assignee_id: value }] }));
  }
  assert.deepEqual(handovers, []);
});

test('conflicting account and inbox identifiers are ignored', async () => {
  const { deps: d, sent, handovers } = deps();
  d.accountId = 3;
  await handleOutbound(d, req({
    event: 'conversation_updated', id: 55, account: { id: 3 }, account_id: 4, inbox_id: 7,
    changed_attributes: [{ assignee_id: { previous_value: null, current_value: 3 } }],
  }));
  await handleOutbound(d, req({ event: 'message_created', id: 9, content: 'private', message_type: 'outgoing', private: false, inbox: { id: 7 }, conversation: { id: 55, inbox_id: 8 } }));
  assert.deepEqual(sent, []);
  assert.deepEqual(handovers, []);
});

test('unassigning after a conversation is already resolved releases handover to bot', async () => {
  const { deps: d, handovers } = deps();
  await handleOutbound(d, req({
    event: 'conversation_updated', id: 55, inbox_id: 7, status: 'resolved',
    meta: { assignee: null },
    changed_attributes: [{ assignee_id: { previous_value: 3, current_value: null } }],
  }));
  assert.deepEqual(handovers.map(h => h[1]), ['bot']);
});

test('unassigning before resolving keeps handover at bot', async () => {
  const { deps: d, handovers, getState } = deps({ handoverState: 'human' });
  await handleOutbound(d, req({
    event: 'conversation_updated', id: 55, inbox_id: 7, status: 'open',
    meta: { assignee: null },
    changed_attributes: [{ assignee_id: { previous_value: 3, current_value: null } }],
  }));
  await handleOutbound(d, req({
    event: 'conversation_updated', id: 55, inbox_id: 7, status: 'resolved',
    meta: { assignee: null },
    changed_attributes: [{ status: { previous_value: 'open', current_value: 'resolved' } }],
  }));
  assert.deepEqual(handovers.map(h => h[1]), ['bot']);
  assert.equal(getState(), 'bot');
});

test('resolving a conversation that was never assigned never writes closed', async () => {
  for (const handoverState of [null, 'bot'] as const) {
    const { deps: d, handovers } = deps({ handoverState });
    await handleOutbound(d, req({
      event: 'conversation_updated', id: 55, inbox_id: 7, status: 'resolved',
      meta: { assignee: null },
      changed_attributes: [{ status: { previous_value: 'open', current_value: 'resolved' } }],
    }));
    await handleOutbound(d, req({
      event: 'conversation_status_changed', id: 55, inbox_id: 7, status: 'resolved',
      meta: { assignee: null },
      changed_attributes: null,
    }));
    assert.deepEqual(handovers, []);
  }
});

test('assigning an agent while status is resolved hands the conversation to human', async () => {
  const { deps: d, handovers } = deps();
  await handleOutbound(d, req({
    event: 'conversation_updated', id: 55, inbox_id: 7, status: 'resolved',
    meta: { assignee: { id: 3 } },
    changed_attributes: [{ assignee_id: { previous_value: null, current_value: 3 } }],
  }));
  assert.deepEqual(handovers.map(h => h[1]), ['human']);
});

test('an assignee change wins over the status-change release when one event carries both', async () => {
  const { deps: d, handovers } = deps({ handoverState: 'closed' });
  await handleOutbound(d, req({
    event: 'conversation_updated', id: 55, inbox_id: 7, status: 'open',
    meta: { assignee: null },
    changed_attributes: [
      { status: { previous_value: 'resolved', current_value: 'open' } },
      { assignee_id: { previous_value: null, current_value: 3 } },
    ],
  }));
  assert.deepEqual(handovers.map(h => h[1]), ['human']);
});

test('reopening a conversation with an existing assignee and no assignee change does not write handover', async () => {
  const { deps: d, handovers } = deps();
  await handleOutbound(d, req({
    event: 'conversation_updated', id: 55, inbox_id: 7, status: 'open',
    meta: { assignee: { id: 3 } },
    changed_attributes: [{ status: { previous_value: 'resolved', current_value: 'open' } }],
  }));
  await handleOutbound(d, req({
    event: 'conversation_status_changed', id: 55, inbox_id: 7, status: 'open',
    meta: { assignee: { id: 3 } },
    changed_attributes: null,
  }));
  assert.deepEqual(handovers, []);
});

test('a stale status-change webhook with meta.assignee null arriving after an assignment keeps handover at human', async () => {
  const { deps: d, handovers, getState } = deps({ handoverState: 'bot' });
  await handleOutbound(d, req({
    event: 'conversation_updated', id: 55, inbox_id: 7, status: 'open',
    meta: { assignee: { id: 3, type: 'user' } },
    changed_attributes: [{ assignee_id: { previous_value: null, current_value: 3 } }],
  }));
  await handleOutbound(d, req({
    event: 'conversation_status_changed', id: 55, inbox_id: 7, status: 'open',
    meta: { assignee: null },
    changed_attributes: null,
  }));
  await handleOutbound(d, req({
    event: 'conversation_updated',
    conversation: { id: 55, inbox_id: 7, status: 'open', meta: { assignee: null } },
    changed_attributes: [{ status: { previous_value: 'resolved', current_value: 'open' } }],
  }));
  assert.deepEqual(handovers.map(h => h[1]), ['human']);
  assert.equal(getState(), 'human');
});

test('a parked chat is released once, then a stale status webhook after an assignment leaves it with the agent', async () => {
  const { deps: d, handovers, getState } = deps({ handoverState: 'closed' });
  const stale = { id: 55, inbox_id: 7, status: 'open', meta: { assignee: null } };
  await handleOutbound(d, req({ event: 'conversation_status_changed', ...stale, changed_attributes: null }));
  await handleOutbound(d, req({
    event: 'conversation_updated', id: 55, inbox_id: 7, status: 'open',
    meta: { assignee: { id: 3, type: 'user' } },
    changed_attributes: [{ assignee_id: { previous_value: null, current_value: 3 } }],
  }));
  await handleOutbound(d, req({
    event: 'conversation_updated', ...stale,
    changed_attributes: [{ status: { previous_value: 'resolved', current_value: 'open' } }],
  }));
  assert.deepEqual(handovers.map(h => h[1]), ['bot', 'human']);
  assert.equal(getState(), 'human');
});

test('status changes on a conversation with meta.assignee null release a parked closed handover to bot once', async () => {
  const first = deps({ handoverState: 'closed' });
  first.deps.accountId = 3;
  await handleOutbound(first.deps, req({
    event: 'conversation_status_changed', id: 55, account: { id: 3 }, inbox_id: 7, status: 'resolved',
    meta: { assignee: null },
    changed_attributes: null,
  }));
  await handleOutbound(first.deps, req({
    event: 'conversation_updated',
    conversation: { id: 55, inbox_id: 7, account_id: 3, status: 'open', meta: { assignee: null } },
    changed_attributes: [{ status: { previous_value: 'resolved', current_value: 'open' } }],
  }));
  assert.deepEqual(first.handovers.map(h => h[1]), ['bot']);
  assert.equal(first.getState(), 'bot');

  const second = deps({ handoverState: 'closed' });
  second.deps.accountId = 3;
  await handleOutbound(second.deps, req({
    event: 'conversation_updated',
    conversation: { id: 55, inbox_id: 7, account_id: 3, status: 'open', meta: { assignee: null } },
    changed_attributes: [{ status: { previous_value: 'resolved', current_value: 'open' } }],
  }));
  assert.deepEqual(second.handovers.map(h => h[1]), ['bot']);
  assert.equal(second.getState(), 'bot');
});

test('status changes with meta.assignee null never write when stored handover state is bot or human', async () => {
  for (const initialState of ['bot', 'human'] as const) {
    const { deps: d, handovers, getState } = deps({ handoverState: initialState });
    await handleOutbound(d, req({
      event: 'conversation_status_changed', id: 55, inbox_id: 7, status: 'open',
      meta: { assignee: null },
      changed_attributes: null,
    }));
    await handleOutbound(d, req({
      event: 'conversation_updated', id: 55, inbox_id: 7, status: 'resolved',
      meta: { assignee: null },
      changed_attributes: [{ status: { previous_value: 'open', current_value: 'resolved' } }],
    }));
    assert.deepEqual(handovers, []);
    assert.equal(getState(), initialState);
  }
});

test('status changes on a closed chat with a human assignee never release handover', async () => {
  for (const assignee of [{ id: 3, type: 'user' }, { id: 3 }, { id: 3, type: 'custom' }]) {
    const { deps: d, handovers, getState } = deps({ handoverState: 'closed' });
    await handleOutbound(d, req({
      event: 'conversation_status_changed', id: 55, inbox_id: 7, status: 'open',
      meta: { assignee },
      changed_attributes: null,
    }));
    await handleOutbound(d, req({
      event: 'conversation_updated', id: 55, inbox_id: 7, status: 'open',
      meta: { assignee },
      changed_attributes: [{ status: { previous_value: 'resolved', current_value: 'open' } }],
    }));
    assert.deepEqual(handovers, []);
    assert.equal(getState(), 'closed');
  }
});

test('status changes on a closed chat with an agent_bot or captain_assistant assignee release handover to bot', async () => {
  const botCase = deps({ handoverState: 'closed' });
  await handleOutbound(botCase.deps, req({
    event: 'conversation_status_changed', id: 55, inbox_id: 7, status: 'pending',
    meta: { assignee: { id: 2, type: 'agent_bot' } },
    changed_attributes: null,
  }));
  assert.deepEqual(botCase.handovers.map(h => h[1]), ['bot']);

  const captainCase = deps({ handoverState: 'closed' });
  await handleOutbound(captainCase.deps, req({
    event: 'conversation_updated', id: 55, inbox_id: 7, status: 'resolved',
    meta: { assignee: { id: 1, type: 'captain_assistant' } },
    changed_attributes: [{ status: { previous_value: 'pending', current_value: 'resolved' } }],
  }));
  assert.deepEqual(captainCase.handovers.map(h => h[1]), ['bot']);
});

test('assigneeChange fallback ignores agent_bot and captain_assistant in meta.assignee while accepting human assignees', async () => {
  for (const botAssignee of [{ id: 2, type: 'agent_bot' }, { id: 1, type: 'captain_assistant' }]) {
    const { deps: d, handovers } = deps();
    await handleOutbound(d, req({
      event: 'conversation_updated', id: 55, inbox_id: 7, status: 'pending',
      meta: { assignee: botAssignee },
      changed_attributes: [{ assignee_id: { previous_value: null } }],
    }));
    assert.deepEqual(handovers, []);
  }
  const { deps: d, handovers } = deps();
  for (const humanAssignee of [{ id: 3, type: 'user' }, { id: 4 }]) {
    await handleOutbound(d, req({
      event: 'conversation_updated', id: 55, inbox_id: 7, status: 'open',
      meta: { assignee: humanAssignee },
      changed_attributes: [{ assignee_id: { previous_value: null } }],
    }));
  }
  assert.deepEqual(handovers.map(h => h[1]), ['human', 'human']);
});

test('conversation_updated without assignee or status change returns without reading storage or failing on a legacy mapping', async () => {
  let reads = 0;
  const rawStorage = fakeStorage();
  const countedStorage: PluginStorage = {
    get: async <T>(k: string) => {
      reads++;
      return rawStorage.get<T>(k);
    },
    set: rawStorage.set,
    delete: rawStorage.delete,
    list: rawStorage.list,
  };
  await new MappingStore(countedStorage, fakeMappings).link('sess', 'c@wa', 'sess', { conversationId: 55, contactId: 1, sourceId: 's' });
  const cfg = { baseUrl: 'https://chat.acme.com', accountId: 3, inboxId: 7 };
  const destStore = new MappingStore(countedStorage, fakeMappings).forDestination(cfg);
  const { deps: d, handovers } = deps({ store: destStore as unknown as Record<string, unknown> });
  d.store = destStore;
  reads = 0;

  const r = await handleOutbound(d, req({
    event: 'conversation_updated', id: 55, inbox_id: 7, status: 'open',
    meta: { assignee: null },
    changed_attributes: [{ waiting_since: { previous_value: 10, current_value: null } }, { label_list: { previous_value: [], current_value: ['vip'] } }],
  }));
  assert.deepEqual(r, { status: 200 });
  assert.equal(reads, 0);
  assert.deepEqual(handovers, []);

  await assert.rejects(
    handleOutbound(d, req({
      event: 'conversation_updated', id: 55, inbox_id: 7, status: 'open',
      meta: { assignee: { id: 3, type: 'user' } },
      changed_attributes: [{ assignee_id: { previous_value: null, current_value: 3 } }],
    })),
    /current destination/,
  );
});

test('status entries whose previous_value equals current_value or are not objects are not treated as status changes', async () => {
  const { deps: d, handovers, getState } = deps({ handoverState: 'closed' });
  for (const statusEntry of [
    { previous_value: 'open', current_value: 'open' },
    null,
    'open',
    [],
  ]) {
    await handleOutbound(d, req({
      event: 'conversation_updated', id: 55, inbox_id: 7, status: 'open',
      meta: { assignee: null },
      changed_attributes: [{ status: statusEntry }],
    }));
  }
  assert.deepEqual(handovers, []);
  assert.equal(getState(), 'closed');
});

test('status-change release does not write when the mappings capability or mapping row is absent', async () => {
  const noCap = deps({ mappings: null });
  await handleOutbound(noCap.deps, req({
    event: 'conversation_status_changed', id: 55, inbox_id: 7, status: 'resolved',
    meta: { assignee: null },
    changed_attributes: null,
  }));
  assert.deepEqual(noCap.handovers, []);

  const noRow = deps({ handoverState: null });
  await handleOutbound(noRow.deps, req({
    event: 'conversation_status_changed', id: 55, inbox_id: 7, status: 'resolved',
    meta: { assignee: null },
    changed_attributes: null,
  }));
  await handleOutbound(noRow.deps, req({
    event: 'conversation_updated', id: 55, inbox_id: 7, status: 'resolved',
    meta: { assignee: null },
    changed_attributes: [{ status: { previous_value: 'open', current_value: 'resolved' } }],
  }));
  assert.deepEqual(noRow.handovers, []);
});

test('status changes without meta or without an assignee key never write handover', async () => {
  const { deps: d, handovers } = deps({ handoverState: 'closed' });
  d.accountId = 3;
  for (const body of [
    {
      event: 'conversation_status_changed', id: 55, account: { id: 3 }, inbox_id: 7, status: 'resolved',
      changed_attributes: null,
    },
    {
      event: 'conversation_status_changed', id: 55, account: { id: 3 }, inbox_id: 7, status: 'open',
      meta: {} as { assignee?: null },
      changed_attributes: null,
    },
    {
      event: 'conversation_updated', id: 55, account_id: 3, inbox_id: 7, status: 'resolved',
      changed_attributes: [{ status: { previous_value: 'open', current_value: 'resolved' } }],
    },
    {
      event: 'conversation_updated',
      conversation: { id: 55, account_id: 3, inbox_id: 7, status: 'open', meta: {} as { assignee?: null } },
      changed_attributes: [{ status: { previous_value: 'resolved', current_value: 'open' } }],
    },
  ]) await handleOutbound(d, req(body));
  assert.deepEqual(handovers, []);
});

test('wildcard sessionId="*" ingress delivery resolves mapped conversation like unscoped delivery', async () => {
  const store = new MappingStore(fakeStorage(), fakeMappings);
  await store.link('sess', 'c@wa', 'sess', { conversationId: 55, contactId: 1, sourceId: 'a' });
  const sent: unknown[] = [];
  const handovers: Array<[unknown, string]> = [];
  const d = {
    lock: new KeyedAsyncLock(),
    conversations: { send: async (e: unknown) => { sent.push(e); return { messageId: 'WA_W', timestamp: 0 }; } },
    handover: { set: async (k: unknown, s: string) => void handovers.push([k, s]) },
    engine: { canonicalChatId: async (_s: string, c: string) => c },
    store,
    inboxId: 7,
    log: () => {},
  } as unknown as OutboundDeps;

  await handleOutbound(
    d,
    reqScoped('*', { event: 'message_created', message_type: 'outgoing', private: false, id: 77, content: 'wildcard reply', inbox: { id: 7 }, conversation: { id: 55 } }),
  );
  await handleOutbound(
    d,
    reqScoped('*', {
      event: 'conversation_updated', id: 55, inbox_id: 7, status: 'open',
      meta: { assignee: { id: 3 } },
      changed_attributes: [{ assignee_id: { previous_value: null, current_value: 3 } }],
    }),
  );
  assert.deepEqual(sent, [{ sessionId: 'sess', chatId: 'c@wa', type: 'text', text: 'wildcard reply' }]);
  assert.deepEqual(handovers.map(h => h[1]), ['human']);
});
