/**
 * Voice-note transcription extension.
 *
 * Registers on `message:received`, and for inbound voice notes runs speech-to-text OFF the dispatch
 * critical path: the hook returns `{ continue: true }` synchronously and the STT call + delivery run as
 * a deliberately un-awaited promise, so a slow transcription never blocks (or delays) message delivery.
 * The transcript is delivered out-of-band as a `message.transcription` event POSTed to a configurable
 * webhook — never echoed back into the contact's chat. Disabled until enabled via
 * `POST /plugins/voice-transcription/enable`.
 */
import type {
  PluginContext,
  IPlugin,
  HookContext,
  HookResult,
  IncomingMessage,
} from "../types/openwa";
import { OpenAiSttClient } from "./openai-stt.client.ts";
import { WebhookDelivery } from "./webhook.delivery.ts";
import {
  TranscriptionCoordinator,
  KvStore,
  ChatDeliveryMode,
} from "./transcription.coordinator.ts";

// Transformer band: runs after the observers, before any responder. This plugin delivers a transcript
// out-of-band and must never claim — the contact's message still needs whatever bot would answer it.
const HOOK_PRIORITY = 40;

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
// The host never validates configSchema bounds, so the manifest `max` is advisory only. Clamp where
// it is enforceable: a stored value above the host's 30s per-capability ceiling would make the cap
// timer and the fetch abort race, reporting an STT timeout as a capability timeout.
function readTimeoutMs(cfg: Record<string, unknown>): number {
  return Math.min(25000, Math.max(1000, readNumber(cfg, "timeoutMs", 20000)));
}

// Same reasoning, same ceiling, for the delivery webhook. Unclamped, the manifest's advertised 30000
// maximum expired together with the host's 30s per-capability budget, so a slow receiver surfaced as a
// capability timeout rather than a delivery timeout: the exact misdiagnosis 1.1.0 fixed for timeoutMs.
// A 0 or negative value was worse: plugin-net clamps it to 1ms, so every delivery aborted instantly,
// swallowed into a warn line.
function readDeliveryTimeoutMs(cfg: Record<string, unknown>): number {
  return Math.min(25000, Math.max(1000, readNumber(cfg, "deliveryTimeoutMs", 5000)));
}

