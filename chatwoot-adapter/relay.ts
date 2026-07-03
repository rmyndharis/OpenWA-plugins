import type { IncomingMessage, PluginEngineReadCapability } from '../types/openwa';
import type { ChatwootClient } from './chatwoot-client.ts';
import type { MappingStore, ChatLink } from './mapping-store.ts';
import type { KeyedAsyncLock } from './chat-lock.ts';

// Shared dependency bag for the inbound relay and the history backfill. Both render messages into
// Chatwoot and resolve conversations the same way; keeping the primitives here (a leaf module) lets
// `inbound.ts` and `backfill.ts` share them without an import cycle.
export interface InboundDeps {
  lock: KeyedAsyncLock;
  client: ChatwootClient;
  store: MappingStore;
  engine: PluginEngineReadCapability;
  instanceId: string;
  relayGroups: boolean;
  relayMedia: boolean;
  backfillLimit: number;
  backfillAllOnce: boolean;
  log: (m: string, e?: unknown) => void;
}

function senderLabel(msg: IncomingMessage): string {
  return msg.contact?.pushName || msg.senderPhone || msg.author || 'unknown';
}

function prefixSender(msg: IncomingMessage): string {
  if (!msg.isGroup) return msg.body;
  return `*${senderLabel(msg)}:* ${msg.body}`;
}

// A shared location rendered for Chatwoot: a pin line (description/address when present) plus a link the
// agent can open (the message's own url, else a maps query). Group messages keep the sender prefix.
function locationText(msg: IncomingMessage): string {
  const loc = msg.location!;
  const link = loc.url || `https://maps.google.com/?q=${loc.latitude},${loc.longitude}`;
  const label = [loc.description, loc.address].filter(Boolean).join(' — ');
  const body = label ? `📍 ${label}\n${link}` : `📍 ${link}`;
  return msg.isGroup ? `*${senderLabel(msg)}:* ${body}` : body;
}

// A short stand-in for a bodyless message we couldn't relay as media (e.g. a voice note or sticker whose
// blob was omitted for size), so Chatwoot shows a meaningful line instead of an empty bubble.
function placeholderFor(msg: IncomingMessage): string {
  if (msg.type === 'voice') return '🎤 Voice message';
  if (msg.type === 'sticker') return '🎨 Sticker';
  if (msg.media) return `📎 ${msg.media.filename ?? 'Attachment'}`;
  return msg.body;
}

// Render one WhatsApp message into Chatwoot (text / media / location / sticker / voice, with quote
// threading). Live inbound always passes 'incoming'; history backfill derives the direction per message.
export async function relayMessage(
  deps: InboundDeps,
  conversationId: number,
  msg: IncomingMessage,
  messageType: 'incoming' | 'outgoing',
): Promise<void> {
  const content = prefixSender(msg);
  const post = { sourceId: msg.id, inReplyToExternalId: msg.quotedMessage?.id, messageType };
  const isVoice = msg.type === 'voice';
  const isSticker = msg.type === 'sticker';
  if (msg.type === 'location' && msg.location) {
    await deps.client.postText(conversationId, locationText(msg), post);
  } else if (deps.relayMedia && msg.media?.data && !msg.media.omitted) {
    await deps.client.postMedia(
      conversationId,
      content,
      {
        filename: isVoice ? 'voice.ogg' : isSticker ? 'sticker.webp' : msg.media.filename ?? 'file',
        contentType:
          msg.media.mimetype || (isVoice ? 'audio/ogg' : isSticker ? 'image/webp' : 'application/octet-stream'),
        data: Buffer.from(msg.media.data, 'base64'),
      },
      { ...post, isVoiceMessage: isVoice },
    );
  } else {
    await deps.client.postText(conversationId, msg.body?.trim() ? content : placeholderFor(msg), post);
  }
}

// Get-or-create the Chatwoot contact + conversation for a chat and mirror the mapping. Self-contained so
// the bulk backfill can call it from a chat summary (no triggering message), and idempotent so a chat
// already mapped by the live path is a no-op.
export async function ensureConversation(
  deps: InboundDeps,
  sessionId: string,
  chatId: string,
  meta: { name: string; phone?: string },
): Promise<number> {
  const existing = await deps.store.getByChat(sessionId, chatId);
  if (existing) return existing.conversationId;
  const found = await deps.client.searchContact(chatId);
  const contact = found?.sourceId
    ? { id: found.id, sourceId: found.sourceId }
    : await deps.client.createContact(chatId, meta.name, meta.phone);
  const conversationId =
    (await deps.client.findOpenConversation(contact.id)) ??
    (await deps.client.createConversation(contact.id, contact.sourceId));
  await deps.store.link(sessionId, chatId, deps.instanceId, {
    conversationId,
    contactId: contact.id,
    sourceId: contact.sourceId,
    name: meta.name,
  });
  return conversationId;
}

// A 1:1 chat first seen from an @lid sender is seeded with the bare JID as its Chatwoot name (no pushName
// yet). Once a real pushName arrives, update the contact so agents see a human name instead of an id
// (#609 P1). Best-effort and only when the name actually changed — never blocks the relay, never overwrites
// a real name with a fallback (only pushName/name qualify, not senderPhone/JID).
export async function refreshContactName(
  deps: InboundDeps,
  sessionId: string,
  msg: IncomingMessage,
  link: ChatLink,
): Promise<void> {
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
