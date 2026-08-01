import type { IPlugin, PluginContext, IncomingMessage, HookContext, HookResult, WebhookRequest } from '../types/openwa';
import { ChatwootClient } from './chatwoot-client.ts';
import { MappingStore, SEEN_TTL_MS, SEEN_PRUNE_INTERVAL_MS } from './mapping-store.ts';
import { KeyedAsyncLock } from './chat-lock.ts';
import { handleInbound, relayInbound, MAX_BACKFILL_ATTEMPTS } from './inbound.ts';
import { handleSent } from './sent.ts';
import { backfillAllChats } from './backfill.ts';
import { handleOutbound } from './outbound.ts';
import { drainRetries, RETRY_INTERVAL_MS, MAX_RETRY_ATTEMPTS, MAX_PENDING_RETRIES } from './retry.ts';

// Observer band. Must run before any responder: a responder returning {continue:false} ends the chain,
// and at the default priority of 100 this plugin would simply stop seeing claimed messages.
const HOOK_PRIORITY = 20;

interface ChatwootFullConfig {
  baseUrl: string;
  apiToken: string;
  accountId: number;
  inboxId: number;
  relayGroups: boolean;
  relayMedia: boolean;
  relayOwnMessages: boolean;
  backfillLimit: number;
  backfillAllOnce: boolean;
}

function readConfig(raw: Record<string, unknown>): ChatwootFullConfig {
  const baseUrl = String(raw.baseUrl ?? '');
  const apiToken = String(raw.apiToken ?? '');
  const accountId = Number(raw.accountId);
  const inboxId = Number(raw.inboxId);
  const missing = [
    !baseUrl && 'baseUrl',
    !apiToken && 'apiToken',
    !Number.isFinite(accountId) && 'accountId',
    !Number.isFinite(inboxId) && 'inboxId',
  ].filter(Boolean);
  if (missing.length) throw new Error(`chatwoot-adapter: missing/invalid config: ${missing.join(', ')}`);
  // Fail fast at enable time: the host's config-derived net allowlist only admits an https, credential-free
  // baseUrl, so an http/private/credentialed value would otherwise pass here yet make every inbound relay
  // silently fail per-message with the plugin still reporting healthy.
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('chatwoot-adapter: baseUrl must be a valid URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('chatwoot-adapter: baseUrl must be an https URL without embedded credentials');
  }
  const rawLimit = Number(raw.backfillLimit);
  return {
    baseUrl,
    apiToken,
    accountId,
    inboxId,
    relayGroups: raw.relayGroups !== false,
    relayMedia: raw.relayMedia !== false,
    relayOwnMessages: raw.relayOwnMessages !== false,
    backfillLimit: Number.isFinite(rawLimit) ? Math.max(0, Math.trunc(rawLimit)) : 0,
    backfillAllOnce: raw.backfillAllOnce === true || raw.backfillAllOnce === 'true',
  };
}

export default class ChatwootAdapter implements IPlugin {
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private store: MappingStore | null = null;
  private deadLetterCount = 0;
  // Inbound messages that could neither be relayed nor queued — actual data loss, almost always the host
  // rejecting a write because the plugin is at its storage quota. Counted separately from dead-lettering:
  // a dead letter was at least retried MAX_RETRY_ATTEMPTS times, this one never got a single attempt.
  private lostCount = 0;
  // Chats whose history import burned MAX_BACKFILL_ATTEMPTS. In-memory like the other health counters:
  // the durable state that actually stops the retries lives on each chat's mapping document.
  private backfillExhausted = new Set<string>();
  private draining = false;
  private lastSeenPruneAt = 0;
  private seenPruning = false;

  private onBackfillExhausted = (chatId: string): void => {
    this.backfillExhausted.add(chatId);
  };