function readNumber(
  cfg: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const v = cfg[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function readStringArray(
  cfg: Record<string, unknown>,
  key: string,
  fallback: string[],
): string[] {
  const v = cfg[key];
  return Array.isArray(v) &&
    v.every((x) => typeof x === "string") &&
    v.length > 0
    ? (v as string[])
    : fallback;
}
// The host resolves this plugin's outbound allowlist from the RAW config value and refuses the fetch at
// the capability boundary when it cannot use that value, saying nothing on this side. Both failures then
// look like silence: a transcription that never happens, or a transcript that never arrives. Name the
// problem where the value is read.
//
// Deliberately NOT an https-only rule. The shipped default STT backend is a self-hosted Speaches on
// loopback over http, which is a first-class supported install, and a plugin cannot see its own
// effective allowlist. The value itself is never rewritten and never logged: `deliveryWebhookUrl` is one
// an operator may have put a token in.
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
  // A credentialed value is dropped from the config-derived allowlist outright, so a non-loopback host
  // named this way is refused on every call.
  if (parsed.username || parsed.password) return "carries embedded credentials";
  return null;
}

function readChatDelivery(cfg: Record<string, unknown>): ChatDeliveryMode {
  const v = cfg["chatDelivery"];
  return v === "self" || v === "reply" ? v : "off";
}

export class VoiceTranscriptionPlugin implements IPlugin {
  private coordinator: TranscriptionCoordinator | null = null;
  private ctxRef: PluginContext | null = null;
  // Held for healthCheck. The client already tracks whether its circuit breaker is open; nothing was
  // asking it outside a test, so an open breaker, a missing backend and an unusable URL were all a
  // single warn line while the dashboard reported the plugin healthy.
  private provider: OpenAiSttClient | null = null;
  // Signature of the coordinator-affecting config last used to build `this.coordinator`. The hook
  // recomputes this per event and rebuilds the coordinator only when it changes — so a per-session
  // override (resolved by the host for the firing session) takes effect, WITHOUT resetting the STT
  // provider's circuit breaker on every message (a per-event rebuild would open/close the backend anew
  // on each call and defeat the breaker's purpose).
  private coordinatorSignature = "";

  onEnable(context: PluginContext): Promise<void> {
    this.ctxRef = context;
    this.coordinator = this.build(context);
    this.coordinatorSignature = this.configSignature(context.config);
    context.registerHook(
      "message:received",
      (ctx) => Promise.resolve(this.onMessage(ctx as HookContext<IncomingMessage>)),
      HOOK_PRIORITY,
    );
    if (
      !readOptionalString(context.config, "deliveryWebhookUrl") &&
      readChatDelivery(context.config) === "off"
    ) {
      context.logger.warn(
        "voice-transcription: no delivery configured — set deliveryWebhookUrl or chatDelivery, else transcripts have nowhere to go",
        { action: "transcription_no_delivery" },
      );
    }
    // The host never enforces a configSchema `required` field, so the plugin enables cleanly with no STT
    // backend and then fails every transcription with a net-allow error that reads like a misconfigured
    // allowlist rather than a missing setting. Warn instead of throwing: this runs off the message path,
    // is fail-open by design, and onEnable now also runs unattended at host boot.
    if (!readOptionalString(context.config, "sttBaseUrl")) {
      context.logger.warn(
        "voice-transcription: sttBaseUrl is not set — every transcription will fail until it is configured",
        { action: "transcription_no_backend" },
      );
    } else {
      const problem = backendUrlProblem(readString(context.config, "sttBaseUrl", ""));
      if (problem) {
        context.logger.warn(
          `voice-transcription: sttBaseUrl ${problem}; every transcription will be refused`,
          { action: "transcription_backend_url_invalid" },
        );
      }
    }
    const deliveryUrl = readOptionalString(context.config, "deliveryWebhookUrl");
    if (deliveryUrl) {
      const problem = backendUrlProblem(deliveryUrl);
      if (problem) {
        context.logger.warn(
          `voice-transcription: deliveryWebhookUrl ${problem}; every delivery will be refused`,
          { action: "transcription_delivery_url_invalid" },
        );
      }
    }
    context.logger.log("Voice transcription plugin enabled", {
      action: "transcription_enabled",
    });
    return Promise.resolve();
  }

  onConfigChange(context: PluginContext): Promise<void> {
    this.ctxRef = context;
    // Rebuild so an edited config (new STT URL/key, delivery URL) applies without a disable/enable cycle.
    this.coordinator = this.build(context);
    this.coordinatorSignature = this.configSignature(context.config);
    context.logger.log("Voice transcription config updated", {
      action: "transcription_config_changed",
    });
    return Promise.resolve();
  }

  /** Stable signature of only the config fields that affect the coordinator's behavior. Two configs
   *  with the same signature produce equivalent coordinators (same backend, same delivery, same guards),
   *  so the STT provider's circuit breaker state can be safely reused across them. */
  private configSignature(cfg: Record<string, unknown>): string {
    return JSON.stringify([
      readString(cfg, "sttBaseUrl", ""),
      readOptionalString(cfg, "sttApiKey") ?? "",
      readString(cfg, "model", "small"),
      readOptionalString(cfg, "language") ?? "",
      readTimeoutMs(cfg),
      readString(cfg, "deliveryWebhookUrl", ""),
      readOptionalString(cfg, "deliverySecret") ?? "",
      readDeliveryTimeoutMs(cfg),
      readChatDelivery(cfg),
      JSON.stringify(readStringArray(cfg, "enabledMessageTypes", ["voice"])),
      readNumber(cfg, "maxSizeBytes", 16 * 1024 * 1024),
      readNumber(cfg, "maxPerHour", 60),
      readString(cfg, "provider", "faster-whisper"),
    ]);
  }

  /**
   * The host answers `healthy: true` for a plugin that implements no health check, so every failure this
   * plugin has is fail-open and logged: an open circuit breaker, a missing or unusable backend URL, and
   * a delivery webhook that aborts every time all left the dashboard green while nothing was transcribed.
   * Reports on the BASE config, since outside a hook the host resolves no per-session slice.
   */
  healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    if (!this.ctxRef || !this.coordinator) {
      return Promise.resolve({ healthy: false, message: "voice-transcription: not enabled" });
    }
    const cfg = this.ctxRef.config;
    const stt = readOptionalString(cfg, "sttBaseUrl");
    if (!stt) {
      return Promise.resolve({ healthy: false, message: "voice-transcription: sttBaseUrl is not set" });
    }
    const sttProblem = backendUrlProblem(stt);
    if (sttProblem) {
      return Promise.resolve({ healthy: false, message: `voice-transcription: sttBaseUrl ${sttProblem}` });
    }
    const deliveryUrl = readOptionalString(cfg, "deliveryWebhookUrl");
    const deliveryProblem = deliveryUrl ? backendUrlProblem(deliveryUrl) : null;
    if (deliveryProblem) {
      return Promise.resolve({
        healthy: false,
        message: `voice-transcription: deliveryWebhookUrl ${deliveryProblem}`,
      });
    }
    if (!deliveryUrl && readChatDelivery(cfg) === "off") {
      return Promise.resolve({
        healthy: false,
        message: "voice-transcription: no delivery configured, transcripts have nowhere to go",
      });
    }
    if (this.provider && !this.provider.isHealthy()) {
      return Promise.resolve({
        healthy: false,
        message: "voice-transcription: STT circuit breaker is open, the backend is failing",
      });
    }
    return Promise.resolve({ healthy: true, message: `voice-transcription: ${readString(cfg, "model", "small")}` });
  }

  onDisable(context: PluginContext): Promise<void> {
    this.coordinator = null;
    this.provider = null;
    context.logger.log("Voice transcription plugin disabled", {
      action: "transcription_disabled",
    });
    return Promise.resolve();
  }

  private build(context: PluginContext): TranscriptionCoordinator {
    const cfg = context.config;
    const provider = (this.provider = new OpenAiSttClient({
      baseUrl: readString(cfg, "sttBaseUrl", ""),
      apiKey: readOptionalString(cfg, "sttApiKey"),
      model: readString(cfg, "model", "small"),
      language: readOptionalString(cfg, "language"),
      timeoutMs: readTimeoutMs(cfg),
      net: context.net,
    }));
    const deliveryUrl = readString(cfg, "deliveryWebhookUrl", "");
    const delivery = deliveryUrl
      ? new WebhookDelivery({
          url: deliveryUrl,
          secret: readOptionalString(cfg, "deliverySecret"),
          timeoutMs: readDeliveryTimeoutMs(cfg),
          net: context.net,
        })
      : undefined;
    const store: KvStore = {
      get: (key) => context.storage.get(key),
      set: (key, value) => context.storage.set(key, value),
      delete: (key) => context.storage.delete(key),
      list: (prefix) => context.storage.list(prefix),
    };
    return new TranscriptionCoordinator({
      provider,
      delivery,
      chat: context.messages, // ChatSink — only used when chatDelivery !== 'off'
      chatDelivery: readChatDelivery(cfg),
      store,
      config: {
        enabledMessageTypes: readStringArray(cfg, "enabledMessageTypes", [
          "voice",
        ]),
        maxSizeBytes: readNumber(cfg, "maxSizeBytes", 16 * 1024 * 1024),
        maxPerHour: readNumber(cfg, "maxPerHour", 60),
      },
      providerLabel: readString(cfg, "provider", "faster-whisper"),
      model: readString(cfg, "model", "small"),
      logger: { warn: (m, meta) => context.logger.warn(m, meta) },
    });
  }

  /**
   * Synchronous hook body: return `{ continue: true }` immediately and run transcription off the
   * critical path. The coordinator is fail-open, so the floated promise needs no rejection handling.
   */
  private onMessage(ctx: HookContext<IncomingMessage>): HookResult {
    if (ctx.source === "Engine" && ctx.sessionId) {
      // Re-check the config signature against the firing session's resolved config — if a per-session
      // override changed a coordinator-affecting field, rebuild now. Cheap (a JSON.stringify of a handful
      // of primitives) and the rebuild is rare. The swap is not locked, but a transcription call runs
      // off the critical path as an un-awaited promise, so an in-flight call on the old coordinator
      // resolves independently; the new one serves subsequent messages.
      const context = this.ctxRef;
      if (context) {
        const sig = this.configSignature(context.config);
        if (sig !== this.coordinatorSignature || !this.coordinator) {
          this.coordinator = this.build(context);
          this.coordinatorSignature = sig;
        }
      }
      if (this.coordinator) {
        void this.coordinator.handle(ctx.sessionId, ctx.data);
      }
    }
    return { continue: true };
  }
}

export default VoiceTranscriptionPlugin;
