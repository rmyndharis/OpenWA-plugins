import type { HookContext, IncomingMessage } from '../types/openwa';

export const COLUMNS = [
  'timestamp', 'sessionId', 'event', 'direction', 'chatId', 'from', 'to',
  'senderName', 'isGroup', 'type', 'body', 'messageId', 'ackStatus', 'error',
] as const;

// `message:failed` used to fire only from sendText, so a hardcoded 'text' type and an `input.text` body
// were accurate. It now fires from every sender (image, video, voice, document, location, contact, poll,
// sticker, reply, forward, bulk) through one shared failure path that carries the real `type` — and
// NOT from edit, which has no failure path of its own; the `body` fallback below is future-proofing —
// a media send's DTO holds its caption in `caption`, not `text`. A bulk item carries neither `chatId` nor
// a per-recipient field: its payload is the shared content, so those columns are genuinely blank.
type FailedPayload = {
  sessionId?: string;
  error?: string;
  type?: string;
  input?: { chatId?: string; text?: string; caption?: string; body?: string };
};
type AckPayload = { messageId?: string; status?: string };

// Google Sheets rejects a cell longer than 50 000 chars with a 400 that fails the whole append batch;
// one over-limit inbound body would then stall all logging (the batch is retained and retried forever).
// Cap every cell as the final step so a single long message can't poison the pipeline. Applied after the
// quote prefix so the guarded prefix is never truncated away.
const MAX_CELL = 50000;
const cap = (s: string): string => (s.length > MAX_CELL ? s.slice(0, MAX_CELL) : s);

// Neutralize CSV / spreadsheet formula injection on export/re-import (values are already written
// with valueInputOption=RAW, so Sheets never evaluates them — this is defense-in-depth for CSV
// round-trips). A leading single quote makes a spreadsheet treat the cell as literal text.
//
// `strId` guards the full formula-trigger set for structured/enum fields (ids, status, type) where
// a leading + - = @ is never legitimate.
function strId(value: unknown): string {
  const s = value == null ? '' : String(value);
  return cap(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);
}

// `strText` is for free-text fields (message body, sender name, error). A leading `+`/`-` is quoted
// only when it is NOT the start of a number (`(?![\d.])`), so a phone number "+62812…" or "-5°C" stays
// readable while a formula like "-IMPORTXML(…)" / "+ HYPERLINK(…)" is neutralized. `=` and `@` (plus
// tab/CR) never start normal prose and are always guarded.
function strText(value: unknown): string {
  const s = value == null ? '' : String(value);
  return cap(/^[=@\t\r]/.test(s) || /^[+\-](?![\d.])/.test(s) ? `'${s}` : s);
}

export function buildRow(ctx: HookContext): string[] {
  const event = ctx.event;
  const timestamp = new Date(ctx.timestamp ?? Date.now()).toISOString();
  const sessionId = strId(ctx.sessionId);
  const direction = event === 'message:received' ? 'in' : 'out';

  if (event === 'message:failed') {
    const p = (ctx.data ?? {}) as FailedPayload;
    // A failed send carries no recipient field, so the destination (to) mirrors chatId; from is unknown.
    return [timestamp, sessionId, event, direction, strId(p.input?.chatId), '', strId(p.input?.chatId),
            '', '', strId(p.type ?? 'text'), strText(p.input?.text ?? p.input?.caption ?? p.input?.body),
            '', '', strText(p.error)];
  }

  if (event === 'message:ack') {
    const p = (ctx.data ?? {}) as AckPayload;
    return [timestamp, sessionId, event, direction, '', '', '', '', '', '', '', strId(p.messageId), strId(p.status), ''];
  }

  // message:received / message:sent carry an IncomingMessage
  const m = (ctx.data ?? {}) as Partial<IncomingMessage>;
  const senderName = m.contact?.pushName || m.contact?.name || '';
  return [timestamp, sessionId, event, direction, strId(m.chatId), strId(m.from), strId(m.to),
          strText(senderName), strId(m.isGroup), strId(m.type), strText(m.body), strId(m.id), '', ''];
}
