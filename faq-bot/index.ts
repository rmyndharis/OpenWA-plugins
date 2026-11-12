import type { IPlugin, PluginContext, HookContext, IncomingMessage } from '../types/openwa';
import { parseRules, matchRule, CompiledRule } from './rules.ts';
import { allowCooldown } from './cooldown.ts';
import { isBroadcastJid } from './jid.ts';

export interface FaqConfig {
  fallbackReply: string;
  fallbackCooldownSec: number;
  respondInGroups: boolean;
}

export function parseConfig(raw: Record<string, unknown>): {
  config: FaqConfig;
  rules: CompiledRule[];
  skipped: string[];
} {
  const rulesJson = String(raw.rules ?? '').trim();
  if (!rulesJson) throw new Error('faq-bot: rules is required (a JSON array)');

  let parsed: { rules: CompiledRule[]; skipped: string[] };
  try {
    parsed = parseRules(rulesJson);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `faq-bot: invalid rules — ${detail}. Expected a JSON array like ` +
        `[{"mode":"contains","pattern":"openwa","reply":"yes?"}] — use double quotes, not single.`,
    );
  }

  const rawCooldown =
    typeof raw.fallbackCooldownSec === 'string' && !raw.fallbackCooldownSec.trim()
      ? undefined
      : raw.fallbackCooldownSec;
  const cooldown = Number(rawCooldown ?? 600);
  return {
    rules: parsed.rules,
    skipped: parsed.skipped,
    config: {
      fallbackReply: String(raw.fallbackReply ?? ''),
      fallbackCooldownSec: Number.isFinite(cooldown) ? cooldown : 600,
      respondInGroups: raw.respondInGroups === true,
    },
  };
}

// Responder band: keyword rules are more specific than a bot that answers everything, less specific than
// a command prefix.
const HOOK_PRIORITY = 80;

// Minimum gap before the SAME inbound text is answered again in the same chat. Hardcoded, like the retry
// cadence in the other plugins: it exists to stop a runaway exchange, not to be tuned. A rule whose own
// reply matches its own pattern is a fixed point, and an autoresponder on the other end then answers each
// of this plugin's replies forever, at full message rate, repeating one canned message as it goes.
// Keyed on the text rather than the rule or the chat, so two different questions are both answered even
// when they match the same rule.
const MATCHED_REPLY_COOLDOWN_MS = 10_000;
const RETRY_BACKOFF_MS = 60_000;
const MAX_RETRY_ENTRIES = 5_000;

// A message sent longer ago than this is never answered. From OpenWA 0.23.6 a Baileys session delivers,
// after it reconnects, what WhatsApp queued while it was disconnected, each message with its original send
// time, so a long outage ended in a burst of canned replies quoting old messages, often in chats already
// answered from the phone. Five minutes is far above clock skew between WhatsApp and the gateway and
// matches the host's own auto-reply age limit.
const LATE_AFTER_MS = 5 * 60_000;

export default class FaqBot implements IPlugin {
  private ctx: PluginContext | null = null;
  private readonly fallbackAt = new Map<string, number>();
  /** `${sessionId}:${chatId}:${pattern}` -> last answer for that rule, for MATCHED_REPLY_COOLDOWN_MS. */
  private readonly matchedAt = new Map<string, number>();
  private readonly replyAttempts = new Map<string, object>();
  private readonly retryNotBefore = new Map<string, number>();

  async onEnable(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;
    this.warnSkipped(ctx); // fail-fast + surface any invalid regex rules at enable
    ctx.registerHook(
      'message:received',
      async (hook: HookContext) => ({ continue: !(await this.onMessage(ctx, hook)) }),
      HOOK_PRIORITY,
    );
  }

