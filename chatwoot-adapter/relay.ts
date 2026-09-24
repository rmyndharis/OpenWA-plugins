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
  // Called when an inbound message could not be relayed AND could not be queued for retry — i.e. it is
  // lost. The only way this failure reaches an operator: the retry queue can't count an entry it never
  // managed to store, so healthCheck would otherwise report green while dropping messages.
  onInboundLost: (msgId: string, err: unknown) => void;
  // Called on every failed relay, before the message is queued for retry. The error text is the single
  // most useful thing an operator can be told (it carries the Chatwoot status and response body), and
  // `log` only reaches the host's stdout — healthCheck is the one channel the dashboard renders.
  onRelayError: (err: unknown) => void;
  // Called once when a chat's history import has burned MAX_BACKFILL_ATTEMPTS. Mirrors onInboundLost:
  // the durable per-chat counter stops the retries, this makes the give-up visible on healthCheck.
  onBackfillExhausted: (chatId: string) => void;
}

function senderLabel(msg: IncomingMessage): string {
  return msg.contact?.pushName || msg.senderPhone || msg.author || 'unknown';
}

// On whatsapp-web.js the body of an order or product can be its base64 JPEG thumbnail rather than text, the
// way a location's body is its map thumbnail: one unbroken run of base64, never something a person typed.
const IMAGE_DATA = /^(?:\/9j\/|iVBORw0KGgo)\S*$|^[A-Za-z0-9+/]{200,}={0,2}$/;

// A catalog order or a shared product card: a marker line an agent can tell apart from typed text, then the
// text the message carried. Never the order token, a single-order credential. Undefined for every other
// message, and on hosts below 0.23.5, which set neither block. Without its block (no id) the text relays
// as before, but a body that is only image data becomes the type marker.
function commerceText(msg: IncomingMessage): string | undefined {
  if (msg.type !== 'order' && msg.type !== 'product') return undefined;
  const text = msg.body?.trim();
  const body = text && !IMAGE_DATA.test(text) ? text : undefined;
  if (msg.type === 'order' && msg.order) {
    return [`🛒 Order ${msg.order.orderId}`, body].filter(Boolean).join('\n');
  }
  if (msg.type === 'product' && msg.product) {
    const { productId, title } = msg.product;
    const line = title ? `🛍️ ${title} (product ${productId})` : `🛍️ Product ${productId}`;
    return [line, body !== title ? body : undefined].filter(Boolean).join('\n');
  }
  return text && !body ? `💬 ${msg.type}` : undefined;
}

// What a message relays as, before the group sender prefix.
function textOf(msg: IncomingMessage): string {
  return commerceText(msg) ?? msg.body;
}

