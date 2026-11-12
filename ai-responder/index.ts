import type { IPlugin, PluginContext, HookContext, HookResult, IncomingMessage } from '../types/openwa';
import { fetchChatCompletion, type ChatCompletionConfig } from './api-client.ts';
import { isBroadcastJid } from './jid.ts';
import { mdToWhatsApp } from './md-to-wa.ts';

declare const __PLUGIN_VERSION__: string;
const PLUGIN_VERSION = typeof __PLUGIN_VERSION__ !== 'undefined' ? __PLUGIN_VERSION__ : '0.0.0-dev';

export interface ResponderConfig extends ChatCompletionConfig {
  maxOutputTokens: number;
  timeoutMs: number;
  maxInputChars: number;
  maxRepliesPerChatPerHour: number;
  maxRepliesPerSessionPerHour: number;
  respondInGroups: boolean;
}

// Plain http is accepted only for a model on the gateway's own machine. Anywhere else it would carry the
// API key and every contact's message in clear text. `URL.hostname` keeps the brackets on IPv6.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// A whole number of at least 1, else the fallback. The host never enforces a configSchema bound.
function atLeastOne(raw: unknown, fallback: number): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

export function parseConfig(raw: Record<string, unknown>): ResponderConfig {
  // No code-side default for apiBaseUrl: the host admits the provider's host from the RAW config value,
  // so a default here would enable the plugin while every call is refused at the net gate. The manifest
  // default is seeded into the stored config, which is what the gate reads.
  const apiBaseUrl = String(raw.apiBaseUrl ?? '').trim();
  if (!apiBaseUrl) throw new Error('ai-responder: apiBaseUrl is required');
  let url: URL;
  try {
    url = new URL(apiBaseUrl);
  } catch {
    throw new Error('ai-responder: apiBaseUrl must be a valid URL');
  }
  const loopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if ((url.protocol !== 'https:' && !loopbackHttp) || url.username || url.password || url.search || url.hash) {
    throw new Error(
      'ai-responder: apiBaseUrl must be an https URL without embedded credentials, query string or fragment (http only for localhost, 127.0.0.1 or [::1])',
    );
  }

  const apiKey = String(raw.apiKey ?? '').trim();
  if (!apiKey) throw new Error('ai-responder: apiKey is required');
  const model = String(raw.model ?? 'gpt-4o-mini').trim();
  if (!model) throw new Error('ai-responder: model is required');

  return {
    apiBaseUrl,
    apiKey,
    model,
    systemPrompt: typeof raw.systemPrompt === 'string' ? raw.systemPrompt : undefined,
    maxOutputTokens: atLeastOne(raw.maxOutputTokens, 500),
    // Kept below the host's 30 s per-capability ceiling, so a slow provider surfaces as a fetch timeout
    // rather than a capability timeout. A blank value (the config API stores "" verbatim) reads as unset,
    // not as 0, which would clamp to one second and time out nearly every call.
    timeoutMs: Math.min(25000, Math.max(1000, atLeastOne(raw.timeoutMs, 15000))),
    maxInputChars: atLeastOne(raw.maxInputChars, 2000),
    maxRepliesPerChatPerHour: atLeastOne(raw.maxRepliesPerChatPerHour, 20),
    maxRepliesPerSessionPerHour: atLeastOne(raw.maxRepliesPerSessionPerHour, 200),
    respondInGroups: raw.respondInGroups === true,
  };
}

// Responder band, last: this plugin answers anything, so it runs after every more specific responder and
// after the after-hours away message (95), and only sees what none of them claimed.
const HOOK_PRIORITY = 97;

// A message sent longer ago than this is never answered. From OpenWA 0.23.6 a Baileys session delivers,
// after it reconnects, what WhatsApp queued while it was disconnected, each message with its original send
// time. Five minutes is far above clock skew between WhatsApp and the gateway and matches the host's own
// auto-reply age limit.
const LATE_AFTER_MS = 5 * 60_000;

