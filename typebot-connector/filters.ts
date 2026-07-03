import type { IncomingMessage } from '../types/openwa';

// True when this inbound message should drive a Typebot turn: only real engine messages (not webhook
// replays/echoes), never our own outbound, must have a chat, and groups only when enabled.
export function inScope(msg: IncomingMessage, source: string, respondInGroups: boolean): boolean {
  if (source !== 'Engine') return false;
  if (msg.fromMe) return false;
  if (!msg.chatId) return false;
  if (msg.isGroup && !respondInGroups) return false;
  return true;
}

// Per-conversation session key, scoped by WA session (plugin storage is shared across sessions). In a group
// each sender gets their own flow, so participants don't interleave into one Typebot session.
export function sessionKey(sessionId: string, msg: IncomingMessage): string {
  if (!msg.isGroup) return `${sessionId}:${msg.chatId}`;
  const who = msg.author ?? msg.senderPhone ?? 'unknown';
  return `${sessionId}:${msg.chatId}:${who}`;
}
