import type { IncomingMessage } from '../types/openwa';

export const MAX_TEXT = 4096;
export const MAX_WEBHOOK_MESSAGES = 20;

export function inboundText(message: IncomingMessage): boolean {
  return Boolean(
    message &&
    message.fromMe === false &&
    !message.isGroup &&
    !message.isStatusBroadcast &&
    /^\d+(?::\d+)?@(c\.us|s\.whatsapp\.net|lid)$/.test(message.chatId ?? '') &&
    message.type === 'text' &&
    typeof message.id === 'string' &&
    message.id.length > 0 &&
    message.id.length <= 300 &&
    typeof message.body === 'string' &&
    message.body.trim() &&
    message.body.length <= MAX_TEXT,
  );
}

export interface AgentMessage {
  id: string;
  text: string;
}
export interface AgentEvent {
  roomId: string;
  visitorToken: string;
  messages: AgentMessage[];
}

export function parseAgentEvent(body: string): AgentEvent | null {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error('Invalid Rocket.Chat webhook JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Rocket.Chat webhook');
  // Never relay transcripts, close notifications or a webhook test as a new agent message.
  if (value.type !== 'Message') return null;
  if (typeof value._id !== 'string' || !value._id || value._id.length > 200)
    throw new Error('Missing Rocket.Chat room id');
  const visitor = value.visitor as { token?: unknown } | undefined;
  if (!visitor || typeof visitor.token !== 'string' || !visitor.token)
    throw new Error('Missing Rocket.Chat visitor token');
  if (!Array.isArray(value.messages) || value.messages.length > MAX_WEBHOOK_MESSAGES)
    throw new Error('Invalid Rocket.Chat message list');
  const messages: AgentMessage[] = [];
  for (const raw of value.messages) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const message = raw as Record<string, unknown>;
    // Visitor echoes have no agentId. Internal notes, system events, attachments and edited messages
    // are intentionally not part of this first text-only bridge.
    if (
      typeof message.agentId !== 'string' ||
      !message.agentId ||
      message.t ||
      message.private === true ||
      message.internal === true ||
      message.editedAt ||
      message.file ||
      (Array.isArray(message.files) ? message.files.length > 0 : Boolean(message.files)) ||
      (Array.isArray(message.attachments) ? message.attachments.length > 0 : Boolean(message.attachments))
    )
      continue;
    if (
      typeof message._id !== 'string' ||
      !message._id ||
      message._id.length > 300 ||
      typeof message.msg !== 'string' ||
      !message.msg.trim() ||
      message.msg.length > MAX_TEXT
    )
      continue;
    messages.push({ id: message._id, text: message.msg });
  }
  return { roomId: value._id, visitorToken: visitor.token, messages };
}
