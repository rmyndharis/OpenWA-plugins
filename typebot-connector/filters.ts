import type { IncomingMessage } from '../types/openwa';

// True when this inbound message should drive a Typebot turn: only real engine messages (not webhook
// replays/echoes), never our own outbound, must have a chat, and groups only when enabled.
export function inScope(msg: IncomingMessage, source: string, respondInGroups: boolean): boolean {
  if (source !== 'Engine') return false;
  if (msg.fromMe) return false;
  if (!msg.chatId) return false;
  if (msg.isGroup && !respondInGroups) return false;
  // A group message with no author cannot be attributed to a participant, and the per-sender promise
  // below is the whole reason group support is safe: without it every authorless participant would share
  // ONE flow row, so one contact's answer would be fed to another contact's Typebot session. Skipping is
  // the only safe option — the alternative is silently merging strangers' conversations.
  if (msg.isGroup && !msg.author) return false;
  return true;
}

// Per-conversation session key, scoped by WA session (plugin storage is shared across sessions). In a group
// each sender gets their own flow, so participants don't interleave into one Typebot session.
export function sessionKey(sessionId: string, msg: IncomingMessage): string {
  if (!msg.isGroup) return `${sessionId}:${msg.chatId}`;
  // `author` is guaranteed present here: inScope rejects an authorless group message. senderPhone is NOT
  // a fallback — the host assigns it after the hook chain, so at this point it is always undefined.
  return `${sessionId}:${msg.chatId}:${msg.author}`;
}
