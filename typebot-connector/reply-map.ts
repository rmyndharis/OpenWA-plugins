import type { IncomingMessage } from '../types/openwa';
import type { Awaiting, ReplyIntent } from './typebot-types.ts';

// Map a WhatsApp reply to the argument for continueChat, given what the bot is waiting for.
export function mapReply(awaiting: Awaiting, msg: IncomingMessage): ReplyIntent {
  const text = (msg.body ?? '').trim();

  // File input, or a text input that accepts attachments: prefer the media.
  if (awaiting.kind === 'file' || (awaiting.kind === 'text' && awaiting.attachmentsEnabled)) {
    if (msg.media?.data && !msg.media.omitted) {
      return { kind: 'file', mime: msg.media.mimetype, filename: msg.media.filename ?? 'file', data: msg.media.data };
    }
    if (msg.media?.omitted) {
      return { kind: 'fallback', text: 'That file is too large to accept here. Please send a smaller file or type to continue.' };
    }
    if (awaiting.kind === 'text') return { kind: 'text', message: text }; // attachment optional → plain text ok
    return { kind: 'fallback', text: 'Please send a file or photo to continue.' };
  }

  if (awaiting.kind === 'choice') {
    if (awaiting.multiple) {
      const picks = text
        .split(/[,\s]+/)
        .map(t => Number.parseInt(t, 10))
        .filter(n => Number.isInteger(n) && n >= 1 && n <= awaiting.items.length);
      if (picks.length) return { kind: 'text', message: picks.map(i => awaiting.items[i - 1].content).join(', ') };
      return { kind: 'text', message: text };
    }
    const n = Number.parseInt(text, 10);
    if (Number.isInteger(n) && String(n) === text && n >= 1 && n <= awaiting.items.length) {
      return { kind: 'text', message: awaiting.items[n - 1].content };
    }
    return { kind: 'text', message: text };
  }

  // rating / text / typed inputs: pass the raw text; Typebot validates server-side.
  return { kind: 'text', message: text };
}
