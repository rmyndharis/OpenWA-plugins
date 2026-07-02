import type { IncomingMessage } from '../types/openwa';
import type { ChatwootClient } from './chatwoot-client.ts';
import type { MappingStore } from './mapping-store.ts';
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
      if (deps.relayMedia && msg.media?.data && !msg.media.omitted) {
        await deps.client.postMedia(conversationId, content, {
          filename: msg.media.filename ?? 'file',
          contentType: msg.media.mimetype,
          data: Buffer.from(msg.media.data, 'base64'),
        });
      } else {
        await deps.client.postText(conversationId, content);
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

async function resolveConversation(deps: InboundDeps, sessionId: string, msg: IncomingMessage): Promise<number> {
  const existing = await deps.store.getByChat(sessionId, msg.chatId); // re-read inside the lock
  if (existing) return existing.conversationId;
  const identifier = msg.chatId; // WA JID — individual @c.us/@lid or group JID (stable across @lid migration)
  const name = msg.isGroup ? `Group ${msg.chatId}` : msg.contact?.pushName || msg.contact?.name || msg.senderPhone || identifier;
  const phone = msg.isGroup ? undefined : msg.senderPhone ?? undefined;
  const found = await deps.client.searchContact(identifier);
  const contact = found?.sourceId
    ? { id: found.id, sourceId: found.sourceId }
    : await deps.client.createContact(identifier, name, phone);
  const conversationId =
    (await deps.client.findOpenConversation(contact.id)) ?? (await deps.client.createConversation(contact.id, contact.sourceId));
  await deps.store.link(sessionId, msg.chatId, deps.instanceId, { conversationId, contactId: contact.id, sourceId: contact.sourceId });
  return conversationId;
}
