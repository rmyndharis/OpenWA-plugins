import type { IncomingMessage } from '../types/openwa';
import type { Awaiting, ReplyIntent } from './typebot-types.ts';

// Map a WhatsApp reply to the argument for continueChat, given what the bot is waiting for.
export function mapReply(awaiting: Awaiting, msg: IncomingMessage): ReplyIntent {
  const text = (msg.body ?? '').trim();
  const card = msg.type === 'contact' || msg.type === 'poll' || msg.type === 'order' || msg.type === 'product';

  // File input, or a text input that accepts attachments: prefer the media.
  if (awaiting.kind === 'file' || (awaiting.kind === 'text' && awaiting.attachmentsEnabled)) {
    const skip = awaiting.kind === 'file' && awaiting.skipLabel ? ` Or reply "${awaiting.skipLabel}" to skip this step.` : '';
    if (msg.media?.data && !msg.media.omitted) {
      return { kind: 'file', mime: msg.media.mimetype, filename: msg.media.filename ?? 'file', data: msg.media.data };
    }
    if (msg.media?.omitted) {
      // Cause-neutral on purpose: `omitted` carries no reason, and size is one of five (the byte cap,
      // a download timeout, a disabled download, a failed download, a spent history media budget).
      // Host 0.23.4 added the failed download on both engines, which is the retryable one, so naming
      // size told most of these contacts to do the one thing that cannot help. The vendored contract
      // says so directly: see the `omitted` note in types/openwa.d.ts.
      // A file step refuses typed text, so only a text step may offer it.
      return awaiting.kind === 'text'
        ? { kind: 'fallback', text: 'That attachment did not come through. Please try sending it again, or type to continue.' }
        : { kind: 'fallback', text: `That attachment did not come through. Please try sending it again.${skip}` };
    }
    if (awaiting.kind === 'text') return { kind: 'text', message: text }; // attachment optional → plain text ok
    // Only the exact skip word skips: a skip cannot be undone, and contacts often type a line before the photo.
    if (awaiting.skipLabel && !card && text.toLowerCase() === awaiting.skipLabel.toLowerCase()) return { kind: 'skip' };
    return { kind: 'fallback', text: `Please send a file or photo to continue.${skip}` };
  }

  // Since host 0.23.2 a shared contact card arrives with its full vCard as the body and a poll with its
  // question, and from 0.23.5 a Baileys order carries its note or title and a product card its text or
  // the product title, so `text` is no longer proof the contact typed an answer. Submitting any of the
  // four advances the flow with garbage, and a bare in-range digit (a street number, a pack size) would
  // silently select a numbered choice. Prompt instead and leave the step where it is. Deliberately after
  // the file branch above, so sharing a card at a file step still gets that step's own wording.
  if (card) {
    return { kind: 'fallback', text: 'Please type your answer to continue.' };
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