  async onConfigChange(ctx: PluginContext): Promise<void> {
    this.warnSkipped(ctx); // re-validate on change (fail-fast feedback + fresh skipped warning)
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    if (!this.ctx) return { healthy: false, message: 'faq-bot: not enabled' };
    try {
      const { rules } = parseConfig(this.ctx.config);
      return { healthy: true, message: `faq-bot: ${rules.length} rule(s)` };
    } catch (e) {
      return { healthy: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  private warnSkipped(ctx: PluginContext): void {
    const { skipped } = parseConfig(ctx.config);
    if (skipped.length) {
      // Truncate each pattern before joining. The host caps a log line at 8 KiB and drops the overflow,
      // so one pathological rule could push the list past the cap and take every other skipped pattern
      // with it — losing exactly the diagnostic this line exists to give.
      const preview = skipped.map(p => (p.length > 80 ? `${p.slice(0, 80)}…` : p)).join(', ');
      ctx.logger.warn(`faq-bot: skipped ${skipped.length} rule(s) with an invalid regex: ${preview}`);
    }
  }

  // Claim before sending, so a slow reply cannot outlive the host's hook budget.
  private async onMessage(ctx: PluginContext, hook: HookContext): Promise<boolean> {
    if (hook.source !== 'Engine' || !hook.sessionId) return false;
    const m = (hook.data ?? {}) as Partial<IncomingMessage>;
    // A sticker, image or voice note arrives with an empty body. No rule can match it, so the fallback
    // would answer a picture with "I did not understand" and claim the event away from a plugin that
    // could actually handle media. chat-flow guards the same way.
    if (m.fromMe || typeof m.body !== 'string' || !m.body.trim() || !m.chatId || !m.id) return false;
    // Since host 0.23.2 a shared contact card arrives with its full vCard as the body and a poll with
    // its question, and since 0.23.5 a Baileys 'order' carries the order note and a 'product' card the
    // product title, so a non-empty body no longer means a human typed it. A vCard is free text (name,
    // org, notes, numbers) and readily matches a `contains` or `regex` rule; with `fallbackReply` set,
    // an unmatched card would answer and claim the event. 'unknown' stays admitted: business button and
    // list replies land there on whatsapp-web.js (Baileys delivers them as 'text' from 0.23.6, as
    // 'unknown' before) and are real answers to a question this bot asked. A Baileys whole-catalog share
    // also arrives as 'unknown' with the catalog title as the body, and cannot be told apart from those.
    if (m.isForwarded) return false;
    if (
      m.type === 'contact' ||
      m.type === 'poll' ||
      m.type === 'order' ||
      m.type === 'product' ||
      m.type === 'location'
    ) {
      return false;
    }

    // Re-parse per event so a per-session config override (resolved by the host for this hook fire) is
    // honored — a snapshot cached at enable would ignore overrides set via the dashboard after enable.
    let cfg: { config: FaqConfig; rules: CompiledRule[] };
    try {
      cfg = parseConfig(ctx.config);
    } catch (e) {
      ctx.logger.warn(`faq-bot: skipping message, config invalid: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }

    if (m.isGroup && !cfg.config.respondInGroups) return false;
    // `isGroup` is a boolean over a five-way discriminator, so it cannot see a WhatsApp Channel: a
    // `@newsletter` post arrives flagged as a non-group chat and reads exactly like a 1:1 message.
    // Nothing filters it upstream (the host diverts only status broadcasts), so a channel this account
    // merely FOLLOWS drew a reply into a chat it can never post to, burning the per-chat slot and
    // logging a send failure per post. Broadcast-list ids are the same shape. Matched on the JID rather
    // than `msg.kind`, which the host only stamps from 0.10.8, below every floor in this catalogue.
    if (isBroadcastJid(m.chatId)) return false;

    const sessionId = hook.sessionId;
    const rule = matchRule(cfg.rules, m.body);
    // `timestamp` is unix seconds; a missing, zero, negative or unrepresentable one counts as sent now.
    const sent = new Date((m.timestamp ?? 0) * 1000);
    const late = sent.getTime() > 0 && Date.now() - sent.getTime() > LATE_AFTER_MS;
    try {
      if (rule) {
        // Keyed on the INBOUND TEXT, not on the rule. A runaway exchange repeats the same message: the
        // other end's autoresponder sends one canned reply, this plugin answers, and that same canned
        // reply arrives again. Keying on the rule instead would have suppressed a customer's second,
        // genuinely different question whenever it happened to match the same rule ("berapa harga paket
        // A?" then "kalau harga paket B?"), which costs far more than the loop it prevents.
        // Claimed either way, too old to answer included: the message matched a rule, so it is this
        // plugin's, and the standard allows a claim to resolve to silence.
        if (late) return true;
        const key = `${sessionId}:${m.chatId}:${m.body.trim().toLowerCase().slice(0, 200)}`;
        const attemptKey = `matched:${key}`;
        const notBefore = this.retryNotBefore.get(attemptKey);
        if (notBefore !== undefined && Date.now() < notBefore) return true;
        if (!allowCooldown(this.matchedAt, key, Date.now(), MATCHED_REPLY_COOLDOWN_MS)) return true;
        this.dispatchReply(ctx, sessionId, m.chatId, m.id, rule.reply, attemptKey, this.matchedAt, key);
        return true;
      }
      if (cfg.config.fallbackReply && !late) {
        const key = `${sessionId}:${m.chatId}`;
        const attemptKey = `fallback:${key}`;
        const notBefore = this.retryNotBefore.get(attemptKey);
        if (notBefore !== undefined && Date.now() < notBefore) return false;
        const cooldownMs = Math.max(0, cfg.config.fallbackCooldownSec) * 1000;
        if (allowCooldown(this.fallbackAt, key, Date.now(), cooldownMs)) {
          this.dispatchReply(ctx, sessionId, m.chatId, m.id, cfg.config.fallbackReply, attemptKey, this.fallbackAt, key);
          return true;
        }
      }
    } catch (err) {
      ctx.logger.error('faq-bot: reply failed', err);
    }
    return false;
  }

  private dispatchReply(
    ctx: PluginContext,
    sessionId: string,
    chatId: string,
    messageId: string,
    text: string,
    attemptKey: string,
    cooldownMap: Map<string, number>,
    cooldownKey: string,
  ): void {
    const attempt = {};
    this.replyAttempts.set(attemptKey, attempt);
    void ctx.messages.reply(sessionId, chatId, messageId, text).then(() => {
      if (this.replyAttempts.get(attemptKey) !== attempt) return;
      this.replyAttempts.delete(attemptKey);
      this.retryNotBefore.delete(attemptKey);
    }, err => {
      if (this.replyAttempts.get(attemptKey) === attempt) {
        this.replyAttempts.delete(attemptKey);
        cooldownMap.delete(cooldownKey);
        this.retryNotBefore.set(attemptKey, Date.now() + RETRY_BACKOFF_MS);
        if (this.retryNotBefore.size > MAX_RETRY_ENTRIES) {
          const now = Date.now();
          for (const [k, until] of this.retryNotBefore) if (until <= now) this.retryNotBefore.delete(k);
          for (const k of this.retryNotBefore.keys()) {
            if (this.retryNotBefore.size <= MAX_RETRY_ENTRIES) break;
            this.retryNotBefore.delete(k);
          }
        }
      }
      ctx.logger.error('faq-bot: reply failed', err);
    });
  }
}
