import type { IPlugin, PluginContext, IncomingMessage, HookContext, HookResult } from '../types/openwa';
import type { TypebotConfig } from './typebot-types.ts';
import { KeyedAsyncLock } from './chat-lock.ts';
import { SessionStore } from './session-store.ts';
import { TypebotClient } from './typebot-client.ts';
import { handleTurn } from './turn.ts';

// Read + validate config. Fail-fast on a bad apiHost so a misconfigured plugin never silently no-ops (the
// host net allowlist only admits an https, credential-free host).
export function readConfig(raw: Record<string, unknown>): TypebotConfig {
  const apiHost = String(raw.apiHost ?? 'https://typebot.io').trim();
  const publicId = String(raw.publicId ?? '').trim();
  if (!publicId) throw new Error('typebot-connector: publicId is required');
  let parsed: URL;
  try {
    parsed = new URL(apiHost);
  } catch {
    throw new Error('typebot-connector: apiHost must be a valid URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('typebot-connector: apiHost must be an https URL without embedded credentials');
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

export default class TypebotConnector implements IPlugin {
  async onEnable(ctx: PluginContext): Promise<void> {
    readConfig(ctx.config); // fail fast at enable time
    const lock = new KeyedAsyncLock();
    const store = new SessionStore(ctx.storage);

    ctx.registerHook('message:received', async (h: HookContext): Promise<HookResult> => {
      const sessionId = h.sessionId;
      const msg = h.data as IncomingMessage | undefined;
      if (sessionId && msg) {
        // Re-read config per event so a live edit is picked up; build the client with the resolved config.
        const cfg = readConfig(ctx.config);
        const client = new TypebotClient(ctx.net.fetch.bind(ctx.net), cfg);
        // Off-dispatch: return {continue:true} immediately; a slow/failing Typebot call never blocks WA.
        void handleTurn(
          { cfg, client, store, lock, conversations: ctx.conversations, now: () => Date.now(), log: (m, e) => ctx.logger.error(m, e) },
          sessionId,
          h.source,
          msg,
        ).catch(e => ctx.logger.error('typebot turn failed', e));
      }
      return { continue: true };
    });

    ctx.logger.log('typebot-connector enabled');
  }
}
