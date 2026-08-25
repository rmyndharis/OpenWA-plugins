import type {
  IPlugin, PluginContext, HookContext, HookResult, IncomingMessage, ConversationSendEnvelope,
} from '../types/openwa';
import { readConfig, type HttpActionConfig } from './config.ts';
import { phoneFromJid } from './jid.ts';
import { matchAction } from './matcher.ts';
import { renderText, type TemplateContext } from './url-template.ts';
import { HttpActionClient, type FetchLike } from './client.ts';
import { hasSeen, markSeen, prune, allowCooldown, type StorageLike, DEDUP_TTL_MS, PRUNE_INTERVAL_MS } from './reliability.ts';

const PLUGIN = 'http-action';
const REPLY_MAX = 4000;
const DEFAULT_NOT_FOUND = 'Not found.';
const DEFAULT_ERROR = 'Service is temporarily unavailable. Please try again later.';

// Responder band, first: a command prefix is the most specific trigger any of these plugins has, so a
// message addressed to it should never also be answered by a keyword bot or a flow.
const HOOK_PRIORITY = 70;

/** Dependencies handleMessage needs, injected so the per-message logic tests without OpenWA. */
export interface HandleDeps {
  cfg: HttpActionConfig;
  fetch: FetchLike;
  conversations: { send(env: ConversationSendEnvelope): Promise<unknown> };
  storage: StorageLike;
  cooldown: Map<string, number>;
  now: () => number;
  // `warn` mirrors the host's PluginLogger: the second argument is structured META, not an Error —
  // passing an Error there renders as `{}`. Errors go to `error`, which does accept one.
  logger: { log(m: string): void; warn(m: string, meta?: Record<string, unknown>): void; error(m: string, e?: unknown): void };
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
  // In a group `msg.from` is the GROUP jid, so `author` is the only real sender. Using `from` made
  // `{{sender.id}}` resolve to the group for every member — a per-user lookup or an authorization check
  // written against it silently applied to the group instead.
  const senderJid = msg.author ?? msg.from;
  return {
    args,
    message: { id: msg.id, body: msg.body },
    chat: { id: msg.chatId },
    sender: {
      id: senderJid,
      // The host assigns `senderPhone` only AFTER the message:received chain has run, and only for @lid
      // senders, so at hook time it is always unset — `{{sender.phone}}` was empty for every sender on
      // both engines. Keep reading it first in case that ordering ever changes, then fall back to the
      // digits of the JID, which for a plain @c.us chat IS the number.
      phone: msg.senderPhone ?? phoneFromJid(senderJid),
      name: msg.contact?.pushName ?? msg.contact?.name ?? '',
    },
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
  const dedupFailed = (e: unknown) =>
    deps.logger.warn(`${PLUGIN}: dedup read failed, dropping message ${msg.id} unanswered`,
      { error: e instanceof Error ? e.message : String(e) });
  if (await hasSeen(deps.storage, sessionId, msg.id, dedupFailed)) return;
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
    deps.logger.error(`${PLUGIN}: request failed`, e);
    // Same hazard as the empty-reply fallback below: renderText can throw on a bad template, and an
    // unguarded throw here would replace an upstream failure the operator can see with silence.
    try {
      text = renderText(action.errorTemplate ?? DEFAULT_ERROR, ctxWith());
    } catch (tplErr) {
      deps.logger.warn(`${PLUGIN}: action '${action.id}' errorTemplate failed to render`,
        { error: tplErr instanceof Error ? tplErr.message : String(tplErr) });
      text = DEFAULT_ERROR;
    }
  }

  // A template referencing a field the response does not carry renders to '', and an empty envelope is
  // sent as an empty WhatsApp bubble — the host coerces `text` and never rejects it. Substitute the
  // error template and say so: an empty render is a template bug the operator has to see.
  let reply = truncate(sanitize(text));
  if (!reply.trim()) {
    deps.logger.warn(`${PLUGIN}: action '${action.id}' rendered an empty reply; sent the error template instead`);
    // renderText can THROW (a too-deep path, a prototype key, too many placeholders). Before this
    // fallback existed an empty bubble was still sent and the message was marked seen; letting the
    // fallback throw would instead reject out of handleMessage, sending nothing at all.
    try {
      reply = truncate(sanitize(renderText(action.errorTemplate ?? DEFAULT_ERROR, ctxWith()))).trim() || DEFAULT_ERROR;
    } catch (e) {
      deps.logger.warn(`${PLUGIN}: action '${action.id}' errorTemplate failed to render`,
        { error: e instanceof Error ? e.message : String(e) });
      reply = DEFAULT_ERROR;
    }
  }

  // replyTo is safe here — replies are always text (media is a non-goal). See §1.4.
  // A send rejection propagates out of handleMessage (to the hook's .catch) BEFORE markSeen runs, so the
  // message stays un-marked and a redelivery retries — no silently-dropped reply.
  await deps.conversations.send({
    sessionId, chatId: msg.chatId, type: 'text', text: reply, replyTo: msg.id,
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
      if (typeof msg.body !== 'string' || !msg.body.trim()) return { continue: true };
      if (!msg.chatId || !msg.id) return { continue: true };
      // Since host 0.23.2 a poll arrives with its question as the body and a contact card with its
      // vCard, so a non-empty body no longer means someone typed a command. This plugin performs real
      // writes against the operator's backend, so an accidental trigger is the most expensive one in
      // the catalog: a poll titled with a configured prefix would fire a GET or POST and claim the
      // message. 'unknown' stays admitted; a tapped business button is a legitimate way to invoke an
      // action.
      if (msg.type === 'contact' || msg.type === 'poll') return { continue: true };

      // Re-read config per event so a live dashboard edit is picked up without re-enable.
      let liveCfg: HttpActionConfig;
      try {
        liveCfg = readConfig(ctx.config);
      } catch (e) {
        ctx.logger.warn(`${PLUGIN}: skipping message, config invalid: ${(e as Error).message}`);
        return { continue: true };
      }
      if (msg.isGroup && !liveCfg.respondInGroups) return { continue: true };

      // Decide ownership SYNCHRONOUSLY, before floating the request. The work runs off-dispatch to stay
      // inside the ~5 s hook budget, so the outcome is not knowable here — but whether the message is
      // addressed to this plugin is, and that is what a claim means (see PLUGIN-STANDARD.md).
      // handleMessage resolves the trigger with this same call (:75), so the claim and the reply can
      // never disagree about which messages belong to this plugin.
      const mine = matchAction(liveCfg.actions, msg.body) !== null;

      // Off-dispatch (§1.2 #2): return synchronously and float handleMessage, so a slow or blocked
      // upstream never stalls the WA hook.
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
      return { continue: !mine };
    }, HOOK_PRIORITY);

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