  async onEnable(ctx: PluginContext): Promise<void> {
    this.clearRetryTimer(); // idempotent re-enable: never leak a timer from a prior enable
    readConfig(ctx.config); // fail fast on the base config
    const lock = new KeyedAsyncLock();
    const store = new MappingStore(ctx.storage, ctx.mappings);
    this.store = store;
    // Re-read config per event so a per-session/instance override (PR E) is picked up live.
    const clientFor = () => new ChatwootClient(ctx.net.fetch.bind(ctx.net), readConfig(ctx.config));

    // Shared per-event dependency bag for the inbound and own-send relays (both render into Chatwoot the
    // same way). instanceId = sessionId (a session-scoped instance is 1:1 with its session).
    const buildDeps = (cfg: ChatwootFullConfig, sessionId: string) => ({
      lock,
      client: clientFor(),
      store,
      engine: ctx.engine,
      instanceId: sessionId,
      relayGroups: cfg.relayGroups,
      relayMedia: cfg.relayMedia,
      backfillLimit: cfg.backfillLimit,
      backfillAllOnce: cfg.backfillAllOnce,
      log: (m: string, e?: unknown) => ctx.logger.error(m, e),
      onInboundLost: (msgId: string, e: unknown) => {
        this.lostCount++;
        ctx.logger.error(`inbound message ${msgId} LOST: could not be relayed and could not be queued`, e);
      },
      onBackfillExhausted: this.onBackfillExhausted,
    });

    ctx.registerHook(
      'message:received',
      async (h: HookContext): Promise<HookResult> => {
        const sessionId = h.sessionId;
        const msg = h.data as IncomingMessage;
        if (sessionId && msg) {
          const cfg = readConfig(ctx.config);
          const deps = buildDeps(cfg, sessionId);
          // Fire-and-forget off the hook so a slow/failing Chatwoot API never blocks the WA pipeline. The
          // mapping mirror is keyed on sessionId (a session-scoped instance is 1:1 with its session).
          void handleInbound(deps, sessionId, h.source, msg).catch(e => ctx.logger.error('inbound hook failed', e));
          // Opt-in one-time bulk history sweep. Fired off the hook (outside handleInbound's per-chat lock),
          // guarded internally so it runs once per session; a no-op after the first sweep completes.
          if (cfg.backfillAllOnce && cfg.backfillLimit > 0) {
            void backfillAllChats(deps, sessionId).catch(e => ctx.logger.error('bulk backfill failed', e));
          }
        }
        return { continue: true }; // observer: never claims, see PLUGIN-STANDARD.md
      },
      HOOK_PRIORITY,
    );

    // The account's OWN outbound sends (linked phone / WhatsApp app / OpenWA REST API) arrive on
    // message:sent, not message:received. Relay them as 'outgoing' so the Chatwoot thread mirrors the full
    // WhatsApp conversation (#615). The adapter's own Chatwoot-agent replies also surface here but are
    // echo-suppressed inside handleSent. Gated per-event so a live relayOwnMessages flip applies at once.
    ctx.registerHook(
      'message:sent',
      async (h: HookContext): Promise<HookResult> => {
        const sessionId = h.sessionId;
        const msg = h.data as IncomingMessage;
        if (sessionId && msg) {
          const cfg = readConfig(ctx.config);
          if (cfg.relayOwnMessages) {
            void handleSent(buildDeps(cfg, sessionId), sessionId, h.source, msg).catch(e =>
              ctx.logger.error('sent hook failed', e),
            );
          }
        }
        return { continue: true }; // observer: never claims, see PLUGIN-STANDARD.md
      },
      HOOK_PRIORITY,
    );

    ctx.registerWebhook('chatwoot', async (req: WebhookRequest) =>
      handleOutbound(
        {
          lock,
          conversations: ctx.conversations,
          handover: ctx.handover,
          engine: ctx.engine,
          store,
          inboxId: readConfig(ctx.config).inboxId,
          log: (m, e) => ctx.logger.error(m, e),
        },
        req,
      ),
    );

    // Retry failed inbound relays (at-least-once). The durable, storage-backed queue is drained on a timer:
    // each queued message is re-posted via the same inbound path, and a message that keeps failing is
    // dead-lettered after MAX_RETRY_ATTEMPTS. Retries use the base config (per-session overrides aren't
    // re-resolved outside a hook). .unref() so the timer never keeps the worker alive; cleared on disable.
    const drain = (): Promise<void> => {
      // Single-flight: a slow drain (large backlog) must not overlap the next tick, or two runs would
      // snapshot the same entries and double-post. Skip the tick if a drain is still in progress.
      if (this.draining) return Promise.resolve();
      // Skip entirely if the config is currently invalid (e.g. apiToken cleared): every relay would throw
      // on readConfig and walk the whole queue to dead-letter within a few ticks. Wait for valid config.
      try {
        readConfig(ctx.config);
      } catch {
        return Promise.resolve();
      }
      this.draining = true;
      return drainRetries(
        { store, lock, log: (m, e) => ctx.logger.error(m, e) },
        (sessionId, _chatId, msg) =>
          relayInbound(buildDeps(readConfig(ctx.config), sessionId), sessionId, msg, { recoverOn404: false }),
        MAX_RETRY_ATTEMPTS,
      )
        .then(
          ({ deadLettered }) => void (this.deadLetterCount += deadLettered),
          e => ctx.logger.error('retry drain failed', e),
        )
        .finally(() => void (this.draining = false));
    };
    // Bound the `seen:` de-dup markers: hourly, expire any past the retention window. Piggybacks this same
    // timer (no second timer), independent of the drain's single-flight so a slow prune never blocks a
    // retry. Runs regardless of config validity — it neither reads config nor relays. lastSeenPruneAt = 0
    // so the first prune (and the one-time legacy adopt) fires on the first tick after enable. Best-effort:
    // a failure is logged and retried next tick that is due.
    const maybePruneSeen = (): void => {
      if (this.seenPruning) return;
      const now = Date.now();
      if (now - this.lastSeenPruneAt < SEEN_PRUNE_INTERVAL_MS) return;
      this.lastSeenPruneAt = now;
      this.seenPruning = true;
      void store
        .pruneSeen(now, SEEN_TTL_MS)
        .then(({ pruned, adopted }) => {
          if (pruned || adopted) {
            ctx.logger.log(`chatwoot-adapter: pruned ${pruned} expired seen-marker(s), adopted ${adopted} legacy`);
          }
        })
        .catch(e => ctx.logger.error('seen-marker prune failed', e))
        .finally(() => void (this.seenPruning = false));
    };

    this.retryTimer = setInterval(() => {
      void drain();
      maybePruneSeen();
    }, RETRY_INTERVAL_MS);
    this.retryTimer.unref?.();

    ctx.logger.log('chatwoot-adapter enabled');
  }

