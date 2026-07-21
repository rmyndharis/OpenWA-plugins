import type {
  WebhookRequest,
  PluginConversationsCapability,
  PluginHandoverCapability,
  PluginEngineReadCapability,
  HandoverState,
} from '../types/openwa';
import type { MappingStore } from './mapping-store.ts';
import type { KeyedAsyncLock } from './chat-lock.ts';
import { shouldRelayOutbound, type ChatwootWebhookMessage } from './filters.ts';

export interface OutboundDeps {
  lock: KeyedAsyncLock;
  conversations: PluginConversationsCapability;
  handover: PluginHandoverCapability;
  // Resolves @lid -> @c.us so the per-chat lock key matches handleSent's for a migrated contact (the echo
  // marker + own-send handler must serialize on one canonical key).
  engine: PluginEngineReadCapability;
  store: MappingStore;
  inboxId: number;
  log: (m: string, e?: unknown) => void;
}

// Chatwoot → WhatsApp. `conversation_updated` drives handover; a relayable `message_created` is sent to
// WhatsApp under the per-chat lock (deduped on the Chatwoot message id). Throwing surfaces to the ingress
// pipeline for retry/DLReturn; a parse error is a 400 (never retried).
export async function handleOutbound(deps: OutboundDeps, req: WebhookRequest): Promise<{ status: number }> {
  let evt: ChatwootWebhookMessage;
  try {
    evt = JSON.parse(req.rawBody) as ChatwootWebhookMessage;
  } catch {
    return { status: 400 };
  }
  // The delivery's WA session scope. Present → the reverse lookup + dedup are tenant-scoped (isolating two
  // Chatwoot accounts that share a conversation id); absent → unscoped, same as a single-tenant install.
  const sessionId = req.sessionId;
  try {
    if (evt.event === 'conversation_updated') {
      await applyHandover(deps, sessionId, evt);
      return { status: 200 };
    }
    if (shouldRelayOutbound(evt, deps.inboxId)) await relay(deps, sessionId, evt);
  } catch (err) {
    deps.log('outbound failed', err);
    throw err;
  }
  return { status: 200 };
}

async function relay(deps: OutboundDeps, sessionId: string | undefined, evt: ChatwootWebhookMessage): Promise<void> {
  const conversationId = evt.conversation?.id;
  const text = evt.content;
  const media = firstMediaAttachment(evt);
  // A media-only agent reply (voice note, image, …) has no `content`, so gate on either text or media —
  // the old text-only guard dropped every attachment silently (#607).
  if (!conversationId || (!text && !media)) return;
  const target = await deps.store.getByConversation(conversationId, sessionId);
  if (!target) {
    deps.log(`no WA mapping for conversation ${conversationId}`);
    return;
  }
  const lockKey = await deps.engine.canonicalChatId(target.sessionId, target.chatId);
  await deps.lock.run(`${target.sessionId}:${lockKey}`, async () => {
    const id = evt.id !== undefined ? String(evt.id) : undefined;
    // Dedup, but mark only AFTER a successful send: a transient send failure must retry the reply, not be
    // silently suppressed as "already seen".
    //
    // Scoped by target.sessionId — the WA session that owns this conversation, just resolved from the
    // mapping — NOT the delivery's `sessionId`. Both identify the tenant (F-02/F-03), but the delivery
    // scope is `instance.sessionScope ?? undefined` and so is UNDEFINED for an unscoped instance, which
    // would put its markers in a global namespace keyed by bare Chatwoot message id: two tenants whose
    // ids collide could then suppress each other's replies. target.sessionId is always defined, and is
    // the same value relayMessage marks the own-send mirror under, so both halves of the echo guard
    // agree by construction.
    //
    // A pre-0.5.4 unscoped install has legacy `seen:cw:<id>` markers that this no longer reads. They are
    // deliberately abandoned rather than migrated: these markers are a short-lived (3-day TTL) cache, not
    // a ledger, duplicate deliveries are already dropped upstream by the ingress layer's providerDeliveryId
    // dedup, and honouring them would carry the cross-tenant collision forward. Worst case is one repeated
    // reply if Chatwoot re-announces an already-relayed message under a NEW delivery id during the upgrade
    // window — visible and self-correcting, unlike silently dropping a genuine agent reply.
    if (id && (await deps.store.hasSeen('cw', id, target.sessionId))) return;
    let res: unknown;
    if (media) {
      res = await deps.conversations.send({
        sessionId: target.sessionId,
        chatId: target.chatId,
        type: media.type,
        mediaUrl: media.url,
        text: text || undefined,
      });
    } else {
      res = await deps.conversations.send({ sessionId: target.sessionId, chatId: target.chatId, type: 'text', text });
    }
    if (id) await deps.store.markSeen('cw', id, target.sessionId);
    // Echo guard for the own-send relay (#615): the message we just sent to WhatsApp will come back as a
    // fromMe message:sent event. Mark its WA id seen — scoped by the WA session that will emit it
    // (target.sessionId, NOT the delivery scope) — so handleSent recognizes it as ours and skips it. Held
    // inside this lock, so the mark lands before message:sent can acquire the same per-chat lock.
    const sentId = (res as { messageId?: string } | null)?.messageId;
    if (sentId) {
      await deps.store.markSeen('wa', sentId, target.sessionId);
    } else {
      // No id to key the echo guard on (an engine that returns an empty messageId — e.g. Baileys' `?? ''`).
      // The reply's own message:sent could then be re-relayed as a duplicate; surface it rather than fail
      // silently open.
      deps.log('conversation.send returned no message id; own-send echo guard skipped for this reply');
    }
  });
}

