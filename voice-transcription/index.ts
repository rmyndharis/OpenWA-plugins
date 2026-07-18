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
function readChatDelivery(cfg: Record<string, unknown>): ChatDeliveryMode {
  const v = cfg["chatDelivery"];
  return v === "self" || v === "reply" ? v : "off";
}

export class VoiceTranscriptionPlugin implements IPlugin {
  private coordinator: TranscriptionCoordinator | null = null;
  private ctxRef: PluginContext | null = null;
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
    context.registerHook("message:received", (ctx) =>
      Promise.resolve(this.onMessage(ctx as HookContext<IncomingMessage>)),
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
      readNumber(cfg, "timeoutMs", 20000),
      readString(cfg, "deliveryWebhookUrl", ""),
      readOptionalString(cfg, "deliverySecret") ?? "",
      readNumber(cfg, "deliveryTimeoutMs", 5000),
      readChatDelivery(cfg),
      JSON.stringify(readStringArray(cfg, "enabledMessageTypes", ["voice"])),
      readNumber(cfg, "maxSizeBytes", 16 * 1024 * 1024),
      readNumber(cfg, "maxPerHour", 60),
      readString(cfg, "provider", "faster-whisper"),
    ]);
  }

  onDisable(context: PluginContext): Promise<void> {
    this.coordinator = null;
    context.logger.log("Voice transcription plugin disabled", {
      action: "transcription_disabled",
    });
    return Promise.resolve();
  }

  private build(context: PluginContext): TranscriptionCoordinator {
    const cfg = context.config;
    const provider = new OpenAiSttClient({
      baseUrl: readString(cfg, "sttBaseUrl", ""),
      apiKey: readOptionalString(cfg, "sttApiKey"),
      model: readString(cfg, "model", "small"),
      language: readOptionalString(cfg, "language"),
      timeoutMs: readNumber(cfg, "timeoutMs", 20000),
      net: context.net,
    });
    const deliveryUrl = readString(cfg, "deliveryWebhookUrl", "");
    const delivery = deliveryUrl
      ? new WebhookDelivery({
          url: deliveryUrl,
          secret: readOptionalString(cfg, "deliverySecret"),
          timeoutMs: readNumber(cfg, "deliveryTimeoutMs", 5000),
          net: context.net,
        })
      : undefined;
    const store: KvStore = {
      get: (key) => context.storage.get(key),
      set: (key, value) => context.storage.set(key, value),
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
