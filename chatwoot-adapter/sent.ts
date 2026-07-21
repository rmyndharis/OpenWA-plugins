import type { IncomingMessage } from '../types/openwa';
import { shouldRelayOwn } from './filters.ts';
import { relayMessage, type InboundDeps } from './relay.ts';

// WhatsApp → Chatwoot for the account's OWN outbound sends — messages composed on a linked phone / the
// WhatsApp mobile app / the OpenWA REST API — so the Chatwoot thread mirrors the full WhatsApp
// conversation (#615). Posts 'outgoing' into a conversation the INBOUND path already mapped.
//
// Relay-into-existing-only, never create: an own send whose chat isn't mapped yet is dropped. Creating a
// conversation on a miss would split a contact who has migrated to @lid — its @c.us mapping is invisible
// to a raw @lid lookup, and @lid->@c.us resolution is only best-effort (the lid->phone table is cold on
// a phone-only-contacted wwjs contact), so a "new" chat can't be told apart from a migrated one. Dropping
// is strictly safe (no duplicate conversation); the chat still appears once the customer replies inbound.
//
// Echo guard: the adapter's own Chatwoot-agent replies are ALSO fromMe and arrive here as message:sent.
// outbound.relay marks the WA id of every reply it sends (markSeen('wa', …)) on the same canonical
// per-chat lock, so the hasSeen check below recognizes and skips them. At-most-once (a failed post is
// not retried), like inbound.
//
// The OTHER leg of the loop is guarded inside relayMessage: the Chatwoot message this mirror creates is
// marked 'cw'-seen (under the same lock, before it is released), so the `message_created` Chatwoot fires
// for it is not relayed back out to WhatsApp as a duplicate.
export async function handleSent(
  deps: InboundDeps,
  sessionId: string,
  source: string,
  msg: IncomingMessage,
): Promise<void> {
  if (!shouldRelayOwn(msg, source, deps.relayGroups)) return;
  // Canonicalize @lid -> <phone>@c.us for the lock key. A send to a contact WhatsApp has migrated to @lid
  // resolves to the @lid address, so this message:sent carries chatId=@lid while outbound.relay locked
  // (and marked the echo on) the mapping's @c.us key. Locking on the canonical form makes both paths
  // serialize on the SAME key (when resolvable), so the echo marker is observed before this handler checks.
  const key = await deps.engine.canonicalChatId(sessionId, msg.chatId);
  await deps.lock.run(`${sessionId}:${key}`, async () => {
    try {
      if (await deps.store.hasSeen('wa', msg.id, sessionId)) return;
      const conversationId = await findMappedConversation(deps, sessionId, msg, key);
      if (conversationId === null) return; // unmapped chat — drop, never create (no split)
      await deps.store.markSeen('wa', msg.id, sessionId);
      await relayMessage(deps, sessionId, conversationId, msg, 'outgoing');
    } catch (err) {
      deps.log('own-send relay failed', err);
    }
  });
}

// Find the Chatwoot conversation this chat is already mapped to, or null. Dual lookup: the raw chatId
// finds a mapping keyed by @lid (created post-migration), the canonical chatId finds one keyed by @c.us
// (a contact that has since migrated to @lid, when the lid resolves) — so a migrated contact's own send
// lands in its EXISTING conversation instead of a duplicate. Never creates.
async function findMappedConversation(
  deps: InboundDeps,
  sessionId: string,
  msg: IncomingMessage,
  canonicalChatId: string,
): Promise<number | null> {
  const existing =
    (await deps.store.getByChat(sessionId, msg.chatId)) ??
    (canonicalChatId !== msg.chatId ? await deps.store.getByChat(sessionId, canonicalChatId) : null);
  return existing ? existing.conversationId : null;
}
