import type { IPlugin, PluginContext, IncomingMessage, HookContext, HookResult, WebhookRequest } from '../types/openwa';
import { ChatwootClient } from './chatwoot-client.ts';
import { MappingStore } from './mapping-store.ts';
import { KeyedAsyncLock } from './chat-lock.ts';
import { handleInbound } from './inbound.ts';
import { handleSent } from './sent.ts';
import { backfillAllChats } from './backfill.ts';
import { handleOutbound } from './outbound.ts';

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
  async onEnable(ctx: PluginContext): Promise<void> {
    readConfig(ctx.config); // fail fast on the base config
    const lock = new KeyedAsyncLock();
    const store = new MappingStore(ctx.storage, ctx.mappings);
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
    });

    ctx.registerHook('message:received', async (h: HookContext): Promise<HookResult> => {
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
      return { continue: true };
    });

    // The account's OWN outbound sends (linked phone / WhatsApp app / OpenWA REST API) arrive on
    // message:sent, not message:received. Relay them as 'outgoing' so the Chatwoot thread mirrors the full
    // WhatsApp conversation (#615). The adapter's own Chatwoot-agent replies also surface here but are
    // echo-suppressed inside handleSent. Gated per-event so a live relayOwnMessages flip applies at once.
    ctx.registerHook('message:sent', async (h: HookContext): Promise<HookResult> => {
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
      return { continue: true };
    });

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

    ctx.logger.log('chatwoot-adapter enabled');
  }
}
