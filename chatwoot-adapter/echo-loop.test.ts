import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleSent } from './sent.ts';
import { handleOutbound, type OutboundDeps } from './outbound.ts';
import type { InboundDeps } from './relay.ts';
import { KeyedAsyncLock } from './chat-lock.ts';
import { MappingStore } from './mapping-store.ts';
import type {
  IncomingMessage,
  WebhookRequest,
  PluginStorage,
  PluginMappingsCapability,
} from '../types/openwa';

// The WhatsApp -> Chatwoot -> WhatsApp echo loop (#615 regression).
//
// handleSent mirrors an own send into Chatwoot as 'outgoing'. Chatwoot then fires message_created for
// that very mirror, and it is 'outgoing' + non-private + in our inbox — so shouldRelayOutbound passes it
// and the adapter sends it to WhatsApp AGAIN. The recipient really does get two messages.
//
// The reverse direction was already guarded (outbound marks the WA id it sends, so handleSent skips its
// own agent replies). These tests exercise the missing half end-to-end: both handlers over ONE real
// MappingStore and ONE lock, so the marker's storage key — and its session scope — are the real ones.

const CONVERSATION_ID = 55;
const INBOX_ID = 7;
const CHAT_ID = '621@c.us';

const own = {
  id: 'o1', from: 'me@c.us', to: CHAT_ID, chatId: CHAT_ID, body: 'from my phone', type: 'chat',
  timestamp: 0, fromMe: true, isGroup: false,
} as IncomingMessage;

function fakeStorage(): PluginStorage {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => (m.has(k) ? (m.get(k) as T) : null),
    set: async (k: string, v: unknown) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
    list: async (prefix?: string) => [...m.keys()].filter(k => !prefix || k.startsWith(prefix)),
  };
}
const fakeMappings: PluginMappingsCapability = {
  upsert: async () => {}, get: async () => null, getByProvider: async () => null,
};

// One store + one lock shared by both directions, as in the running plugin.
async function wire(sessionId = 'sess') {
  const store = new MappingStore(fakeStorage(), fakeMappings);
  const lock = new KeyedAsyncLock();
  const engine = { canonicalChatId: async (_s: string, c: string) => c };
  // Chatwoot assigns an autoincrement id to every message the adapter posts.
  let nextChatwootId = 4242;
  const posted: Array<{ conversationId: number; content: string; messageType?: string; id: number }> = [];
  const client = {
    postText: async (conversationId: number, content: string, o?: { messageType?: string }) => {
      const id = nextChatwootId++;
      posted.push({ conversationId, content, messageType: o?.messageType, id });
      return { id };
    },
    postMedia: async (conversationId: number, content: string, _f: unknown, o?: { messageType?: string }) => {
      const id = nextChatwootId++;
      posted.push({ conversationId, content, messageType: o?.messageType, id });
      return { id };
    },
  };

  // The chat is already mapped — handleSent relays into an existing conversation, never creates.
  await store.link(sessionId, CHAT_ID, 'inst', {
    conversationId: CONVERSATION_ID, contactId: 9, sourceId: 'src', name: 'Budi',
  });

  const inbound = {
    lock, client, store, engine, instanceId: 'inst',
    relayGroups: true, relayMedia: true, backfillLimit: 0, backfillAllOnce: false, log: () => {},
  } as unknown as InboundDeps;

  const sent: Array<{ chatId?: string; text?: string }> = [];
  const outbound = {
    lock, store, engine,
    conversations: { send: async (e: { chatId?: string; text?: string }) => { sent.push(e); return { messageId: 'wa-reply' }; } },
    handover: { set: async () => {} },
    inboxId: INBOX_ID,
    log: () => {},
  } as unknown as OutboundDeps;

  return { store, inbound, outbound, posted, sent };
}

// The webhook Chatwoot fires for a message the ADAPTER just created via postText.
function mirrorWebhook(chatwootMessageId: number, sessionId?: string): WebhookRequest {
  const body = JSON.stringify({
    event: 'message_created',
    message_type: 'outgoing', // the mirror is 'outgoing' — shouldRelayOutbound does NOT drop it
    private: false,
    id: chatwootMessageId,
    content: own.body,
    inbox: { id: INBOX_ID },
    conversation: { id: CONVERSATION_ID },
  });
  return {
    instanceId: 'inst', sessionId, method: 'POST', headers: {}, query: {},
    body, rawBody: body, verified: true, deliveryId: 'd1',
  };
}

