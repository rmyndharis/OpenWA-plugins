import type { IPlugin, PluginContext, HookContext, IncomingMessage } from '../types/openwa';
import { parseSchedule, assertValidTimezone, isAfterHours, Schedule } from './schedule.ts';
import { allowCooldown } from './cooldown.ts';

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

  const cooldown = Number(raw.cooldownSec ?? 3600);
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

export default class AfterHours implements IPlugin {
  private readonly repliedAt = new Map<string, number>();
  // Absolute "do not retry before" deadline per chat, set when a reply FAILS. Kept separately instead of
  // rewinding the cooldown timestamp: a rewind is only meaningful against the cooldown value it was
  // computed from, and config is re-read per message — so an operator lowering cooldownSec in the
  // dashboard would turn the stored value into "long past" and hand back the un-throttled retry storm
  // this exists to prevent.
  private readonly retryNotBefore = new Map<string, number>();

  async onEnable(ctx: PluginContext): Promise<void> {
    parseConfig(ctx.config); // fail-fast: surface invalid config at enable, not per-message
    ctx.registerHook('message:received', async (hook: HookContext) => {
      await this.onMessage(ctx, hook);
      return { continue: true };
    });
  }

  async onConfigChange(ctx: PluginContext, _newConfig: Record<string, unknown>): Promise<void> {
    parseConfig(ctx.config); // re-validate on change (fail-fast feedback in the dashboard)
  }

  private async onMessage(ctx: PluginContext, hook: HookContext): Promise<void> {
    if (hook.source !== 'Engine' || !hook.sessionId) return;
    const m = (hook.data ?? {}) as Partial<IncomingMessage>;
    if (m.fromMe || typeof m.body !== 'string' || !m.chatId || !m.id) return;

    // Re-parse per event so a per-session config override (resolved by the host for this hook fire) is
    // honored — a snapshot cached at enable would ignore overrides set via the dashboard after enable.
    let cfg: { config: AfterHoursConfig; schedule: Schedule };
    try {
      cfg = parseConfig(ctx.config);
    } catch (e) {
      ctx.logger.warn(`after-hours: skipping message, config invalid: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    if (m.isGroup && !cfg.config.respondInGroups) return;
    if (!isAfterHours(new Date(), cfg.schedule, cfg.config.timezone)) return;

    const sessionId = hook.sessionId;
    const key = `${sessionId}:${m.chatId}`;
    const cooldownMs = Math.max(0, cfg.config.cooldownSec) * 1000;
    const notBefore = this.retryNotBefore.get(key);
    if (notBefore !== undefined && Date.now() < notBefore) return; // still inside a failure backoff
    if (!allowCooldown(this.repliedAt, key, Date.now(), cooldownMs)) return;

    try {
      await ctx.messages.reply(sessionId, m.chatId, m.id, cfg.config.awayMessage);
      this.retryNotBefore.delete(key); // delivered — the backoff no longer applies
    } catch (err) {
      // The cooldown slot is burned BEFORE the send (allowCooldown records on the allow path), so a
      // failed reply would otherwise silence this chat for the whole window with nothing delivered —
      // reachable more often now that another plugin vetoing `message:sending` surfaces here as a
      // thrown error, indistinguishable from a transport failure.
      //
      // Free the cooldown slot (nothing was delivered, so it should not silence the chat for the whole
      // window) but install an absolute backoff deadline instead. Clearing the slot ALONE removes the only
      // throttle: against a permanently-failing send — a compliance plugin vetoing this chat — every
      // inbound message would retry immediately, 60 messages meaning 60 send attempts and 60 full
      // `message:sending` fan-outs across every installed plugin.
      this.repliedAt.delete(key);
      this.retryNotBefore.set(key, Date.now() + RETRY_BACKOFF_MS);
      ctx.logger.error('after-hours: reply failed', err);
    }
  }
}
