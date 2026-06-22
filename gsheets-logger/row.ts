import type { HookContext, IncomingMessage } from '../types/openwa';

export const COLUMNS = [
  'timestamp', 'sessionId', 'event', 'direction', 'chatId', 'from', 'to',
  'senderName', 'isGroup', 'type', 'body', 'messageId', 'ackStatus', 'error',
] as const;

type FailedPayload = { sessionId?: string; error?: string; input?: { chatId?: string; text?: string } };
type AckPayload = { messageId?: string; status?: string };

// Neutralize CSV / spreadsheet formula injection on export/re-import (values are already written
// with valueInputOption=RAW, so Sheets never evaluates them — this is defense-in-depth for CSV
// round-trips). A leading single quote makes a spreadsheet treat the cell as literal text.
//
// `strId` guards the full formula-trigger set for structured/enum fields (ids, status, type) where
// a leading + - = @ is never legitimate.
function strId(value: unknown): string {
  const s = value == null ? '' : String(value);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

// `strText` is for free-text fields (message body, sender name, error). It omits `+` and `-` because
// those legitimately start human content (e.g. a phone number "+62812…" or "-5°C") and quoting them
// corrupts the value on CSV export. `=` and `@` (plus tab/CR) remain guarded — they never start
// normal prose and are the meaningful formula-injection vectors.
function strText(value: unknown): string {
  const s = value == null ? '' : String(value);
  return /^[=@\t\r]/.test(s) ? `'${s}` : s;
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
            '', '', 'text', strText(p.input?.text), '', '', strText(p.error)];
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