test('an own send mirrored into Chatwoot is NOT sent back to WhatsApp (session-scoped delivery)', async () => {
  const { inbound, outbound, posted, sent } = await wire();

  await handleSent(inbound, 'sess', 'Engine', own);
  assert.equal(posted.length, 1, 'the own send should be mirrored into Chatwoot exactly once');
  assert.equal(posted[0].messageType, 'outgoing');

  const res = await handleOutbound(outbound, mirrorWebhook(posted[0].id, 'sess'));

  assert.deepEqual(res, { status: 200 });
  assert.deepEqual(sent, [], 'the mirror bounced back out of Chatwoot and was re-sent — the recipient gets two messages');
});

test('an own send mirrored into Chatwoot is NOT sent back to WhatsApp (delivery with NO session scope)', async () => {
  // An integration instance without a session scope yields sessionId: undefined on every delivery
  // (ingress.service: `instance.sessionScope ?? undefined`). The guard must not depend on that value:
  // outbound.relay scopes its dedup on target.sessionId, resolved from the conversation mapping, which
  // is the same scope relayMessage marked the mirror under. Keying on the delivery scope instead would
  // read a different marker here and loop.
  const { inbound, outbound, posted, sent } = await wire();

  await handleSent(inbound, 'sess', 'Engine', own);
  const res = await handleOutbound(outbound, mirrorWebhook(posted[0].id, undefined));

  assert.deepEqual(res, { status: 200 });
  assert.deepEqual(sent, [], 'an unscoped delivery missed the session-scoped marker and re-sent the mirror');
});

test('a genuine agent reply from Chatwoot IS still relayed to WhatsApp', async () => {
  // The guard must suppress only the adapter's own mirror, not a real agent reply — which carries a
  // Chatwoot id the adapter never created.
  const { outbound, sent } = await wire();

  await handleOutbound(outbound, mirrorWebhook(999, 'sess'));

  assert.equal(sent.length, 1, 'a real agent reply must still reach WhatsApp');
});

test("one tenant's mirror marker does not suppress another tenant's reply with the same Chatwoot id", async () => {
  // Chatwoot message ids are per-account autoincrement, so two tenants collide on low ids routinely.
  // The echo marker must therefore never live in a global namespace keyed by the bare id — suppressing a
  // genuine agent reply is a worse failure than the duplicate this guard exists to prevent.
  const store = new MappingStore(fakeStorage(), fakeMappings);
  const lock = new KeyedAsyncLock();
  const engine = { canonicalChatId: async (_s: string, c: string) => c };
  // Two WA sessions whose Chatwoot accounts both number this conversation 55.
  await store.link('sessA', 'alice@c.us', 'instA', { conversationId: 55, contactId: 1, sourceId: 'a' });
  await store.link('sessB', 'bob@c.us', 'instB', { conversationId: 55, contactId: 2, sourceId: 'b' });

  // Tenant A mirrors an own send; Chatwoot numbers it 60, and the guard marks it.
  const posted: Array<{ id: number }> = [];
  const inboundA = {
    lock, store, engine, instanceId: 'instA', relayGroups: true, relayMedia: true,
    backfillLimit: 0, backfillAllOnce: false, log: () => {},
    client: { postText: async () => { posted.push({ id: 60 }); return { id: 60 }; }, postMedia: async () => ({ id: 60 }) },
  } as unknown as InboundDeps;
  await handleSent(inboundA, 'sessA', 'Engine', { ...own, chatId: 'alice@c.us' } as IncomingMessage);
  assert.equal(posted.length, 1);

  // Tenant B's agent now replies, and Chatwoot happens to number THAT message 60 as well. The delivery
  // is UNSCOPED, which is what makes this bite: a guard that keyed the marker on the delivery scope would
  // fall back to a global `seen:cw:60` and find tenant A's marker sitting there.
  const sent: Array<{ chatId?: string }> = [];
  const outboundB = {
    lock, store, engine, inboxId: INBOX_ID, log: () => {},
    conversations: { send: async (e: { chatId?: string }) => { sent.push(e); return { messageId: 'wa-b' }; } },
    handover: { set: async () => {} },
  } as unknown as OutboundDeps;
  await handleOutbound(outboundB, mirrorWebhook(60, undefined));

  assert.equal(sent.length, 1, "tenant B's genuine reply was suppressed by tenant A's echo marker");
  assert.equal(sent[0].chatId, 'bob@c.us');
});
