import type { IncomingMessage } from '../types/openwa';

// Chat ids that are not a conversation with a person or a group: `@newsletter` is a WhatsApp Channel
// this account merely FOLLOWS, and `@broadcast` covers broadcast lists and `status@broadcast`.
//
// `isGroup` is a boolean over a five-way discriminator, so it cannot see these: a channel post arrives
// with isGroup false and was relayed as if a customer had written in, creating a Chatwoot contact and
// an open conversation per followed channel that an agent then has to triage and close by hand, and
// any reply is addressed to a chat this account cannot post to. Nothing filters them upstream: the
// host diverts only status broadcasts (message-projector, handleInboundMessage), and only when the
// adapter set isStatusBroadcast.
//
// Matched on the JID rather than `msg.kind`, which the host only stamps from 0.10.8 while this plugin
// declares 0.8.7. A denylist, so an id shape WhatsApp adds later keeps relaying rather than silently
// disappearing from the inbox.
const BROADCAST_JID_DOMAINS = new Set(['newsletter', 'broadcast']);

export function isBroadcastChat(chatId: string): boolean {
  const at = chatId.lastIndexOf('@');
  return at !== -1 && BROADCAST_JID_DOMAINS.has(chatId.slice(at + 1).toLowerCase());
}

// Relay only genuine engine-delivered inbound messages we didn't send ourselves. Groups are gated by
// relayGroups. Pure — no ctx.
export function shouldRelayInbound(msg: IncomingMessage, source: string, relayGroups: boolean): boolean {
  return (
    source === 'Engine' &&
    !msg.fromMe &&
    !!msg.chatId &&
    !isBroadcastChat(msg.chatId) &&
    (!msg.isGroup || relayGroups)
  );
}

// Relay the account's OWN outbound sends (composed on a linked phone or via the OpenWA API) so the
// Chatwoot thread mirrors WhatsApp (#615). The mirror of shouldRelayInbound with fromMe===true. The
// adapter's own Chatwoot-agent replies are ALSO fromMe and reach message:sent, but they're excluded
// out-of-band by the 'wa' send-id echo marker, not here. Pure — no ctx.
export function shouldRelayOwn(msg: IncomingMessage, source: string, relayGroups: boolean): boolean {
  return (
    source === 'Engine' &&
    msg.fromMe &&
    !!msg.chatId &&
    // Same exclusion as the inbound mirror: posting to a channel this account OWNS would otherwise
    // open a Chatwoot conversation for it, and an agent reply there goes nowhere useful.
    !isBroadcastChat(msg.chatId) &&
    (!msg.isGroup || relayGroups)
  );
}

// The subset of a Chatwoot account-level webhook payload the adapter reads (message_created +
// conversation_updated). Everything is optional — Chatwoot omits fields per event/version.
export interface ChatwootWebhookMessage {
  event?: string;
  message_type?: string;
  private?: boolean;
  content?: string;
  id?: number;
  conversation?: { id?: number; status?: string; meta?: { assignee?: { id?: number } | null } };
  inbox?: { id?: number };
  sender?: { type?: string };
  attachments?: Array<{ id?: number; file_type?: string; data_url?: string }>;
  // Set when the agent used "Reply to": `in_reply_to_external_id` is the quoted message's source_id,
  // which is the WhatsApp message id for everything this adapter posts — so it can ride out as a quote.
  content_attributes?: { in_reply_to?: number; in_reply_to_external_id?: string };
  changed_attributes?: Array<Record<string, { current_value?: unknown; previous_value?: unknown }>>;
}

// Relay only agent-visible outgoing replies in OUR inbox. Strict `private === false` (fail closed: an
// absent/non-false value is a private note or unknown shape and must never reach WhatsApp). This also
// drops the adapter's own `incoming` posts, so there is no echo loop.
export function shouldRelayOutbound(evt: ChatwootWebhookMessage, inboxId: number): boolean {
  return evt.inbox?.id === inboxId && evt.message_type === 'outgoing' && evt.private === false;
}
