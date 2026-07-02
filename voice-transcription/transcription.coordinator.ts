import type { IncomingMessage } from '../types/openwa';
import type { SttProvider, SttResult } from './openai-stt.client.ts';
import type { TranscriptDelivery, TranscriptionPayload } from './webhook.delivery.ts';

/** Minimal KV surface the coordinator needs (adapted from `ctx.storage` by the plugin). */
export interface KvStore {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
}

export interface CoordinatorLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** Send the transcript into a WhatsApp chat (adapted from `ctx.messages`). */
export interface ChatSink {
  sendText(sessionId: string, chatId: string, text: string): Promise<unknown>;
  reply(sessionId: string, chatId: string, quotedMessageId: string, text: string): Promise<unknown>;
}

/** off = no chat message; self = note to the bot's own number; reply = quote-reply to the sender. */
export type ChatDeliveryMode = 'off' | 'self' | 'reply';

export interface TranscriptionConfig {
  /** Message types to transcribe, e.g. ['voice'] (PTT). */
  enabledMessageTypes: string[];
  /** Skip audio larger than this (decoded bytes) — the exact cost guard. */
  maxSizeBytes: number;
  /** Best-effort per-session hourly cap on transcriptions. */
  maxPerHour: number;
}

export interface CoordinatorDeps {
  provider: SttProvider;
  /** Webhook sink. Optional: omit for chat-only operation. */
  delivery?: TranscriptDelivery;
  /** Chat sink (used when chatDelivery !== 'off'). */
  chat?: ChatSink;
  chatDelivery: ChatDeliveryMode;
  store: KvStore;
  config: TranscriptionConfig;
  /** Label recorded in the delivered event, e.g. 'faster-whisper'. */
  providerLabel: string;
  model: string;
  logger: CoordinatorLogger;
  /** Injectable clock for the hourly rate-limit bucket (defaults to Date.now). */
  now?: () => number;
}

/**
 * The framework-agnostic core: decide whether to transcribe an inbound message, run the guards (type,
 * size, idempotency, rate limit), call STT, and report the outcome — a `completed` event with the
 * transcript, or a `failed`/`skipped` event explaining why. Fail-open throughout: never throws to the
 * caller, so a transcription failure can never disrupt message delivery.
 */
export class TranscriptionCoordinator {
  private readonly now: () => number;

  constructor(private readonly deps: CoordinatorDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  async handle(sessionId: string, msg: IncomingMessage): Promise<void> {
    const { config, store, logger } = this.deps;
    try {
      // Not our concern → no event at all.
      if (!config.enabledMessageTypes.includes(msg.type)) return;
      if (!msg.media) return;

      // Idempotency first, so every outcome (including skips) fires at most once per message id.
      // Best-effort: get-then-set is not atomic across a truly simultaneous #466 re-fire (documented).
      const seenKey = `seen:${sessionId}:${msg.id}`;
      if (await store.get(seenKey)) return;
      await store.set(seenKey, 1);

      const media = msg.media;
      if (media.omitted || !media.data) {
        await this.emit(sessionId, msg, { status: 'skipped', reason: 'media_unavailable' });
        return;
      }
      if (!media.mimetype || !media.mimetype.startsWith('audio/')) return; // defensive: not audio

      const audio = Buffer.from(media.data, 'base64');
      if (audio.byteLength > config.maxSizeBytes) {
        await this.emit(sessionId, msg, { status: 'skipped', reason: 'too_large' });
        return;
      }

      const rateKey = `rate:${sessionId}:${Math.floor(this.now() / 3_600_000)}`;
      const count = (await store.get<number>(rateKey)) ?? 0;
      if (count >= config.maxPerHour) {
        await this.emit(sessionId, msg, { status: 'skipped', reason: 'rate_limited' });
        return;
      }
      await store.set(rateKey, count + 1);

      let result: SttResult;
      try {
        result = await this.deps.provider.transcribe(audio, media.mimetype);
      } catch (err) {
        await this.emit(sessionId, msg, { status: 'failed', reason: err instanceof Error ? err.message : String(err) });
        return;
      }
      if (!result.text.trim()) {
        await this.emit(sessionId, msg, { status: 'skipped', reason: 'empty' });
        return;
      }

      await this.emit(sessionId, msg, {
        status: 'completed',
        text: result.text,
        transcription: {
          text: result.text,
          language: result.language,
          provider: this.deps.providerLabel,
          model: this.deps.model,
        },
      });
    } catch (err) {
      // Fail-open: a transcription/delivery failure must never disrupt message delivery.
      logger.warn('Transcription failed (skipped)', {
        messageId: msg.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async emit(
    sessionId: string,
    msg: IncomingMessage,
    o: {
      status: TranscriptionPayload['status'];
      reason?: string;
      text?: string;
      transcription?: NonNullable<TranscriptionPayload['transcription']>;
    },
  ): Promise<void> {
    if (o.status !== 'completed') {
      this.deps.logger.warn(`Transcription ${o.status}: ${o.reason}`, { messageId: msg.id });
    }
    const payload: TranscriptionPayload = {
      event: 'message.transcription',
      sessionId,
      messageId: msg.id,
      chatId: msg.chatId,
      status: o.status,
      source: 'speech-to-text',
      untrusted: true,
      ...(o.reason ? { reason: o.reason } : {}),
      ...(o.transcription ? { transcription: o.transcription } : {}),
    };
    // The webhook and in-chat deliveries are independent sinks — isolate the webhook so a failing
    // delivery endpoint can't swallow the in-chat transcript (and vice versa is unaffected: chat is last).
    if (this.deps.delivery) {
      try {
        await this.deps.delivery.deliver(payload);
      } catch (err) {
        this.deps.logger.warn('Transcript webhook delivery failed', {
          messageId: msg.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (o.status === 'completed' && o.text && this.deps.chat && this.deps.chatDelivery !== 'off') {
      if (this.deps.chatDelivery === 'self') await this.deps.chat.sendText(sessionId, msg.to, o.text);
      else await this.deps.chat.reply(sessionId, msg.chatId, msg.id, o.text);
    }
  }
}