function prefixSender(msg: IncomingMessage): string {
  if (!msg.isGroup) return textOf(msg);
  return `*${senderLabel(msg)}:* ${textOf(msg)}`;
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
export function placeholderFor(msg: IncomingMessage): string {
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
  if (msg.type === 'poll') return '📊 Poll';
  if (msg.type === 'document') return `📎 ${msg.media?.filename ?? 'Document'}`;
  if (msg.media) return `📎 ${msg.media.filename ?? 'Attachment'}`;
  // Never return an empty string: this is only reached for a message with no relayable body, and Chatwoot
  // rejects empty content with a 422 — which, since the message is already marked seen, dropped it for good.
  // `call`, `revoked`, `masked` and `unknown` all arrive bodyless, and so does any future host type.
  return msg.body?.trim() || `💬 ${msg.type || 'Message'}`;
}

// Render one WhatsApp message into Chatwoot (text / media / location / sticker / voice / order / product,
// with quote threading). Live inbound always passes 'incoming'; backfill derives the direction per message.
// An 'outgoing' post is echo-guarded before returning (see below) — the caller need not.
export async function relayMessage(
  deps: InboundDeps,
  sessionId: string,
  conversationId: number,
  msg: IncomingMessage,
  messageType: 'incoming' | 'outgoing',
): Promise<void> {
  // Conversation-scoped lock spanning the POST + echo-marker write. outbound.relay dedups the webhook
  // echo under the SAME key, so an echo processed while this POST is still in flight waits for the
  // marker instead of racing it (the surrounding per-chat locks don't help: inbound/backfill lock the
  // raw chatId, outbound the canonical one). Innermost on every path, so no lock-order cycle.
  await deps.lock.run(`${sessionId}:conv:${conversationId}`, async () => {
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
    created = await deps.client.postText(conversationId, textOf(msg)?.trim() ? content : placeholderFor(msg), post);
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
  });
}

// Best phone for a brand-new Chatwoot contact, or `undefined` when no source knows it. Priority:
//   1. `msg.senderPhone` — populated by the host ONLY for `@lid` senders under `RESOLVE_LID_TO_PHONE=true`;
//      MSISDN digits, no `+` guaranteed, so we normalize.
//   2. User-part of `canonicalChatId` when it ends `@c.us` — covers a warmed lid→pn mapping (the id is
//      @lid-aware, resolved via the engine's in-memory map — no network) AND every plain `@c.us` chat,
//      whose JID user-part is by definition the MSISDN (previously created with no phone at all).
//
// Deliberately NOT consulted: `msg.contact?.number`. For an `@lid` sender it carries the LID digits, not
// the real phone — matching on it would corrupt Chatwoot's contact search and future merges.
//
// Groups and an unresolved `@lid` (canonical stays `@lid`) yield `undefined` — pre-fix behavior preserved.
// Pure & synchronous, so the bulk sweep (ChatSummary, id already neutral) and retry drain reuse it freely.
export function resolvePhone(
  msg: { isGroup: boolean; senderPhone?: string | null },
  canonicalChatId: string,
): string | undefined {
  if (msg.isGroup) return undefined;
  // Digits only, prefixed `+`, and only when the result is really E.164. Chatwoot validates the field
  // ("Phone number should be in e164 format", 422) and refuses the WHOLE contact write on a miss, which
  // the CREATE path cannot absorb: createContact's 422 handler only recovers from a uniqueness clash, so
  // a malformed value rethrows and burns the message's retry budget into the dead-letter queue. Emitting
  // nothing is strictly better than emitting a value the API rejects. Subsumes the old bare-'+' guard.
  const e164 = (raw: string): string | undefined => {
    const phone = `+${raw.replace(/\D/g, '')}`;
    return /^\+[1-9]\d{1,14}$/.test(phone) ? phone : undefined;
  };
  if (msg.senderPhone) {
    const phone = e164(msg.senderPhone);
    if (phone) return phone;
  }
  if (canonicalChatId.endsWith('@c.us')) return e164(canonicalChatId.slice(0, -'@c.us'.length));
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
    // Deliberately records NEITHER name nor phone, even when createContact just sent them. This function
    // cannot know what Chatwoot ended up holding: the search may have hit an existing contact, or
    // createContact may have 422'd on the identifier OR on the phone and adopted a row it never wrote
    // either field to. Recording our own guess would make refreshContact believe both sides are in sync
    // and suppress the sync forever. Absent is the documented "never synced" state, so the next inbound
    // message sends both once, idempotently, and records what actually landed.
    // "Not yet imported" is written down, never inferred from a missing field. Every mapping an earlier
    // release wrote carries no backfill fields at all, so a trigger of `!backfillDone` would read them
    // as unimported and replay each chat's whole window into a conversation that was already imported —
    // duplicates ahead of the live message, in every open chat, on the first message after an upgrade.
    backfillDone: false,
  });
  return conversationId;
}

// A 1:1 chat first seen from an @lid sender is seeded with the bare JID as its Chatwoot name (no pushName
// yet). Once a real pushName arrives, update the contact so agents see a human name instead of an id
// (#609 P1). Best-effort and only when the name actually changed — never blocks the relay, never overwrites
// a real name with a fallback (only pushName/name qualify, not senderPhone/JID).
//
// The phone rides the same PUT. Nothing else ever wrote it after creation, so a contact created before
// the number was derivable, and every contact created by a release older than 0.5.7, stayed blank
// forever. Sent once per contact: the stored value is what suppresses a repeat.
export async function refreshContact(
  deps: InboundDeps,
  sessionId: string,
  msg: IncomingMessage,
  link: ChatLink,
  chatKey: string,
  canonicalChatId: string,
): Promise<void> {
  if (msg.isGroup) return; // a group contact is named for the group, not whoever sent this message
  const desiredName = msg.contact?.pushName || msg.contact?.name;
  const desiredPhone = resolvePhone(msg, canonicalChatId);
  const name = desiredName && desiredName !== link.name ? desiredName : undefined;
  const phone = desiredPhone && desiredPhone !== link.phone ? desiredPhone : undefined;
  if (!name && !phone) return;
  try {
    await deps.client.updateContact(link.contactId, name, phone);
    // Patch under the key the mapping ACTUALLY lives under (`chatKey`), not msg.chatId: on the @lid dual-
    // lookup path the mapping is keyed @c.us while msg.chatId is @lid, so patching msg.chatId would be a
    // no-op and the name would never be recorded — re-issuing updateContact on every later inbound.
    await deps.store.patch(sessionId, chatKey, { ...(name ? { name } : {}), ...(phone ? { phone } : {}) });
  } catch (err) {
    // A 422 is Chatwoot refusing the VALUE: "Phone number has already been taken", i.e. the number
    // belongs to another contact in the account. Record it anyway, or the `phone !== link.phone` guard
    // re-issues the same doomed PUT on every later message of this chat, forever. Any other status stays
    // unrecorded and therefore retryable, so a 503 does not lose the phone. A name that rode along is
    // lost with the 422; the next message re-sends it alone and succeeds, the phone now being recorded.
    if (phone && (err as { status?: number } | null)?.status === 422) {
      await deps.store.patch(sessionId, chatKey, { phone }).catch(() => undefined);
    }
    deps.log('contact refresh failed', err);
  }
}
