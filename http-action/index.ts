import type {
  IPlugin, PluginContext, HookContext, HookResult, IncomingMessage, ConversationSendEnvelope,
} from '../types/openwa';
import { readConfig, type HttpActionConfig } from './config.ts';
import { matchAction } from './matcher.ts';
import { renderText, type TemplateContext } from './url-template.ts';
import { HttpActionClient, type FetchLike } from './client.ts';

const PLUGIN = 'http-action';
const REPLY_MAX = 4000;
const DEFAULT_NOT_FOUND = 'Data tidak ditemukan.';
const DEFAULT_ERROR = 'Layanan sedang bermasalah. Coba lagi nanti.';

/** Dependencies handleMessage needs, injected so the per-message logic tests without OpenWA. */
export interface HandleDeps {
  cfg: HttpActionConfig;
  fetch: FetchLike;
  conversations: { send(env: ConversationSendEnvelope): Promise<unknown> };
  logger: { log(m: string): void; warn(m: string, e?: unknown): void; error(m: string, e?: unknown): void };
}

function truncate(s: string): string {
  return s.length > REPLY_MAX ? `${s.slice(0, REPLY_MAX - 1)}…` : s;
}

function buildCtx(msg: IncomingMessage, sessionId: string, args: string[], response?: unknown): TemplateContext {
  return {
    args,
    message: { id: msg.id, body: msg.body },
    chat: { id: msg.chatId },
    sender: { id: msg.from, phone: msg.senderPhone ?? '', name: msg.contact?.pushName ?? msg.contact?.name ?? '' },
    session: { id: sessionId },
    response,
  };
}

/**
 * Per-message work: match → fetch (fixed origin) → map status → render → send. Pure modulo the injected
 * deps. Roadmap §4.7 #4–#7. (#8 dedup/cooldown lands next; until then a redelivery re-fires.)
 */
export async function handleMessage(deps: HandleDeps, sessionId: string, msg: IncomingMessage): Promise<void> {
  const hit = matchAction(deps.cfg.actions, msg.body);
  if (!hit) return; // no trigger matched → silent

  const { action, args } = hit;
  const client = new HttpActionClient(deps.fetch, deps.cfg);
  const baseCtx = () => buildCtx(msg, sessionId, args);

  let text: string;
  try {
    const out = await client.run(action, baseCtx());
    if (out.status === 404) {
      text = renderText(action.notFoundTemplate ?? DEFAULT_NOT_FOUND, baseCtx());
    } else if (out.status >= 200 && out.status < 300) {
      text = renderText(action.replyTemplate, buildCtx(msg, sessionId, args, out.data));
    } else {
      text = renderText(action.errorTemplate ?? DEFAULT_ERROR, baseCtx());
    }
  } catch (e) {
    text = renderText(action.errorTemplate ?? DEFAULT_ERROR, baseCtx());
    deps.logger.warn(`${PLUGIN}: request failed`, e);
  }

  // replyTo is safe here — replies are always text (media is a non-goal). See §1.4.
  await deps.conversations.send({
    sessionId, chatId: msg.chatId, type: 'text', text: truncate(text), replyTo: msg.id,
  });
}

/**
 * HTTP Action Bot — trigger a safe REST request from a WhatsApp command and render the JSON response
 * back to chat. One request per message, one reply. Roadmap §4.
 */
export default class HttpActionPlugin implements IPlugin {
  private ctx: PluginContext | null = null;

  async onEnable(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;
    const cfg = readConfig(ctx.config); // fail-fast: a bad config aborts enable

    ctx.registerHook('message:received', async (h: HookContext): Promise<HookResult> => {
      const sessionId = h.sessionId;
      const msg = h.data as IncomingMessage | undefined;
      if (!sessionId || !msg) return { continue: true };
      if (msg.fromMe) return { continue: true };
      if (typeof msg.body !== 'string' || msg.body.length === 0) return { continue: true };
      if (!msg.chatId || !msg.id) return { continue: true };

      // Re-read config per event so a live dashboard edit is picked up without re-enable.
      let liveCfg: HttpActionConfig;
      try {
        liveCfg = readConfig(ctx.config);
      } catch (e) {
        ctx.logger.warn(`${PLUGIN}: skipping message, config invalid: ${(e as Error).message}`);
        return { continue: true };
      }
      if (msg.isGroup && !liveCfg.respondInGroups) return { continue: true };

      // Off-dispatch (§1.2 #2): return {continue:true} synchronously and float handleMessage, so a slow
      // or blocked upstream never stalls the WA hook (the ~5s host hook budget is sync-return only).
      void handleMessage(
        { cfg: liveCfg, fetch: ctx.net.fetch.bind(ctx.net), conversations: ctx.conversations, logger: ctx.logger },
        sessionId,
        msg,
      ).catch((e) => ctx.logger.error(`${PLUGIN}: handler failed`, e));
      return { continue: true };
    });

    ctx.logger.log(`${PLUGIN} enabled (${cfg.actions.length} action(s), ${cfg.baseUrl})`);
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    if (!this.ctx) return { healthy: false, message: `${PLUGIN}: not loaded` };
    try {
      const cfg = readConfig(this.ctx.config);
      return { healthy: true, message: `${PLUGIN}: ${cfg.actions.length} action(s), baseUrl ${cfg.baseUrl}` };
    } catch (e) {
      return { healthy: false, message: (e as Error).message };
    }
  }
}
