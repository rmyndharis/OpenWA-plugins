import type { WebhookRequest, PluginConversationsCapability, PluginHandoverCapability, HandoverState } from '../types/openwa';
import type { MappingStore } from './mapping-store.ts';
import type { KeyedAsyncLock } from './chat-lock.ts';
import { shouldRelayOutbound, type ChatwootWebhookMessage } from './filters.ts';

export interface OutboundDeps {
  lock: KeyedAsyncLock;
  conversations: PluginConversationsCapability;
  handover: PluginHandoverCapability;
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
  if (!conversationId || !text) return;
  const target = await deps.store.getByConversation(conversationId, sessionId);
  if (!target) {
    deps.log(`no WA mapping for conversation ${conversationId}`);
    return;
  }
  await deps.lock.run(`${target.sessionId}:${target.chatId}`, async () => {
    const id = evt.id !== undefined ? String(evt.id) : undefined;
    // Dedup, but mark only AFTER a successful send: a transient send failure must retry the reply, not be
    // silently suppressed as "already seen". Scope the marker by the delivery's session (F-02/F-03).
    if (id && (await deps.store.hasSeen('cw', id, sessionId))) return;
    await deps.conversations.send({ sessionId: target.sessionId, chatId: target.chatId, type: 'text', text });
    if (id) await deps.store.markSeen('cw', id, sessionId);
  });
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
  // inbound's ctx.mappings.upsert and this handover.set address the SAME conversation-mapping row.
  await deps.lock.run(`${target.sessionId}:${target.chatId}`, () =>
    deps.handover.set({ sessionId: target.sessionId, chatId: target.chatId, instanceId: target.sessionId }, resolved),
  );
}
