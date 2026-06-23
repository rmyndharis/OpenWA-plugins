import type { IPlugin, PluginContext, HookContext, IncomingMessage } from '../types/openwa';
import { parseRules, matchRule, CompiledRule } from './rules.ts';

/** Cap on the per-chat fallback-cooldown map (drop oldest past this) so it can't grow unbounded. */
const MAX_COOLDOWN_ENTRIES = 5000;

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
    throw new Error(`faq-bot: invalid rules — ${err instanceof Error ? err.message : String(err)}`);
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

/**
 * Decide whether a fallback may be sent to `key` now. On allow, records `nowMs` (re-inserting so the
 * map evicts least-recently-used) and caps the map by dropping the LRU entry. A `cooldownMs` of 0 always allows.
 */
export function allowFallback(map: Map<string, number>, key: string, nowMs: number, cooldownMs: number): boolean {
  const last = map.get(key);
  if (last !== undefined && nowMs - last < cooldownMs) return false;
  map.delete(key); // re-insert so iteration order tracks recency (LRU by touch)
  map.set(key, nowMs);
  if (map.size > MAX_COOLDOWN_ENTRIES) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest !== undefined) map.delete(oldest);
  }
  return true;
}

export default class FaqBot implements IPlugin {
  private rules: CompiledRule[] = [];
  private config: FaqConfig = { fallbackReply: '', fallbackCooldownSec: 600, respondInGroups: false };
  private ctx: PluginContext | null = null;
  private readonly fallbackAt = new Map<string, number>();

  async onEnable(ctx: PluginContext): Promise<void> {
    this.apply(ctx);
    ctx.registerHook('message:received', async (hook: HookContext) => {
      await this.onMessage(hook);
      return { continue: true };
    });
  }

  async onConfigChange(ctx: PluginContext): Promise<void> {
    this.apply(ctx);
  }

  private apply(ctx: PluginContext): void {
    this.ctx = ctx;
    const { config, rules, skipped } = parseConfig(ctx.config);
    this.rules = rules;
    this.config = config;
    if (skipped.length) {
      ctx.logger.warn(`faq-bot: skipped ${skipped.length} rule(s) with an invalid regex: ${skipped.join(', ')}`);
    }
  }

  private async onMessage(hook: HookContext): Promise<void> {
    if (hook.source !== 'Engine' || !hook.sessionId) return;
    const m = (hook.data ?? {}) as Partial<IncomingMessage>;
    if (m.fromMe || typeof m.body !== 'string' || !m.chatId || !m.id) return;
    if (m.isGroup && !this.config.respondInGroups) return;

    const sessionId = hook.sessionId;
    const rule = matchRule(this.rules, m.body);
    try {
      if (rule) {
        await this.ctx?.messages.reply(sessionId, m.chatId, m.id, rule.reply);
        return;
      }
      if (this.config.fallbackReply) {
        const key = `${sessionId}:${m.chatId}`;
        const cooldownMs = Math.max(0, this.config.fallbackCooldownSec) * 1000;
        if (allowFallback(this.fallbackAt, key, Date.now(), cooldownMs)) {
          await this.ctx?.messages.reply(sessionId, m.chatId, m.id, this.config.fallbackReply);
        }
      }
    } catch (err) {
      this.ctx?.logger.error('faq-bot: reply failed', err);
    }
  }
}
