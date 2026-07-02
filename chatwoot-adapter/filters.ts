import type { IncomingMessage } from '../types/openwa';

// Relay only genuine engine-delivered inbound messages we didn't send ourselves. Groups are gated by
// relayGroups. Pure — no ctx.
export function shouldRelayInbound(msg: IncomingMessage, source: string, relayGroups: boolean): boolean {
  return source === 'Engine' && !msg.fromMe && !!msg.chatId && (!msg.isGroup || relayGroups);
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
  changed_attributes?: Array<Record<string, { current_value?: unknown; previous_value?: unknown }>>;
}

// Relay only agent-visible outgoing replies in OUR inbox. Strict `private === false` (fail closed: an
// absent/non-false value is a private note or unknown shape and must never reach WhatsApp). This also
// drops the adapter's own `incoming` posts, so there is no echo loop.
export function shouldRelayOutbound(evt: ChatwootWebhookMessage, inboxId: number): boolean {
  return evt.inbox?.id === inboxId && evt.message_type === 'outgoing' && evt.private === false;
}
