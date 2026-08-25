/**
 * Group auto-translation extension plugin.
 *
 * Ports OpenWA's core `translation` module onto the v0.7 plugin capability surface: the
 * framework-agnostic `core/` (coordinator, parser, formatter, ports) is reused unchanged, with
 * `ChatGateway`/`ConfigStore` implemented over `ctx.messages`/`ctx.engine`/`ctx.storage`, and outbound
 * translate calls routed through `ctx.net.fetch`. Disabled until enabled via
 * `POST /plugins/group-translate/enable`.
 */
import type {
  PluginContext,
  IPlugin,
  HookContext,
  HookResult,
  IncomingMessage,
} from "../types/openwa";
import {
  TranslationCoordinator,
  CoordinatorOptions,
} from "./core/translation.coordinator";
import { InboundMessage, TranslationLogger } from "./core/ports";
import { LibreTranslateClient } from "./libretranslate.client";
import { PluginChatGateway } from "./plugin-chat.gateway";
import { PluginConfigStore } from "./plugin-config.store";

// Transformer band. This plugin claims only its own /tr admin commands — a control message addressed to
// the plugin, not conversational content. A translated message is never claimed and still reaches any
// responder registered after it.
const HOOK_PRIORITY = 50;

function readString(
  cfg: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const v = cfg[key];
  return typeof v === "string" && v.length > 0 ? v : fallback;
}
function readOptionalString(
  cfg: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = cfg[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
// The host clamps a net.fetch timeout of <= 0 up to 1 ms, so a config of 0 — which the schema's `min`
// only discourages, never enforces — made every translate abort instantly, and the coordinator swallowed
// the error with nothing logged. Clamp where it is actually enforceable: in code.
function readTimeoutMs(cfg: Record<string, unknown>): number {
  return Math.min(30_000, Math.max(500, readNumber(cfg, "timeoutMs", 4000)));
}

// The host resolves this plugin's outbound allowlist from the RAW config value, refuses the fetch at
// the capability boundary when it cannot use that value, and says nothing on this side. detect() then
// throws, the coordinator skips the message, and an unusable URL is indistinguishable from a group with
// nothing to translate. Name the problem where the value is read. The value itself is left alone:
// rewriting it here would change what this plugin calls without changing what the host admits.
//
// Deliberately NOT an https-only rule, even though the host admits a config-supplied host over https
// only. The shipped default is loopback over http, and a plain-http backend on a non-loopback host is a
// supported install (its host:port added to the manifest net.allow, then repackaged). A plugin cannot
// see its own effective allowlist, so it must not second-guess it.
function backendUrlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "is not a URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "is not an http(s) URL";
  }
  // A credentialed value is dropped from the config-derived allowlist outright, so a non-loopback
  // backend named this way is refused on every single call.
  if (parsed.username || parsed.password) return "carries embedded credentials";
  // The endpoint path is appended to this value, so a query or fragment lands in the middle of the
  // request path: "http://host/?lang=en" becomes "http://host/?lang=en/detect".
  if (parsed.search || parsed.hash) return "carries a query string or fragment";
  return null;
}

