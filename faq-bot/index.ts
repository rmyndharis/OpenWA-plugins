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

export default class FaqBot implements IPlugin {
  private readonly fallbackAt = new Map<string, number>();

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
    if (m.fromMe || typeof m.body !== 'string' || !m.chatId || !m.id) return false;

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
        await ctx.messages.reply(sessionId, m.chatId, m.id, rule.reply);
        return true;
      }
      if (cfg.config.fallbackReply) {
        const key = `${sessionId}:${m.chatId}`;
        const cooldownMs = Math.max(0, cfg.config.fallbackCooldownSec) * 1000;
        if (allowCooldown(this.fallbackAt, key, Date.now(), cooldownMs)) {
          await ctx.messages.reply(sessionId, m.chatId, m.id, cfg.config.fallbackReply);
          return true;
        }
      }
    } catch (err) {
      ctx.logger.error('faq-bot: reply failed', err);
    }
    return false; // nothing delivered — a later plugin may still have an answer
  }
}
