// Sender-JID helpers. Pure — no ctx.
// NOTE: intentionally duplicated per plugin (plugins ship as self-contained zips) — keep all copies in
// sync; scripts/shared-copies.test.mjs fails the build when they drift.

// Only these JID domains identify a real WhatsApp user whose local part is an MSISDN. Everything else
// — `@lid` (privacy id), `@g.us` (group), `@newsletter` (channel), `@broadcast`, `status@broadcast` —
// also has a numeric local part, which is precisely why this is an ALLOWLIST: a denylist of `@lid`
// alone would emit a group or channel id as if it were a phone number, and a plausible-looking wrong
// number is worse than an empty one (it silently keys a CRM lookup or an authorization check to
// somebody who does not exist).
const USER_JID_DOMAINS = new Set(['c.us', 's.whatsapp.net']);

/** Digits of a sender JID, or '' when they would not be a real phone number. */
export function phoneFromJid(jid: string): string {
  const at = jid.lastIndexOf('@');
  if (at === -1) return '';
  if (!USER_JID_DOMAINS.has(jid.slice(at + 1).toLowerCase())) return '';
  // Strip the multi-device suffix: a Baileys sender can arrive as `628123:12@s.whatsapp.net`.
  const user = jid.slice(0, at).split(':')[0];
  return /^\d+$/.test(user) ? user : '';
}

// Chat ids that are NOT a conversation with a person or a group: `@newsletter` is a WhatsApp Channel
// (a broadcast feed this account follows) and `@broadcast` covers broadcast lists and `status@broadcast`.
// A denylist, unlike USER_JID_DOMAINS above, and deliberately so: the question there is "may these
// digits be published as a phone number", where an unknown domain must fail closed, while the question
// here is "should this plugin act at all", where an unknown domain should keep behaving as it does
// today rather than silently going quiet on a future WhatsApp id.
const BROADCAST_JID_DOMAINS = new Set(['newsletter', 'broadcast']);

/** True for a channel / broadcast-list / status chat id, which no responder should act on. */
export function isBroadcastJid(chatId: string): boolean {
  const at = chatId.lastIndexOf('@');
  return at !== -1 && BROADCAST_JID_DOMAINS.has(chatId.slice(at + 1).toLowerCase());
}