function readNumber(
  cfg: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const v = cfg[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function readBool(
  cfg: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const v = cfg[key];
  return typeof v === "boolean" ? v : fallback;
}

export class TranslationPlugin implements IPlugin {
  private coordinator: TranslationCoordinator | null = null;
  // Signature of the coordinator-affecting config last used to build `this.coordinator`. The hook
  // recomputes this per event and rebuilds the coordinator only when it changes — so a per-session
  // override (resolved by the host for the firing session) takes effect, WITHOUT resetting the
  // LibreTranslate client's circuit breaker on every message (a per-event rebuild would open/close the
  // backend anew on each call and defeat the breaker's purpose).
  private coordinatorSignature = "";

  onEnable(context: PluginContext): Promise<void> {
    this.coordinator = this.buildCoordinator(context);
    this.coordinatorSignature = this.configSignature(context.config);
    context.registerHook(
      "message:received",
      (ctx) => this.onMessage(context, ctx as HookContext<IncomingMessage>),
      HOOK_PRIORITY,
    );
    context.logger.log("Translation plugin enabled", {
      action: "translation_enabled",
    });
    return Promise.resolve();
  }

  onConfigChange(context: PluginContext): Promise<void> {
    // Rebuild the coordinator so a config edit (e.g. a new LibreTranslate URL/key saved from the
    // dashboard) takes effect immediately, without a disable/enable cycle.
    this.coordinator = this.buildCoordinator(context);
    this.coordinatorSignature = this.configSignature(context.config);
    context.logger.log("Translation plugin config updated", {
      action: "translation_config_changed",
    });
    return Promise.resolve();
  }

  /** Stable signature of only the config fields that affect the coordinator's behavior. Two configs
   *  with the same signature produce equivalent coordinators (same backend, same opts), so the circuit
   *  breaker state can be safely reused across them. */
  private configSignature(cfg: Record<string, unknown>): string {
    return JSON.stringify([
      readString(cfg, "libretranslateUrl", "http://localhost:7001"),
      readOptionalString(cfg, "libretranslateApiKey") ?? "",
      readTimeoutMs(cfg),
      readString(cfg, "commandPrefix", "/tr"),
      readNumber(cfg, "minLength", 2),
      readNumber(cfg, "maxLength", 2000),
      readBool(cfg, "denyReply", false),
      readBool(cfg, "announceInGroups", false),
    ]);
  }

  private buildCoordinator(context: PluginContext): TranslationCoordinator {
    const cfg = context.config;
    const logger: TranslationLogger = {
      debug: (m, meta) => context.logger.debug(m, meta),
      info: (m, meta) => context.logger.log(m, meta),
      warn: (m, meta) => context.logger.warn(m, meta),
    };
    const url = readString(cfg, "libretranslateUrl", "http://localhost:7001");
    const problem = backendUrlProblem(url);
    if (problem) {
      // Never the value itself: this is the one config field an operator may have put a password in.
      context.logger.warn(
        `libretranslateUrl ${problem}; every translate call will be refused`,
        { action: "translation_backend_url_invalid" },
      );
    }
    const translator = new LibreTranslateClient({
      url,
      apiKey: readOptionalString(cfg, "libretranslateApiKey"),
      timeoutMs: readTimeoutMs(cfg),
      net: context.net,
      logger,
    });
    const store = new PluginConfigStore(context.storage);
    const gateway = new PluginChatGateway(context.messages, context.engine);
    const opts: CoordinatorOptions = {
      prefix: readString(cfg, "commandPrefix", "/tr"),
      minLength: readNumber(cfg, "minLength", 2),
      maxLength: readNumber(cfg, "maxLength", 2000),
      denyReply: readBool(cfg, "denyReply", false),
      // Default false in the code as well as the manifest: an install that predates this field has no
      // stored value, and the safe reading of a missing opt-in is "not opted in".
      announceInGroups: readBool(cfg, "announceInGroups", false),
    };
    return new TranslationCoordinator(translator, store, gateway, opts, logger);
  }

  onDisable(context: PluginContext): Promise<void> {
    // The loader unregisters this plugin's hooks on disable; drop the coordinator too.
    this.coordinator = null;
    context.logger.log("Translation plugin disabled", {
      action: "translation_disabled",
    });
    return Promise.resolve();
  }

  private async onMessage(
    context: PluginContext,
    ctx: HookContext<IncomingMessage>,
  ): Promise<HookResult> {
    const msg = ctx.data;
    // Only act on engine-originated inbound messages for a known session. The bot's own sends are
    // `fromMe` and route through `message:sent`, so they never reach here (no translation loop).
    if (ctx.source !== "Engine" || !ctx.sessionId) {
      return { continue: true };
    }
    // Since host 0.23.2 a shared contact card arrives with its full vCard as the body. Translating one
    // POSTs a stranger's name and number to the translation backend, posts the machine-translated card
    // back into the group, and feeds the vCard to language detection, which pins the sender's learned
    // language on their first card. A poll is deliberately NOT denied here: its question is human-typed
    // prose and squarely inside what this plugin exists to translate.
    if (msg.type === "contact") {
      return { continue: true };
    }
    // Re-check the config signature against the firing session's resolved config — if a per-session
    // override changed a coordinator-affecting field, rebuild now. Cheap (a JSON.stringify of a handful
    // of primitives) and runs only the equality check on the hot path; the rebuild is rare. The swap is
    // not locked, but a translation call is short-lived (bounded by timeoutMs), so an in-flight call on
    // the old coordinator resolves independently; the new one serves subsequent messages.
    const sig = this.configSignature(context.config);
    if (sig !== this.coordinatorSignature || !this.coordinator) {
      this.coordinator = this.buildCoordinator(context);
      this.coordinatorSignature = sig;
    }
    if (!this.coordinator) return { continue: true };
    try {
      const inbound: InboundMessage = {
        id: msg.id,
        chatId: msg.chatId,
        body: msg.body,
        author: msg.author ?? "",
        isGroup: msg.isGroup,
        fromMe: msg.fromMe,
        mentionedIds: msg.mentionedIds ?? [],
        pushName: msg.contact?.pushName,
      };
      const { swallow } = await this.coordinator.handleMessage(
        ctx.sessionId,
        inbound,
      );
      return { continue: !swallow };
    } catch (error) {
      context.logger.error("Translation hook failed", error, {
        sessionId: ctx.sessionId,
        action: "translation_hook_error",
      });
      return { continue: true };
    }
  }
}

export default TranslationPlugin;
