import type { IncomingMessage } from '../types/openwa';
import { shouldRelayInbound } from './filters.ts';
import { relayMessage, ensureConversation, refreshContactName, type InboundDeps } from './relay.ts';
import { backfillHistory } from './backfill.ts';

export type { InboundDeps };

// WhatsApp → Chatwoot. Filter, then run resolve+post under the per-chat lock so two near-simultaneous
// first messages can't create duplicate Chatwoot contacts/conversations. Dedup is a mark-before-act
// check-and-set inside the lock (at-most-once; a failed post won't re-relay).
export async function handleInbound(
  deps: InboundDeps,
  sessionId: string,
  source: string,
  msg: IncomingMessage,
): Promise<void> {
  if (!shouldRelayInbound(msg, source, deps.relayGroups)) return;
  await deps.lock.run(`${sessionId}:${msg.chatId}`, async () => {
    try {
      // Mark-before-act: inbound is deliberately at-most-once (a failed post won't re-relay). Scoped by
      // session so two tenants' WA message ids can't collide in the shared plugin store.
      if (await deps.store.hasSeen('wa', msg.id, sessionId)) return;
      await deps.store.markSeen('wa', msg.id, sessionId);
      const { conversationId, created } = await resolveConversation(deps, sessionId, msg);
      // Lazy backfill: the first time this chat maps, replay its recent history (older messages, both
      // directions, deduped) BEFORE posting this one — so the thread reads chronologically and this
      // message's quote resolves against a just-posted source_id. This message is already markSeen, so
      // backfill skips it and it posts last, below.
      if (created && deps.backfillLimit > 0) {
        await backfillHistory(deps, sessionId, msg.chatId, conversationId);
      }
      await relayMessage(deps, conversationId, msg, 'incoming');
    } catch (err) {
      deps.log('inbound relay failed', err);
    }
  });
}

async function resolveConversation(
  deps: InboundDeps,
  sessionId: string,
  msg: IncomingMessage,
): Promise<{ conversationId: number; created: boolean }> {
  const existing = await deps.store.getByChat(sessionId, msg.chatId); // re-read inside the lock
  if (existing) {
    await refreshContactName(deps, sessionId, msg, existing);
    return { conversationId: existing.conversationId, created: false };
  }
  const name = msg.isGroup
    ? `Group ${msg.chatId}`
    : msg.contact?.pushName || msg.contact?.name || msg.senderPhone || msg.chatId;
  const conversationId = await ensureConversation(deps, sessionId, msg.chatId, {
    name,
    phone: msg.isGroup ? undefined : msg.senderPhone ?? undefined,
  });
  return { conversationId, created: true };
}
