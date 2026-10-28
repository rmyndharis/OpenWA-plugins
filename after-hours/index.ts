import type { IPlugin, PluginContext, HookContext, IncomingMessage } from '../types/openwa';
import { parseSchedule, assertValidTimezone, isAfterHours, Schedule } from './schedule.ts';
import { allowCooldown } from './cooldown.ts';
import { isBroadcastJid } from './jid.ts';

export interface AfterHoursConfig {
  timezone: string;
  awayMessage: string;
  cooldownSec: number;
  respondInGroups: boolean;
}

export function parseConfig(raw: Record<string, unknown>): { config: AfterHoursConfig; schedule: Schedule } {
  const scheduleJson = String(raw.schedule ?? '').trim();
  if (!scheduleJson) throw new Error('after-hours: schedule is required (a JSON object)');

  let schedule: Schedule;
  try {
    schedule = parseSchedule(scheduleJson);
  } catch (err) {
    throw new Error(`after-hours: invalid schedule — ${err instanceof Error ? err.message : String(err)}`);
  }

  const awayMessage = String(raw.awayMessage ?? '');
  if (!awayMessage) throw new Error('after-hours: awayMessage is required');

  const timezone = String(raw.timezone ?? 'UTC') || 'UTC';
  assertValidTimezone(timezone);

  // `Number("")` is 0, and 0 is the documented "reply every time" value, so a blank cooldownSec (an
  // empty or whitespace-only string, which the config REST API stores verbatim) silently disabled the
  // throttle instead of falling back to the default. Blank means "not set", not zero.
  const rawCooldown = typeof raw.cooldownSec === 'string' && !raw.cooldownSec.trim() ? undefined : raw.cooldownSec;
  const cooldown = Number(rawCooldown ?? 3600);
  return {
    schedule,
    config: {
      timezone,
      awayMessage,
      cooldownSec: Number.isFinite(cooldown) ? cooldown : 3600,
      respondInGroups: raw.respondInGroups === true,
    },
  };
}

// How long to wait before re-attempting an away reply that failed. Short enough that a transient
// failure recovers on the contact's next message, long enough that a permanently-blocked send
// cannot turn every inbound message into another send attempt.
const RETRY_BACKOFF_MS = 60_000;

// The backoff map holds one entry per chat that failed a send. Entries are removed on the next
// delivery, but a chat that never messages again leaves one behind — so cap it. Every other piece of
// state in this plugin is already bounded; this was the exception.
const MAX_RETRY_ENTRIES = 5_000;

// Responder band, last: the away message is the catch-all that speaks only when nothing more specific
// answered.
const HOOK_PRIORITY = 95;

export default class AfterHours implements IPlugin {
  // Held for healthCheck(), which the host calls with no context of its own.
  private ctx: PluginContext | null = null;
  private readonly repliedAt = new Map<string, number>();
  private readonly replyAttempts = new Map<string, object>();
  // Absolute "do not retry before" deadline per chat, set when a reply FAILS. Kept separately instead of
  // rewinding the cooldown timestamp: a rewind is only meaningful against the cooldown value it was
  // computed from, and config is re-read per message — so an operator lowering cooldownSec in the
  // dashboard would turn the stored value into "long past" and hand back the un-throttled retry storm
  // this exists to prevent.
  private readonly retryNotBefore = new Map<string, number>();

  async onEnable(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;
    parseConfig(ctx.config); // fail-fast: surface invalid config at enable, not per-message
    ctx.registerHook(
      'message:received',
      async (hook: HookContext) => ({ continue: !(await this.onMessage(ctx, hook)) }),
      HOOK_PRIORITY,
    );
  }

  async onConfigChange(ctx: PluginContext, _newConfig: Record<string, unknown>): Promise<void> {
    parseConfig(ctx.config); // re-validate on change (fail-fast feedback in the dashboard)
  }

