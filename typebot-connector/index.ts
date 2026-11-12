import type { IPlugin, PluginContext, IncomingMessage, HookContext, HookResult } from '../types/openwa';
import type { TypebotConfig } from './typebot-types.ts';
import { KeyedAsyncLock } from './chat-lock.ts';
import { SessionStore } from './session-store.ts';
import { TypebotClient } from './typebot-client.ts';
import { handleTurn, LATE_AFTER_MS } from './turn.ts';
import { inScope } from './filters.ts';

// Responder band, late: this plugin auto-starts a flow for every chat it is in scope for, so it is a
// catch-all brain and should not pre-empt a command or an in-flow menu.
const HOOK_PRIORITY = 85;

// Read + validate config. Fail-fast on a bad apiHost so a misconfigured plugin never silently no-ops (the
// host net allowlist only admits an https, credential-free host).
export function readConfig(raw: Record<string, unknown>): TypebotConfig {
  // No code-side default for apiHost: the core net-allowlist gate resolves the allowed host from the RAW
  // config, so a code default would enable the plugin while every outbound call is gated into a silent
  // no-op. Require it (the manifest keeps a `default` for the dashboard pre-fill).
  const apiHost = String(raw.apiHost ?? '').trim();
  const publicId = String(raw.publicId ?? '').trim();
  if (!publicId) throw new Error('typebot-connector: publicId is required');
  if (!apiHost) throw new Error('typebot-connector: apiHost is required');
  let parsed: URL;
  try {
    parsed = new URL(apiHost);
  } catch {
    throw new Error('typebot-connector: apiHost must be a valid URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('typebot-connector: apiHost must be an https URL without embedded credentials');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('typebot-connector: apiHost must not contain a query string or fragment');
  }
  const mediaHostRaw = String(raw.mediaHost ?? '').trim();
  if (mediaHostRaw) {
    let parsedMedia: URL;
    try {
      parsedMedia = new URL(mediaHostRaw);
    } catch {
      throw new Error('typebot-connector: mediaHost must be a valid URL');
    }
    if (parsedMedia.protocol !== 'https:' || parsedMedia.username || parsedMedia.password) {
      throw new Error('typebot-connector: mediaHost must be an https URL without embedded credentials');
    }
  }
  const timeout = Number(raw.sessionTimeoutMinutes);
  return {
    apiHost: apiHost.replace(/\/+$/, ''),
    publicId,
    apiToken: raw.apiToken ? String(raw.apiToken) : undefined,
    respondInGroups: raw.respondInGroups !== false,
    sessionTimeoutMinutes: Number.isFinite(timeout) && timeout > 0 ? timeout : 30,
    passContactVariables: raw.passContactVariables !== false,
  };
}

// How often the abandoned-session sweep may run. In-memory and best-effort: a worker restart just means
// the first turn after it sweeps again, which is harmless.
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

// Threshold for the unscoped orphan pass. Far above any plausible `sessionTimeoutMinutes`, so a row it
// removes is dead under ANY session's configuration — which is what makes an unscoped sweep safe.
const ORPHAN_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

const MAX_SWEEP_TRACKED_SESSIONS = 1000;

export default class TypebotConnector implements IPlugin {
  private ctx: PluginContext | null = null;
  // Per WhatsApp session: the sweep itself is scoped to one session's rows, so a single global
  // throttle would let the first session to fire starve every other session's cleanup for an hour.
  private readonly lastSweepAt = new Map<string, number>();
  private lastOrphanSweepAt = 0;
  private orphanSweepInFlight = false;

  async onEnable(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;
    readConfig(ctx.config); // fail fast at enable time
    const lock = new KeyedAsyncLock();
    const store = new SessionStore(ctx.storage);

    ctx.registerHook('message:received', async (h: HookContext): Promise<HookResult> => {
      const sessionId = h.sessionId;
      const msg = h.data as IncomingMessage | undefined;
      if (sessionId && msg) {
        // Re-read config per event so a live edit is picked up; build the client with the resolved config.
        let cfg: TypebotConfig;
        try {
          cfg = readConfig(ctx.config);
        } catch (e) {
          ctx.logger.warn(
            `typebot-connector: skipping message, config invalid: ${e instanceof Error ? e.message : String(e)}`,
          );
          return { continue: true };
        }
        const client = new TypebotClient(ctx.net.fetch.bind(ctx.net), cfg);
        // Sweep rows left by contacts who walked away mid-flow. A finished flow clears its own row, so
        // these are the only ones that would otherwise accumulate for the life of the install — and the
        // host (before 0.26.0) stats every stored key on every write, so they tax each later turn. Floated: cleanup must
        // never delay a reply, and it is deliberately driven by traffic rather than a timer so a disabled
        // plugin leaves nothing running.
        const now = Date.now();
        // A reconnect replay does not sweep: the rows it would prune are the ones its own late replies
        // may still continue, since turn.ts judges idle from when a message was written.
        const sent = new Date((msg.timestamp ?? 0) * 1000);
        const late = sent.getTime() > 0 && now - sent.getTime() > LATE_AFTER_MS;
        if (!late && now - (this.lastSweepAt.get(sessionId) ?? 0) > SWEEP_INTERVAL_MS) {
          if (!this.lastSweepAt.has(sessionId) && this.lastSweepAt.size >= MAX_SWEEP_TRACKED_SESSIONS) {
            const oldest = this.lastSweepAt.keys().next().value;
            if (oldest !== undefined) this.lastSweepAt.delete(oldest);
          }
          this.lastSweepAt.delete(sessionId); // re-insert so eviction drops the least recently swept
          this.lastSweepAt.set(sessionId, now);
          void store
            .pruneIdle(now, cfg.sessionTimeoutMinutes * 60_000, sessionId)
            .then(n => n && ctx.logger.log(`typebot-connector: pruned ${n} abandoned session(s)`))
            .catch(e => ctx.logger.error('typebot-connector: session prune failed', e));
        }
        if (!late && !this.orphanSweepInFlight && now - this.lastOrphanSweepAt > SWEEP_INTERVAL_MS) {
          this.lastOrphanSweepAt = now;
          this.orphanSweepInFlight = true;
          void store
            .pruneOrphans(now, ORPHAN_IDLE_MS)
            .then(n => n && ctx.logger.log(`typebot-connector: pruned ${n} orphaned session row(s)`))
            .catch(e => ctx.logger.error('typebot-connector: orphan prune failed', e))
            .finally(() => {
              this.orphanSweepInFlight = false;
            });
        }
        // Off-dispatch: return immediately; a slow or failing Typebot call never blocks WA.
        void handleTurn(
          { cfg, client, store, lock, conversations: ctx.conversations, now: () => Date.now(), log: (m, e) => ctx.logger.error(m, e) },
          sessionId,
          h.source,
          msg,
        ).catch(e => ctx.logger.error('typebot turn failed', e));
        // Claim every chat this bot is in scope for. handleTurn re-checks the same predicate before doing
        // anything, so the two can never disagree. A Typebot outage therefore produces silence rather
        // than an unrelated plugin answering on this bot's behalf.
        return { continue: !inScope(msg, h.source, cfg.respondInGroups) };
      }
      return { continue: true };
    }, HOOK_PRIORITY);

    ctx.logger.log('typebot-connector enabled');
  }

  async onConfigChange(ctx: PluginContext): Promise<void> {
    readConfig(ctx.config);
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    if (!this.ctx) return { healthy: false, message: 'typebot-connector: not enabled' };
    try {
      const cfg = readConfig(this.ctx.config);
      return { healthy: true, message: `typebot-connector: ${cfg.publicId} (${cfg.apiHost})` };
    } catch (e) {
      return { healthy: false, message: e instanceof Error ? e.message : String(e) };
    }
  }
}