// Recently claimed message ids remembered per session, so a redelivery is not answered twice. From 0.23.6
// the host drops most re-deliveries itself; this only has to cover a short burst.
const SEEN_PER_SESSION = 500;

const HOUR_MS = 60 * 60_000;

// Provider calls open at once. The host allows 16 concurrent `net.fetch` calls across every plugin and
// refuses the next one, and a model call can hold its slot for the whole timeout, so an unbounded burst
// would starve the other plugins' requests and fail its own excess calls after claiming them.
const MAX_IN_FLIGHT = 8;

// Cut to `max` UTF-16 code units without leaving half of a surrogate pair at the end.
function truncate(s: string, max: number): string {
  const cut = s.slice(0, max);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

export default class AIResponder implements IPlugin {
  // Held for healthCheck(), which the host calls with no context of its own.
  private ctx: PluginContext | null = null;
  // Rate limits, counted per clock hour and kept in memory only, so a restart or re-enable starts a fresh
  // window. All of it is dropped when the hour turns, which also keeps the maps bounded.
  private hour = -1;
  private readonly perChat = new Map<string, number>();
  private readonly perSession = new Map<string, number>();
  private readonly warned = new Set<string>();
  private inFlight = 0;
  /** sessionId -> recently claimed message ids, oldest first. */
  private readonly seen = new Map<string, Set<string>>();

  async onEnable(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;
    const cfg = parseConfig(ctx.config); // fail fast: a bad base config aborts enable
    ctx.registerHook('message:received', (hook: HookContext) => this.onMessage(ctx, hook), HOOK_PRIORITY);
    ctx.logger.log(`ai-responder v${PLUGIN_VERSION} enabled with model ${cfg.model}`);
  }

  async onConfigChange(ctx: PluginContext): Promise<void> {
    parseConfig(ctx.config); // re-validate on change (fail-fast feedback in the dashboard)
  }

  /** Reports on the BASE config: outside a hook the host resolves no per-session slice. */
  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    if (!this.ctx) return { healthy: false, message: 'ai-responder: not enabled' };
    try {
      return { healthy: true, message: `ai-responder v${PLUGIN_VERSION}: ${parseConfig(this.ctx.config).model}` };
    } catch (e) {
      return { healthy: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  // Synchronous: decides whether the message is this plugin's and floats the provider call, which can
  // take far longer than the host's 5 s hook budget. Every early exit means "not mine".
  private onMessage(ctx: PluginContext, hook: HookContext): HookResult {
    const pass = { continue: true };
    if (hook.source !== 'Engine' || !hook.sessionId) return pass;
    const m = (hook.data ?? {}) as Partial<IncomingMessage>;
    if (m.fromMe || m.isForwarded || typeof m.body !== 'string' || !m.body.trim() || !m.chatId || !m.id) return pass;
    // A contact card carries its vCard in the body, a poll its question, and from 0.23.5 a Baileys order
    // its note and a product card its title: text nobody typed at this bot, and a vCard would send a
    // contact's details to the provider. 'unknown' stays admitted, since business button and list
    // replies land there on whatsapp-web.js, and 'text' is not allowlisted, since media captions arrive
    // under their own media type.
    if (m.type === 'contact' || m.type === 'poll' || m.type === 'order' || m.type === 'product') return pass;
    // On whatsapp-web.js a shared location's body is its base64 map thumbnail (Baileys leaves it empty), so
    // it would reach the provider as a block of image data and draw a meaningless answer.
    if (m.type === 'location') return pass;

    // Re-parse per event so a per-session config override (resolved by the host for this hook fire) is
    // honored; a snapshot cached at enable would only ever see the base config.
    let cfg: ResponderConfig;
    try {
      cfg = parseConfig(ctx.config);
    } catch (e) {
      ctx.logger.warn(`ai-responder: skipping message, config invalid: ${e instanceof Error ? e.message : String(e)}`);
      return pass;
    }

    // An authorless group message cannot be attributed to a participant, so it is never answered.
    if (m.isGroup && (!cfg.respondInGroups || !m.author)) return pass;
    // `isGroup` cannot see a WhatsApp Channel: a `@newsletter` post arrives as a non-group chat, and a
    // reply would go to a chat this account can never post in. Broadcast lists are the same shape.
    if (isBroadcastJid(m.chatId)) return pass;
    // `timestamp` is unix seconds; a missing, zero, negative or unrepresentable one counts as sent now.
    const sent = new Date((m.timestamp ?? 0) * 1000);
    if (sent.getTime() > 0 && Date.now() - sent.getTime() > LATE_AFTER_MS) return pass;

    const sessionId = hook.sessionId;
    let seen = this.seen.get(sessionId);
    if (!seen) this.seen.set(sessionId, (seen = new Set()));
    // A redelivery of a message this plugin already claimed is still its own: claim it again, do nothing.
    if (seen.has(m.id)) return { continue: false };
    if (!this.withinLimits(ctx, cfg, sessionId, m.chatId)) return pass;
    seen.add(m.id);
    if (seen.size > SEEN_PER_SESSION) seen.delete(seen.values().next().value as string);

    const { chatId, id, body } = m;
    this.inFlight++;
    void this.answer(ctx, cfg, sessionId, chatId, id, body)
      .catch(e => ctx.logger.error(`ai-responder: reply to ${id} failed`, e))
      .finally(() => this.inFlight--);
    // Claimed before the outcome is known. A provider failure is logged and ends in silence rather than
    // in another plugin answering a message that was meant for this one.
    return { continue: false };
  }

  // Per-chat and per-session hourly limits, and the cap on open provider calls. Every claimed message
  // counts, answered or not: the provider call is what costs, and a timed-out call may still be billed. A
  // message over a limit is not claimed.
  private withinLimits(ctx: PluginContext, cfg: ResponderConfig, sessionId: string, chatId: string): boolean {
    const hour = Math.floor(Date.now() / HOUR_MS);
    if (hour !== this.hour) {
      this.hour = hour;
      this.perChat.clear();
      this.perSession.clear();
      this.warned.clear();
    }
    if (this.inFlight >= MAX_IN_FLIGHT) {
      if (!this.warned.has('busy')) {
        this.warned.add('busy');
        ctx.logger.warn(`ai-responder: ${MAX_IN_FLIGHT} provider calls already open, leaving new messages unanswered`);
      }
      return false;
    }
    const chatKey = `${sessionId}:${chatId}`;
    const chat = this.perChat.get(chatKey) ?? 0;
    const session = this.perSession.get(sessionId) ?? 0;
    if (chat >= cfg.maxRepliesPerChatPerHour || session >= cfg.maxRepliesPerSessionPerHour) {
      // Once per chat for its own limit, once per session for the session cap: keyed per chat, a session
      // over its cap would log a line for every new chat that writes in, and keep one set entry for each.
      const perChat = chat >= cfg.maxRepliesPerChatPerHour;
      const warnKey = perChat ? `chat ${chatKey}` : `session ${sessionId}`;
      if (!this.warned.has(warnKey)) {
        this.warned.add(warnKey);
        ctx.logger.warn(
          perChat
            ? `ai-responder: per-chat hourly limit reached, not answering ${chatId} until the hour turns`
            : `ai-responder: per-session hourly limit reached, not answering on ${sessionId} until the hour turns`,
        );
      }
      return false;
    }
    this.perChat.set(chatKey, chat + 1);
    this.perSession.set(sessionId, session + 1);
    return true;
  }

  // Single turn: only this message (and the system prompt) is sent, with no earlier conversation.
  private async answer(
    ctx: PluginContext,
    cfg: ResponderConfig,
    sessionId: string,
    chatId: string,
    messageId: string,
    body: string,
  ): Promise<void> {
    const text = await fetchChatCompletion(ctx.net.fetch.bind(ctx.net), cfg, truncate(body.trim(), cfg.maxInputChars));
    const formatted = mdToWhatsApp(text.trim()).trim();
    if (!formatted) throw new Error('AI API returned an empty reply after formatting');
    await ctx.messages.reply(sessionId, chatId, messageId, formatted);
  }
}
