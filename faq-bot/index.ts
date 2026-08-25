import type { IPlugin, PluginContext, HookContext, IncomingMessage } from '../types/openwa';
import { parseRules, matchRule, CompiledRule } from './rules.ts';
import { allowCooldown } from './cooldown.ts';

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

  const cooldown = Number(raw.fallbackCooldownSec ?? 600);
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

export default class FaqBot implements IPlugin {
  private readonly fallbackAt = new Map<string, number>();
  /** `${sessionId}:${chatId}:${pattern}` -> last answer for that rule, for MATCHED_REPLY_COOLDOWN_MS. */
  private readonly matchedAt = new Map<string, number>();

  async onEnable(ctx: PluginContext): Promise<void> {
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

  // Returns true when this plugin answered, so the hook can claim the message and stop another bot from
  // answering the same thing. Every early exit means "not mine".
  private async onMessage(ctx: PluginContext, hook: HookContext): Promise<boolean> {
    if (hook.source !== 'Engine' || !hook.sessionId) return false;
    const m = (hook.data ?? {}) as Partial<IncomingMessage>;
    // A sticker, image or voice note arrives with an empty body. No rule can match it, so the fallback
    // would answer a picture with "I did not understand" and claim the event away from a plugin that
    // could actually handle media. chat-flow guards the same way.
    if (m.fromMe || typeof m.body !== 'string' || !m.body.trim() || !m.chatId || !m.id) return false;
    // Since host 0.23.2 a shared contact card arrives with its full vCard as the body and a poll with
    // its question, so a non-empty body no longer means a human typed it. A vCard is free text (name,
    // org, notes, numbers) and readily matches a `contains` or `regex` rule; with `fallbackReply` set,
    // an unmatched card would answer and claim the event. 'unknown' stays admitted: business button and
    // list replies land there and are real answers to a question this bot asked.
    if (m.type === 'contact' || m.type === 'poll') return false;

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

    const sessionId = hook.sessionId;
    const rule = matchRule(cfg.rules, m.body);
    try {
      if (rule) {
        // Keyed on the INBOUND TEXT, not on the rule. A runaway exchange repeats the same message: the
        // other end's autoresponder sends one canned reply, this plugin answers, and that same canned
        // reply arrives again. Keying on the rule instead would have suppressed a customer's second,
        // genuinely different question whenever it happened to match the same rule ("berapa harga paket
        // A?" then "kalau harga paket B?"), which costs far more than the loop it prevents.
        // Claimed either way: the message matched a rule, so it is this plugin's, and the standard
        // allows a claim to resolve to silence.
        const key = `${sessionId}:${m.chatId}:${m.body.trim().toLowerCase().slice(0, 200)}`;
        if (!allowCooldown(this.matchedAt, key, Date.now(), MATCHED_REPLY_COOLDOWN_MS)) return true;
        try {
          await ctx.messages.reply(sessionId, m.chatId, m.id, rule.reply);
        } catch (e) {
          // Release the window: a reply that never arrived must not silence the next identical question.
          this.matchedAt.delete(key);
          throw e;
        }
        return true;
      }
      if (cfg.config.fallbackReply) {
        const key = `${sessionId}:${m.chatId}`;
        const cooldownMs = Math.max(0, cfg.config.fallbackCooldownSec) * 1000;
        if (allowCooldown(this.fallbackAt, key, Date.now(), cooldownMs)) {
          try {
            await ctx.messages.reply(sessionId, m.chatId, m.id, cfg.config.fallbackReply);
          } catch (err) {
            // The slot is claimed before the send, so a failed send would otherwise silence the chat for
            // a whole cooldown window over a reply that never arrived. Release it: a message that matched
            // a rule is retried on the next message too, and this costs at most one send attempt each.
            this.fallbackAt.delete(key);
            throw err;
          }
          return true;
        }
      }
    } catch (err) {
      ctx.logger.error('faq-bot: reply failed', err);
    }
    return false; // nothing delivered — a later plugin may still have an answer
  }
}
