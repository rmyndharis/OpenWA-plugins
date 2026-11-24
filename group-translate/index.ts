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

// From OpenWA 0.23.6 a Baileys session delivers, after it reconnects, what WhatsApp queued while it was
// disconnected, each message with its original send time. Five minutes is far above clock skew between
// WhatsApp and the gateway, and matches the host's own auto-reply age limit.
const LATE_AFTER_MS = 5 * 60_000;

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
  return Math.min(25_000, Math.max(500, readNumber(cfg, "timeoutMs", 4000)));
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

const MAX_COORDINATORS = 64;

interface CoordinatorSlot {
  sig: string;
  coordinator: TranslationCoordinator;
}

export class TranslationPlugin implements IPlugin {
  private baseSlot: CoordinatorSlot | null = null;
  private readonly sessionSlots = new Map<string, CoordinatorSlot>();
  private coordinator: TranslationCoordinator | null = null;
  // State writes must stay ordered when configuration replaces the coordinator.
  private readonly groupLocks = new Map<string, Promise<unknown>>();

  onEnable(context: PluginContext): Promise<void> {
    this.sessionSlots.clear();
    const base = { sig: this.configSignature(context.config), coordinator: this.buildCoordinator(context) };
    this.baseSlot = base;
    this.coordinator = base.coordinator;
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
    // Rebuild base coordinator and clear cached per-session overrides so edited config applies at once.
    this.sessionSlots.clear();
    const base = { sig: this.configSignature(context.config), coordinator: this.buildCoordinator(context) };
    this.baseSlot = base;
    this.coordinator = base.coordinator;
    context.logger.log("Translation plugin config updated", {
      action: "translation_config_changed",
    });
    return Promise.resolve();
  }

  private getOrCreateCoordinator(context: PluginContext, sessionId: string): TranslationCoordinator {
    const sig = this.configSignature(context.config);
    if (this.baseSlot && sig === this.baseSlot.sig) {
      this.sessionSlots.delete(sessionId);
      this.coordinator = this.baseSlot.coordinator;
      return this.baseSlot.coordinator;
    }
    const existing = this.sessionSlots.get(sessionId);
    if (existing && existing.sig === sig) {
      this.sessionSlots.delete(sessionId);
      this.sessionSlots.set(sessionId, existing);
      this.coordinator = existing.coordinator;
      return existing.coordinator;
    }
    const created: CoordinatorSlot = { sig, coordinator: this.buildCoordinator(context) };
    if (!existing && this.sessionSlots.size >= MAX_COORDINATORS) {
      const oldest = this.sessionSlots.keys().next().value;
      if (oldest !== undefined) this.sessionSlots.delete(oldest);
    }
    this.sessionSlots.delete(sessionId);
    this.sessionSlots.set(sessionId, created);
    this.coordinator = created.coordinator;
    return created.coordinator;
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
    return new TranslationCoordinator(translator, store, gateway, opts, logger, this.groupLocks);
  }

  onDisable(context: PluginContext): Promise<void> {
    // The loader unregisters this plugin's hooks on disable; drop cached coordinators too.
    this.sessionSlots.clear();
    this.baseSlot = null;
    this.coordinator = null;
    context.logger.log("Translation plugin disabled", {
      action: "translation_disabled",
    });
    return Promise.resolve();
  }

  onUnload(): Promise<void> {
    this.sessionSlots.clear();
    this.baseSlot = null;
    this.coordinator = null;
    return Promise.resolve();
  }

  private async onMessage(
    context: PluginContext,
    ctx: HookContext<IncomingMessage>,
  ): Promise<HookResult> {
    const msg = ctx.data;
    if (!msg || ctx.source !== "Engine" || !ctx.sessionId) {
      return { continue: true };
    }
    // Since host 0.23.2 a shared contact card arrives with its full vCard as the body. Translating one
    // POSTs a stranger's name and number to the translation backend, posts the machine-translated card
    // back into the group, and feeds the vCard to language detection, which pins the sender's learned
    // language on their first card. Since host 0.23.5 an order ('order') and a shared product card
    // ('product') are typed on both engines, and on Baileys carry a body too: the order note, else the
    // order or product title from the seller's catalog. A commerce message is not conversation, and
    // translating it posts a quote-reply into the group and lets detection learn the member's language
    // from the seller's wording. A poll is deliberately NOT denied here: its question is human-typed
    // prose and squarely inside what this plugin exists to translate.
    if (msg.type === "contact" || msg.type === "order" || msg.type === "product" || msg.type === "location") {
      return { continue: true };
    }
    // Resolve coordinator by per-session override (falling back to base slot when unmodified).
    const coordinator = this.getOrCreateCoordinator(context, ctx.sessionId);
    // `timestamp` is unix seconds; a missing, zero, negative or unrepresentable one reads as sent now.
    // Judged here, at arrival, so a wait in the coordinator's per-group lock is never counted.
    const sent = new Date((msg.timestamp ?? 0) * 1000);
    try {
      const inbound: InboundMessage = {
        id: msg.id,
        chatId: msg.chatId,
        body: msg.body,
        author: msg.author ?? "",
        isGroup: msg.isGroup,
        fromMe: msg.fromMe,
        isForwarded: msg.isForwarded === true,
        mentionedIds: msg.mentionedIds ?? [],
        pushName: msg.contact?.pushName,
        late: sent.getTime() > 0 && Date.now() - sent.getTime() > LATE_AFTER_MS,
      };
      const claimed = coordinator.isCommand(inbound);
      if (claimed || (inbound.isGroup && !inbound.fromMe && Boolean(inbound.author))) {
        const sessionId = ctx.sessionId;
        void coordinator.handleMessage(sessionId, inbound).catch((error) =>
          context.logger.error(
            claimed ? "Translation command failed" : "Translation hook failed",
            error,
            {
              sessionId,
              action: claimed ? "translation_command_error" : "translation_hook_error",
            },
          ),
        );
      }
      return { continue: !claimed };
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
