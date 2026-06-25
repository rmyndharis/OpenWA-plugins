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
import type { PluginContext, IPlugin, HookContext, HookResult, IncomingMessage } from '../types/openwa';
import { OpenAiSttClient } from './openai-stt.client.ts';
import { WebhookDelivery } from './webhook.delivery.ts';
import { TranscriptionCoordinator, KvStore, ChatDeliveryMode } from './transcription.coordinator.ts';

function readString(cfg: Record<string, unknown>, key: string, fallback: string): string {
  const v = cfg[key];
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}
function readOptionalString(cfg: Record<string, unknown>, key: string): string | undefined {
  const v = cfg[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function readNumber(cfg: Record<string, unknown>, key: string, fallback: number): number {
  const v = cfg[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function readStringArray(cfg: Record<string, unknown>, key: string, fallback: string[]): string[] {
  const v = cfg[key];
  return Array.isArray(v) && v.every(x => typeof x === 'string') && v.length > 0 ? (v as string[]) : fallback;
}
function readChatDelivery(cfg: Record<string, unknown>): ChatDeliveryMode {
  const v = cfg['chatDelivery'];
  return v === 'self' || v === 'reply' ? v : 'off';
}

export class VoiceTranscriptionPlugin implements IPlugin {
  private coordinator: TranscriptionCoordinator | null = null;

  onEnable(context: PluginContext): Promise<void> {
    this.coordinator = this.build(context);
    context.registerHook('message:received', ctx =>
      Promise.resolve(this.onMessage(ctx as HookContext<IncomingMessage>)),
    );
    if (!readOptionalString(context.config, 'deliveryWebhookUrl') && readChatDelivery(context.config) === 'off') {
      context.logger.warn(
        'voice-transcription: no delivery configured — set deliveryWebhookUrl or chatDelivery, else transcripts have nowhere to go',
        { action: 'transcription_no_delivery' },
      );
    }
    context.logger.log('Voice transcription plugin enabled', { action: 'transcription_enabled' });
    return Promise.resolve();
  }

  onConfigChange(context: PluginContext): Promise<void> {
    // Rebuild so an edited config (new STT URL/key, delivery URL) applies without a disable/enable cycle.
    this.coordinator = this.build(context);
    context.logger.log('Voice transcription config updated', { action: 'transcription_config_changed' });
    return Promise.resolve();
  }

  onDisable(context: PluginContext): Promise<void> {
    this.coordinator = null;
    context.logger.log('Voice transcription plugin disabled', { action: 'transcription_disabled' });
    return Promise.resolve();
  }

  private build(context: PluginContext): TranscriptionCoordinator {
    const cfg = context.config;
    const provider = new OpenAiSttClient({
      baseUrl: readString(cfg, 'sttBaseUrl', ''),
      apiKey: readOptionalString(cfg, 'sttApiKey'),
      model: readString(cfg, 'model', 'small'),
      language: readOptionalString(cfg, 'language'),
      timeoutMs: readNumber(cfg, 'timeoutMs', 20000),
      net: context.net,
    });
    const deliveryUrl = readString(cfg, 'deliveryWebhookUrl', '');
    const delivery = deliveryUrl
      ? new WebhookDelivery({
          url: deliveryUrl,
          secret: readOptionalString(cfg, 'deliverySecret'),
          timeoutMs: readNumber(cfg, 'deliveryTimeoutMs', 5000),
          net: context.net,
        })
      : undefined;
    const store: KvStore = {
      get: key => context.storage.get(key),
      set: (key, value) => context.storage.set(key, value),
    };
    return new TranscriptionCoordinator({
      provider,
      delivery,
      chat: context.messages, // ChatSink — only used when chatDelivery !== 'off'
      chatDelivery: readChatDelivery(cfg),
      store,
      config: {
        enabledMessageTypes: readStringArray(cfg, 'enabledMessageTypes', ['voice']),
        maxSizeBytes: readNumber(cfg, 'maxSizeBytes', 16 * 1024 * 1024),
        maxPerHour: readNumber(cfg, 'maxPerHour', 60),
      },
      providerLabel: readString(cfg, 'provider', 'faster-whisper'),
      model: readString(cfg, 'model', 'small'),
      logger: { warn: (m, meta) => context.logger.warn(m, meta) },
    });
  }

  /**
   * Synchronous hook body: return `{ continue: true }` immediately and run transcription off the
   * critical path. The coordinator is fail-open, so the floated promise needs no rejection handling.
   */
  private onMessage(ctx: HookContext<IncomingMessage>): HookResult {
    if (this.coordinator && ctx.source === 'Engine' && ctx.sessionId) {
      void this.coordinator.handle(ctx.sessionId, ctx.data);
    }
    return { continue: true };
  }
}

export default VoiceTranscriptionPlugin;
