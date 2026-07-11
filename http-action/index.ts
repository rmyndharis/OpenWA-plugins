import type {
  IPlugin, PluginContext, HookContext, HookResult, IncomingMessage, ConversationSendEnvelope,
} from '../types/openwa';
import { readConfig, type HttpActionConfig } from './config.ts';
import { matchAction } from './matcher.ts';
import { renderText, type TemplateContext } from './url-template.ts';
import { HttpActionClient, type FetchLike } from './client.ts';
import { hasSeen, markSeen, prune, allowCooldown, type StorageLike, DEDUP_TTL_MS, PRUNE_INTERVAL_MS } from './reliability.ts';

const PLUGIN = 'http-action';
const REPLY_MAX = 4000;
const DEFAULT_NOT_FOUND = 'Data tidak ditemukan.';
const DEFAULT_ERROR = 'Layanan sedang bermasalah. Coba lagi nanti.';

/** Dependencies handleMessage needs, injected so the per-message logic tests without OpenWA. */
export interface HandleDeps {
  cfg: HttpActionConfig;
  fetch: FetchLike;
  conversations: { send(env: ConversationSendEnvelope): Promise<unknown> };
  storage: StorageLike;
  cooldown: Map<string, number>;
  now: () => number;
  logger: { log(m: string): void; warn(m: string, e?: unknown): void; error(m: string, e?: unknown): void };
}

/** Strip C0 control chars (except \n, \t) so an attacker-influenced upstream value can't smuggle them into the reply. */
function sanitize(s: string): string {
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

/** Truncate to REPLY_MAX code units without splitting a UTF-16 surrogate pair. */
function truncate(s: string): string {
  if (s.length <= REPLY_MAX) return s;
  let cut = REPLY_MAX - 1;
  if (cut > 0) {
    const code = s.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // last included char is a high surrogate → back off
  }
  return `${s.slice(0, cut)}…`;
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
 * Per-message work: match → dedup CHECK (fail-closed) → cooldown (fail-open) → fetch → map status →
 * render → send → mark seen. The dedup MARK is written only after a successful send, so a transient send
 * failure retries on redelivery instead of being silently dropped (mirrors chatwoot's hasSeen/markSeen).
 */
export async function handleMessage(deps: HandleDeps, sessionId: string, msg: IncomingMessage): Promise<void> {
  const hit = matchAction(deps.cfg.actions, msg.body);
  if (!hit) return; // no trigger matched → silent

  // Dedup CHECK (read-only, fail-closed): drop a redelivery of an already-processed message id.
  if (await hasSeen(deps.storage, sessionId, msg.id)) return;
  // Best-effort prune of expired markers (throttled hourly); never blocks the reply.
  void prune(deps.storage, deps.now(), DEDUP_TTL_MS, PRUNE_INTERVAL_MS).catch((e) =>
    deps.logger.error(`${PLUGIN}: prune failed`, e),
  );
  // Cooldown (fail-open): one reply per chat per window. Checked before the mark so a blocked message
  // consumes nothing and a later message (after the window) still goes through.
  const cooldownMs = Math.max(0, deps.cfg.cooldownSeconds) * 1000;
  if (!allowCooldown(deps.cooldown, `${sessionId}:${msg.chatId}`, deps.now(), cooldownMs)) return;

  const { action, args } = hit;
  const client = new HttpActionClient(deps.fetch, deps.cfg);
  const ctxWith = (response?: unknown): TemplateContext => buildCtx(msg, sessionId, args, response);

  let text: string;
  try {
    const out = await client.run(action, ctxWith());
    if (out.status === 404) {
      text = renderText(action.notFoundTemplate ?? DEFAULT_NOT_FOUND, ctxWith(out.data));
    } else if (out.status >= 200 && out.status < 300) {
      text = renderText(action.replyTemplate, ctxWith(out.data));
    } else {
      text = renderText(action.errorTemplate ?? DEFAULT_ERROR, ctxWith(out.data));
    }
  } catch (e) {
    text = renderText(action.errorTemplate ?? DEFAULT_ERROR, ctxWith());
    deps.logger.error(`${PLUGIN}: request failed`, e);
  }

  // replyTo is safe here — replies are always text (media is a non-goal). See §1.4.
  // A send rejection propagates out of handleMessage (to the hook's .catch) BEFORE markSeen runs, so the
  // message stays un-marked and a redelivery retries — no silently-dropped reply.
  await deps.conversations.send({
    sessionId, chatId: msg.chatId, type: 'text', text: truncate(sanitize(text)), replyTo: msg.id,
  });
  await markSeen(deps.storage, sessionId, msg.id, deps.now());
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
    const cooldown = new Map<string, number>(); // per-chat cooldown, lives for the enabled lifetime

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
        {
          cfg: liveCfg,
          fetch: ctx.net.fetch.bind(ctx.net),
          conversations: ctx.conversations,
          storage: ctx.storage,
          cooldown,
          now: () => Date.now(),
          logger: ctx.logger,
        },
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
