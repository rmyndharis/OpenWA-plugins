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
  // Type-based markers first: a media message relayed via `message:sent` (own outbound send) carries NO
  // media object at all — wwjs' message_create path is not enriched — so `msg.media` is absent and only
  // `msg.type` distinguishes it. Without a per-type marker a caption-less photo/video/etc would post an
  // empty Chatwoot bubble (or 422 → drop, since it's already markSeen). Location coords are likewise
  // absent on that path.
  if (msg.type === 'voice') return '🎤 Voice message';
  if (msg.type === 'sticker') return '🎨 Sticker';
  if (msg.type === 'location') return '📍 Location';
  if (msg.type === 'image') return '📷 Photo';
  if (msg.type === 'video') return '🎥 Video';
  if (msg.type === 'audio') return '🎵 Audio';
  if (msg.type === 'contact') return '👤 Contact';
  if (msg.type === 'document') return `📎 ${msg.media?.filename ?? 'Document'}`;
  if (msg.media) return `📎 ${msg.media.filename ?? 'Attachment'}`;
  return msg.body;
}

// Render one WhatsApp message into Chatwoot (text / media / location / sticker / voice, with quote
// threading). Live inbound always passes 'incoming'; history backfill derives the direction per message.
// An 'outgoing' post is echo-guarded before returning (see below) — the caller need not.
export async function relayMessage(
  deps: InboundDeps,
  sessionId: string,
  conversationId: number,
  msg: IncomingMessage,
  messageType: 'incoming' | 'outgoing',
): Promise<void> {
  const content = prefixSender(msg);
  const post = { sourceId: msg.id, inReplyToExternalId: msg.quotedMessage?.id, messageType };
  const isVoice = msg.type === 'voice';
  const isSticker = msg.type === 'sticker';
  let created: { id: number };
  if (msg.type === 'location' && msg.location) {
    created = await deps.client.postText(conversationId, locationText(msg), post);
  } else if (deps.relayMedia && msg.media?.data && !msg.media.omitted) {
    created = await deps.client.postMedia(
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
    created = await deps.client.postText(conversationId, msg.body?.trim() ? content : placeholderFor(msg), post);
  }
  // Echo guard for the own-send mirror (#615), the mirror image of the 'wa' marker outbound.relay writes.
  // A message posted as 'outgoing' comes straight back as a Chatwoot `message_created` that
  // shouldRelayOutbound accepts (it only drops 'incoming'), so without this marker outbound.relay would
  // send it to WhatsApp a SECOND time — the recipient really receives two messages.
  //
  // Scoped by the WA session that owns the conversation. outbound.relay resolves the SAME value from the
  // conversation mapping (target.sessionId) before it checks, so both sides always agree on a scope that
  // is always defined — never the ingress delivery's `instance.sessionScope ?? undefined`, which is
  // undefined for an unscoped instance and would key a different marker.
  if (messageType === 'outgoing') await deps.store.markSeen('cw', String(created.id), sessionId);
}

// Best phone to put on a brand-new Chatwoot contact, or `undefined` when no source knows it. Two sources,
// chosen in priority order:
//
//   1. `msg.senderPhone`. The OpenWA host populates this ONLY for `@lid` senders and ONLY when the env
//      flag `RESOLVE_LID_TO_PHONE=true` is set; the value is MSISDN digits with no `+` guaranteed, so we
//      normalize. The cheapest signal when it exists, since the host has already done the work.
//   2. The user-part of `canonicalChatId` when it ends with `@c.us`. `canonicalChatId` is also @lid-aware
//      (resolved via the engine's in-memory lid→pn map — no network call), so this covers a contact whose
//      lid mapping was warmed by any earlier reply to them, and — bonus — every plain `@c.us` chat, where
//      the JID user-part is by definition the MSISDN. (Today those contacts are created without a phone,
//      since `senderPhone` is lid-only on the host.)
//
// Deliberately not consulted: `msg.contact?.number`. It is only present when the host runs
// `WEBHOOK_CONTACT_DETAILS=true` (off by default), and for a `@lid` sender it carries the LID digits, not
// the real phone — the host's own MessageContact doc warns "For @lid senders the authoritative number is
// IncomingMessage.senderPhone". Falsely matching on a lid-derived number would corrupt Chatwoot's contact
// search and produce future merge surprises, so the helper stops one source short of it.
//
// Groups short-circuit to `undefined`: a group has no MSISDN, and the synthetic group contact never gets a
// phone. An unresolved `@lid` (the third manifest state) also yields `undefined` — pre-fix behavior is
// preserved when the lid→pn mapping is genuinely unknown, and resolved contacts now carry their real
// phone as soon as the host has any of the two sources above.
//
// Pure and synchronous, so the bulk sweep can call it on a ChatSummary (with `chat.id` already in the
// neutral dialect — no engine call needed on that path) and the retry drain can replay through it without
// adding a failure mode.
export function resolvePhone(
  msg: { isGroup: boolean; senderPhone?: string | null },
  canonicalChatId: string,
): string | undefined {
  if (msg.isGroup) return undefined;
  const sender = msg.senderPhone;
  if (sender) {
    const digits = sender.replace(/\D/g, '');
    if (digits) return `+${digits}`;
  }
  if (canonicalChatId.endsWith('@c.us')) {
    const digits = canonicalChatId.slice(0, -('@c.us'.length)).replace(/\D/g, '');
    if (digits) return `+${digits}`;
  }
  return undefined;
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
  chatKey: string,
): Promise<void> {
  if (msg.isGroup) return; // a group contact is named for the group, not whoever sent this message
  const desired = msg.contact?.pushName || msg.contact?.name;
  if (!desired || desired === link.name) return;
  try {
    await deps.client.updateContact(link.contactId, desired);
    // Patch under the key the mapping ACTUALLY lives under (`chatKey`), not msg.chatId: on the @lid dual-
    // lookup path the mapping is keyed @c.us while msg.chatId is @lid, so patching msg.chatId would be a
    // no-op and the name would never be recorded — re-issuing updateContact on every later inbound.
    await deps.store.patch(sessionId, chatKey, { name: desired });
  } catch (err) {
    deps.log('contact name refresh failed', err);
  }
}
