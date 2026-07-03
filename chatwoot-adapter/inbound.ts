import type { IncomingMessage } from '../types/openwa';
import type { ChatwootClient } from './chatwoot-client.ts';
import type { MappingStore, ChatLink } from './mapping-store.ts';
import type { KeyedAsyncLock } from './chat-lock.ts';
import { shouldRelayInbound } from './filters.ts';

export interface InboundDeps {
  lock: KeyedAsyncLock;
  client: ChatwootClient;
  store: MappingStore;
  instanceId: string;
  relayGroups: boolean;
  relayMedia: boolean;
  log: (m: string, e?: unknown) => void;
}

// WhatsApp → Chatwoot. Filter, then run the whole resolve+post+persist under the per-chat lock so two
// near-simultaneous first messages can't create duplicate Chatwoot contacts/conversations. Dedup is a
// mark-before-act check-and-set inside the lock (at-most-once; a failed post won't re-relay).
export async function handleInbound(deps: InboundDeps, sessionId: string, source: string, msg: IncomingMessage): Promise<void> {
  if (!shouldRelayInbound(msg, source, deps.relayGroups)) return;
  await deps.lock.run(`${sessionId}:${msg.chatId}`, async () => {
    try {
      // Mark-before-act: inbound is deliberately at-most-once (a failed post won't re-relay). Scoped by
      // session so two tenants' WA message ids can't collide in the shared plugin store.
      if (await deps.store.hasSeen('wa', msg.id, sessionId)) return;
      await deps.store.markSeen('wa', msg.id, sessionId);
      const conversationId = await resolveConversation(deps, sessionId, msg);
      const content = prefixSender(msg);
      // source_id lets a later reply thread against this message; in_reply_to_external_id forwards the
      // quote context (#606) so a short reply like ".." keeps the bubble it answered.
      const post = { sourceId: msg.id, inReplyToExternalId: msg.quotedMessage?.id };
      const isVoice = msg.type === 'voice';
      if (deps.relayMedia && msg.media?.data && !msg.media.omitted) {
        await deps.client.postMedia(
          conversationId,
          content,
          {
            filename: isVoice ? 'voice.ogg' : msg.media.filename ?? 'file',
            contentType: msg.media.mimetype || (isVoice ? 'audio/ogg' : 'application/octet-stream'),
            data: Buffer.from(msg.media.data, 'base64'),
          },
          { ...post, isVoiceMessage: isVoice },
        );
      } else {
        // No relayable blob (plain text, or media dropped/omitted). Never post an empty bubble for a
        // media message — surface a short placeholder so the agent knows something arrived (#607).
        await deps.client.postText(conversationId, msg.body?.trim() ? content : placeholderFor(msg), post);
      }
    } catch (err) {
      deps.log('inbound relay failed', err);
    }
  });
}

function prefixSender(msg: IncomingMessage): string {
  if (!msg.isGroup) return msg.body;
  const who = msg.contact?.pushName || msg.senderPhone || msg.author || 'unknown';
  return `*${who}:* ${msg.body}`;
}

// A short stand-in for a bodyless message we couldn't relay as media (e.g. a voice note whose blob was
// omitted for size), so Chatwoot shows a meaningful line instead of an empty bubble.
function placeholderFor(msg: IncomingMessage): string {
  if (msg.type === 'voice') return '🎤 Voice message';
  if (msg.media) return `📎 ${msg.media.filename ?? 'Attachment'}`;
  return msg.body;
}

async function resolveConversation(deps: InboundDeps, sessionId: string, msg: IncomingMessage): Promise<number> {
  const existing = await deps.store.getByChat(sessionId, msg.chatId); // re-read inside the lock
  if (existing) {
    await refreshContactName(deps, sessionId, msg, existing);
    return existing.conversationId;
  }
  const identifier = msg.chatId; // WA JID — individual @c.us/@lid or group JID (stable across @lid migration)
  const name = msg.isGroup ? `Group ${msg.chatId}` : msg.contact?.pushName || msg.contact?.name || msg.senderPhone || identifier;
  const phone = msg.isGroup ? undefined : msg.senderPhone ?? undefined;
  const found = await deps.client.searchContact(identifier);
  const contact = found?.sourceId
    ? { id: found.id, sourceId: found.sourceId }
    : await deps.client.createContact(identifier, name, phone);
  const conversationId =
    (await deps.client.findOpenConversation(contact.id)) ?? (await deps.client.createConversation(contact.id, contact.sourceId));
  await deps.store.link(sessionId, msg.chatId, deps.instanceId, { conversationId, contactId: contact.id, sourceId: contact.sourceId, name });
  return conversationId;
}

// A 1:1 chat first seen from an @lid sender is seeded with the bare JID as its Chatwoot name (no pushName
// yet). Once a real pushName arrives, update the contact so agents see a human name instead of an id
// (#609 P1). Best-effort and only when the name actually changed — never blocks the relay, never overwrites
// a real name with a fallback (only pushName/name qualify, not senderPhone/JID).
async function refreshContactName(deps: InboundDeps, sessionId: string, msg: IncomingMessage, link: ChatLink): Promise<void> {
  if (msg.isGroup) return; // a group contact is named for the group, not whoever sent this message
  const desired = msg.contact?.pushName || msg.contact?.name;
  if (!desired || desired === link.name) return;
  try {
    await deps.client.updateContact(link.contactId, desired);
    await deps.store.patch(sessionId, msg.chatId, { name: desired });
  } catch (err) {
    deps.log('contact name refresh failed', err);
  }
}
