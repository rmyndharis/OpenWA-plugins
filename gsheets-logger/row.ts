import type { HookContext, IncomingMessage } from '../types/openwa';

export const COLUMNS = [
  'timestamp', 'sessionId', 'event', 'direction', 'chatId', 'from', 'to',
  'senderName', 'isGroup', 'type', 'body', 'messageId', 'ackStatus', 'error',
] as const;

// `message:failed` used to fire only from sendText, so a hardcoded 'text' type and an `input.text` body
// were accurate. It now fires from every sender (image, video, voice, audio, document, location, contact, poll,
// sticker, reply, forward, bulk) through one shared failure path that carries the real `type`, and a
// media send's DTO holds its caption in `caption`, not `text`. It does NOT fire from edit, which has no
// failure path of its own — the `body` fallback below is future-proofing for one. A bulk item carries neither `chatId` nor
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
// Cutting at a fixed code-unit count can land BETWEEN a surrogate pair, leaving a lone high surrogate
// as the last character. That is not valid Unicode: it cannot be encoded as UTF-8 (the host encodes
// the request body), so the cell is corrupted at best and rejected at worst, on exactly the oversized
// sender-controlled body this cap exists to make safe. Back off one unit instead, the same way
// http-action truncates its reply.
const cap = (s: string): string => {
  if (s.length <= MAX_CELL) return s;
  const last = s.charCodeAt(MAX_CELL - 1);
  const cut = last >= 0xd800 && last <= 0xdbff ? MAX_CELL - 1 : MAX_CELL;
  return s.slice(0, cut);
};

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

// `strText` is for free-text fields (message body, sender name, error). `=` and `@` (plus tab/CR) never
// start normal prose and are always guarded. A leading `+`/`-` is the awkward one, because a phone
// number and a formula both start that way, so it is decided by what FOLLOWS the sign:
//
//   pure number punctuation  ->  never quoted   "+62 (812) 3456-7890", "-1.5"
//   starts with a non-digit  ->  quoted         "-IMPORTXML(…)", "+ HYPERLINK(…)"
//   digit, then ( & or !     ->  quoted         "-1+IMPORTXML(…)", "+1+HYPERLINK(…)"
//   digit, then plain prose  ->  never quoted   "+62812 call me", "-5 degrees today"
//
// Testing only the single character after the sign passed anything that began with a digit, so
// "-1+IMPORTXML(…)" was written unquoted: a live formula that merely starts like a number. Requiring
// the whole remainder to be numeric would have closed that but quoted ordinary messages beginning with
// a phone number, which two earlier changes deliberately made readable. Formula machinery is the
// discriminator instead: a call needs `(`, exfiltration needs `&` to build its URL, and `!` is a sheet
// reference. None of the three appears in a phone number that is not already all digits and brackets.
function strText(value: unknown): string {
  const s = value == null ? '' : String(value);
  if (/^[=@\t\r]/.test(s)) return cap(`'${s}`);
  if (!/^[+\-]/.test(s)) return cap(s);
  const rest = s.slice(1);
  if (/^[\d\s().\-]*$/.test(rest)) return cap(s); // a number or a phone, never a formula
  return cap(/^[^\d.]/.test(rest) || /[(&!]/.test(rest) ? `'${s}` : s);
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
