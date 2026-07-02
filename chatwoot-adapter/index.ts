import type { IPlugin, PluginContext, IncomingMessage, HookContext, HookResult, WebhookRequest } from '../types/openwa';
import { ChatwootClient } from './chatwoot-client.ts';
import { MappingStore } from './mapping-store.ts';
import { KeyedAsyncLock } from './chat-lock.ts';
import { handleInbound } from './inbound.ts';
import { handleOutbound } from './outbound.ts';

interface ChatwootFullConfig {
  baseUrl: string;
  apiToken: string;
  accountId: number;
  inboxId: number;
  relayGroups: boolean;
  relayMedia: boolean;
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
  return { baseUrl, apiToken, accountId, inboxId, relayGroups: raw.relayGroups !== false, relayMedia: raw.relayMedia !== false };
}

export default class ChatwootAdapter implements IPlugin {
  async onEnable(ctx: PluginContext): Promise<void> {
    readConfig(ctx.config); // fail fast on the base config
    const lock = new KeyedAsyncLock();
    const store = new MappingStore(ctx.storage, ctx.mappings);
    // Re-read config per event so a per-session/instance override (PR E) is picked up live.
    const clientFor = () => new ChatwootClient(ctx.net.fetch.bind(ctx.net), readConfig(ctx.config));

    ctx.registerHook('message:received', async (h: HookContext): Promise<HookResult> => {
      const sessionId = h.sessionId;
      const msg = h.data as IncomingMessage;
      if (sessionId && msg) {
        const cfg = readConfig(ctx.config);
        // Fire-and-forget off the hook so a slow/failing Chatwoot API never blocks the WA pipeline. The
        // mapping mirror is keyed on sessionId (a session-scoped instance is 1:1 with its session).
        void handleInbound(
          {
            lock,
            client: clientFor(),
            store,
            instanceId: sessionId,
            relayGroups: cfg.relayGroups,
            relayMedia: cfg.relayMedia,
            log: (m, e) => ctx.logger.error(m, e),
          },
          sessionId,
          h.source,
          msg,
        ).catch(e => ctx.logger.error('inbound hook failed', e));
      }
      return { continue: true };
    });

    ctx.registerWebhook('chatwoot', async (req: WebhookRequest) =>
      handleOutbound(
        {
          lock,
          conversations: ctx.conversations,
          handover: ctx.handover,
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