// First attachment with a downloadable URL wins (a WhatsApp message carries one media). The host fetches
// the URL by its SSRF-guarded media-by-URL path, so no bytes cross the sandbox. Audio relays as a PTT
// voice note — the common agent action is recording voice; a plain audio file is a rare exception.
function firstMediaAttachment(
  evt: ChatwootWebhookMessage,
): { type: 'image' | 'video' | 'voice' | 'file'; url: string } | undefined {
  for (const a of evt.attachments ?? []) {
    if (!a?.data_url) continue;
    const type = a.file_type === 'image' ? 'image' : a.file_type === 'video' ? 'video' : a.file_type === 'audio' ? 'voice' : 'file';
    return { type, url: a.data_url };
  }
  return undefined;
}

// Human handover is driven by the assignee_id transition, NOT by status (status:'open' is not a human
// signal — the adapter itself opens conversations). resolved => closed; assignee set => human; cleared => bot.
function assigneeChange(evt: ChatwootWebhookMessage): { changed: boolean; assignee: number | undefined } {
  // Guard each element: `changed_attributes` is untrusted parsed JSON, so a non-object entry (e.g. `null`)
  // would make `'assignee_id' in a` throw a TypeError → an endless retry of a signed-but-malformed event.
  const attr = (evt.changed_attributes ?? []).find(a => a != null && typeof a === 'object' && 'assignee_id' in a)?.[
    'assignee_id'
  ];
  const assignee = evt.conversation?.meta?.assignee?.id ?? (attr?.current_value as number | undefined) ?? undefined;
  return { changed: attr !== undefined, assignee };
}

async function applyHandover(deps: OutboundDeps, sessionId: string | undefined, evt: ChatwootWebhookMessage): Promise<void> {
  const conversationId = evt.conversation?.id;
  if (conversationId === undefined) return;
  const target = await deps.store.getByConversation(conversationId, sessionId);
  if (!target) return;
  const status = evt.conversation?.status;
  const { changed, assignee } = assigneeChange(evt);
  let state: HandoverState | null = null;
  if (status === 'resolved') state = 'closed';
  else if (changed) state = assignee ? 'human' : 'bot';
  if (!state) return; // never infer human from status alone
  const resolved = state; // const so the closure keeps the non-null narrowing
  // instanceId in the mapping mirror = sessionId (a session-scoped instance is 1:1 with its session), so
  // inbound's ctx.mappings.upsert and this handover.set address the SAME conversation-mapping row. Lock on
  // the RAW chatId (not canonicalized): a handover webhook arrives independently of WA session state, and
  // canonicalChatId requires a live engine — resolving it here would wedge a handover while the session is
  // offline. Handover (a state-flag write) and relay (a message send) are independent, so they don't need
  // to serialize with each other; the raw key still serializes concurrent handover events for a chat.
  await deps.lock.run(`${target.sessionId}:${target.chatId}`, () =>
    deps.handover.set({ sessionId: target.sessionId, chatId: target.chatId, instanceId: target.sessionId }, resolved),
  );
}