  async onDisable(): Promise<void> {
    this.clearRetryTimer();
  }

  async onUnload(): Promise<void> {
    this.clearRetryTimer();
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  // Surface the retry backlog + permanent failures in the dashboard's plugin health. A saturated queue is
  // unhealthy: at capacity, every new failure drops the oldest pending message (active data loss).
  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    const pending = this.store ? await this.store.countRetries() : 0;
    const saturated = pending >= MAX_PENDING_RETRIES;
    const parts: string[] = [];
    if (pending > 0) parts.push(`${pending} inbound message(s) pending retry${saturated ? ' — queue full, dropping oldest' : ''}`);
    if (this.deadLetterCount > 0) parts.push(`${this.deadLetterCount} dead-lettered after ${MAX_RETRY_ATTEMPTS} attempts`);
    // Listed last but the most serious: these never reached the queue at all, so `pending` cannot show them.
    if (this.lostCount > 0) parts.push(`${this.lostCount} LOST (could not be queued — check the plugin storage quota)`);
    // Not unhealthy on its own: the live relay is unaffected and the operator may simply have chats the
    // engine cannot serve history for. It still has to be visible — the alternative is what this whole
    // change exists to remove, a permanent gap nobody is told about.
    if (this.backfillExhausted.size > 0) {
      parts.push(`${this.backfillExhausted.size} chat(s) gave up on history import after ${MAX_BACKFILL_ATTEMPTS} attempts`);
    }
    return {
      healthy: this.deadLetterCount === 0 && this.lostCount === 0 && !saturated,
      message: parts.join('; ') || undefined,
    };
  }
}
