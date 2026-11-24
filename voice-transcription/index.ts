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
function backendUrlProblem(url: string, allowQuery = true): string | null {
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
  if (!allowQuery && (parsed.search || parsed.hash)) {
    return "must not include a query string or fragment";
  }
  return null;
}

function readChatDelivery(cfg: Record<string, unknown>): ChatDeliveryMode {
  const v = cfg["chatDelivery"];
  return v === "self" || v === "reply" ? v : "off";
}

const MAX_SLOTS = 64;

interface CoordinatorSlot {
  sig: string;
  coordinator: TranscriptionCoordinator;
  provider: OpenAiSttClient;
}

export class VoiceTranscriptionPlugin implements IPlugin {
  private baseSlot: CoordinatorSlot | null = null;
  private readonly sessionSlots = new Map<string, CoordinatorSlot>();
  private coordinator: TranscriptionCoordinator | null = null;
  private ctxRef: PluginContext | null = null;

  onEnable(context: PluginContext): Promise<void> {
    this.ctxRef = context;
    this.sessionSlots.clear();
    const base = this.buildSlot(context);
    this.baseSlot = base;
    this.coordinator = base.coordinator;
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
      const problem = backendUrlProblem(readString(context.config, "sttBaseUrl", ""), false);
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
    // Rebuild base slot and drop cached per-session overrides so edited config applies immediately.
    this.sessionSlots.clear();
    const base = this.buildSlot(context);
    this.baseSlot = base;
    this.coordinator = base.coordinator;
    context.logger.log("Voice transcription config updated", {
      action: "transcription_config_changed",
    });
    return Promise.resolve();
  }

  private buildSlot(context: PluginContext): CoordinatorSlot {
    return { sig: this.configSignature(context.config), ...this.build(context) };
  }

  private getOrCreateSlot(context: PluginContext, sessionId: string): CoordinatorSlot {
    const sig = this.configSignature(context.config);
    if (this.baseSlot && sig === this.baseSlot.sig) {
      this.sessionSlots.delete(sessionId);
      this.coordinator = this.baseSlot.coordinator;
      return this.baseSlot;
    }
    const existing = this.sessionSlots.get(sessionId);
    if (existing && existing.sig === sig) {
      this.sessionSlots.delete(sessionId);
      this.sessionSlots.set(sessionId, existing);
      this.coordinator = existing.coordinator;
      return existing;
    }
    const created: CoordinatorSlot = { sig, ...this.build(context) };
    if (!existing && this.sessionSlots.size >= MAX_SLOTS) {
      const oldest = this.sessionSlots.keys().next().value;
      if (oldest !== undefined) this.sessionSlots.delete(oldest);
    }
    this.sessionSlots.delete(sessionId);
    this.sessionSlots.set(sessionId, created);
    this.coordinator = created.coordinator;
    return created;
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
    if (!this.ctxRef || !this.baseSlot) {
      return Promise.resolve({ healthy: false, message: "voice-transcription: not enabled" });
    }
    const cfg = this.ctxRef.config;
    const stt = readOptionalString(cfg, "sttBaseUrl");
    if (!stt) {
      return Promise.resolve({ healthy: false, message: "voice-transcription: sttBaseUrl is not set" });
    }
    const sttProblem = backendUrlProblem(stt, false);
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
    if (!this.baseSlot.provider.isHealthy()) {
      return Promise.resolve({
        healthy: false,
        message: "voice-transcription: STT circuit breaker is open, the backend is failing",
      });
    }
    for (const slot of this.sessionSlots.values()) {
      if (!slot.provider.isHealthy()) {
        return Promise.resolve({
          healthy: false,
          message: "voice-transcription: STT circuit breaker is open, the backend is failing",
        });
      }
    }
    return Promise.resolve({ healthy: true, message: `voice-transcription: ${readString(cfg, "model", "small")}` });
  }

  onDisable(context: PluginContext): Promise<void> {
    this.sessionSlots.clear();
    this.baseSlot = null;
    this.coordinator = null;
    context.logger.log("Voice transcription plugin disabled", {
      action: "transcription_disabled",
    });
    return Promise.resolve();
  }

  onUnload(): Promise<void> {
    this.sessionSlots.clear();
    this.baseSlot = null;
    this.coordinator = null;
    return Promise.resolve();
  }

  private build(context: PluginContext): { coordinator: TranscriptionCoordinator; provider: OpenAiSttClient } {
    const cfg = context.config;
    const provider = new OpenAiSttClient({
      baseUrl: readString(cfg, "sttBaseUrl", ""),
      apiKey: readOptionalString(cfg, "sttApiKey"),
      model: readString(cfg, "model", "small"),
      language: readOptionalString(cfg, "language"),
      timeoutMs: readTimeoutMs(cfg),
      net: context.net,
    });
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
    return {
      coordinator: new TranscriptionCoordinator({
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
      }),
      provider,
    };
  }

  /**
   * Synchronous hook body: return `{ continue: true }` immediately and run transcription off the
   * critical path. The coordinator is fail-open, so the floated promise needs no rejection handling.
   */
  private onMessage(ctx: HookContext<IncomingMessage>): HookResult {
    if (ctx.source === "Engine" && ctx.sessionId && ctx.data) {
      // Cache coordinator + breaker per resolved session config signature (bounded LRU) so alternating
      // per-session overrides do not reset each session's STT circuit breaker.
      const context = this.ctxRef;
      if (context) {
        const slot = this.getOrCreateSlot(context, ctx.sessionId);
        void slot.coordinator.handle(ctx.sessionId, ctx.data);
      }
    }
    return { continue: true };
  }
}

export default VoiceTranscriptionPlugin;