  /**
   * Reports on the BASE config: outside a hook the host resolves no per-session slice. A config edit
   * that fails validation after enable is only logged (the host swallows onConfigChange's rejection),
   * and every message then hits the same parse failure and is skipped. Without this the host answers
   * "Plugin does not implement health check" with healthy:true, so the dashboard shows the plugin
   * enabled and healthy while it answers nothing, indefinitely.
   */
  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    if (!this.ctx) return { healthy: false, message: 'after-hours: not enabled' };
    try {
      const { config } = parseConfig(this.ctx.config);
      return { healthy: true, message: `after-hours: ${config.timezone}, cooldown ${config.cooldownSec}s` };
    } catch (e) {
      return { healthy: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  // Claim an attempted reply before sending, so a slow send cannot outlive the host's hook budget.
  private async onMessage(ctx: PluginContext, hook: HookContext): Promise<boolean> {
    if (hook.source !== 'Engine' || !hook.sessionId) return false;
    const m = (hook.data ?? {}) as Partial<IncomingMessage>;
    if (m.fromMe || typeof m.body !== 'string' || !m.chatId || !m.id) return false;
    // From host 0.26.0 a message delivered already deleted reaches the hook as an empty 'revoked'
    // placeholder: there is nothing left to answer. A caption-less image or sticker is empty too and does
    // still draw the away message, so this is keyed on the type, not on an empty body.
    if (m.type === 'revoked') return false;

    // Re-parse per event so a per-session config override (resolved by the host for this hook fire) is
    // honored — a snapshot cached at enable would ignore overrides set via the dashboard after enable.
    let cfg: { config: AfterHoursConfig; schedule: Schedule };
    try {
      cfg = parseConfig(ctx.config);
    } catch (e) {
      ctx.logger.warn(`after-hours: skipping message, config invalid: ${e instanceof Error ? e.message : String(e)}`);
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
    // Closed at BOTH the message's own send time and now. From OpenWA 0.23.6 a Baileys session delivers
    // what WhatsApp queued during a disconnect once it reconnects, so a message written during opening
    // hours (perhaps already answered from the phone) can arrive after closing. And a message written
    // overnight but delivered after opening must not be told "we're closed". `timestamp` is unix
    // seconds; a missing, zero, negative or unrepresentable one reads as NaN or <= 0 and falls back to now.
    const now = new Date();
    const sent = new Date((m.timestamp ?? 0) * 1000);
    const sentAt = sent.getTime() > 0 ? sent : now;
    if (!isAfterHours(sentAt, cfg.schedule, cfg.config.timezone)) return false;
    if (!isAfterHours(now, cfg.schedule, cfg.config.timezone)) return false;

    const sessionId = hook.sessionId;
    const key = `${sessionId}:${m.chatId}`;
    const cooldownMs = Math.max(0, cfg.config.cooldownSec) * 1000;
    const notBefore = this.retryNotBefore.get(key);
    if (notBefore !== undefined && Date.now() < notBefore) return false; // still inside a failure backoff
    if (!allowCooldown(this.repliedAt, key, Date.now(), cooldownMs)) return false;

    const attempt = {};
    this.replyAttempts.set(key, attempt);
    void ctx.messages.reply(sessionId, m.chatId, m.id, cfg.config.awayMessage).then(() => {
      if (this.replyAttempts.get(key) !== attempt) return;
      this.replyAttempts.delete(key);
      this.retryNotBefore.delete(key); // delivered — the backoff no longer applies
    }, err => {
      if (this.replyAttempts.get(key) === attempt) {
        this.replyAttempts.delete(key);
        // Release this attempt's cooldown, then back off to avoid a send failure loop.
        this.repliedAt.delete(key);
        this.retryNotBefore.set(key, Date.now() + RETRY_BACKOFF_MS);
        // Drop elapsed entries first, then the oldest if the cap is still exceeded.
        if (this.retryNotBefore.size > MAX_RETRY_ENTRIES) {
          const now = Date.now();
          for (const [k, until] of this.retryNotBefore) if (until <= now) this.retryNotBefore.delete(k);
          for (const k of this.retryNotBefore.keys()) {
            if (this.retryNotBefore.size <= MAX_RETRY_ENTRIES) break;
            this.retryNotBefore.delete(k);
          }
        }
      }
      ctx.logger.error('after-hours: reply failed', err);
    });
    return true;
  }
}
