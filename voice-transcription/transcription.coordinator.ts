import type { IncomingMessage } from '../types/openwa';
import type { SttProvider, SttResult } from './openai-stt.client.ts';
import type { TranscriptDelivery, TranscriptionPayload } from './webhook.delivery.ts';

/** Minimal KV surface the coordinator needs (adapted from `ctx.storage` by the plugin). */
export interface KvStore {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

// How many recent message ids the per-session dedup list keeps. The host re-stats every one of a
// plugin's storage keys on EVERY write, so the pre-1.1.0 scheme — one key per transcribed voice note,
// never deleted — made each write more expensive than the last, forever. One bounded list per session
// costs the same single read + write it always did, and the key count is now O(sessions).
// 500 ids covers eight hours at the default 60/hour cap, far longer than any redelivery window.
const SEEN_HISTORY = 500;

// Legacy `seen:<sessionId>:<messageId>` keys are swept a few at a time (see sweepLegacySeen) rather than
// all at once: an upgraded install may hold thousands, and onEnable now runs unattended at host boot,
// before sessions connect, where a long delete loop would burn the lifecycle budget for nothing.
const LEGACY_SWEEP_PER_RUN = 25;

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

/**
 * Decoded byte length of a base64 string, without decoding it. Exact for well-formed base64; a value
 * containing whitespace over-counts, which fails safe (the audio is skipped as too large rather than
 * being decoded into the worker heap).
 */
export function decodedBase64Size(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor(b64.length / 4) * 3 - pad;
}

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
  // Sessions whose pre-1.1.0 dedup keys are fully drained, so the sweep's directory listing is not
  // repeated for the rest of this coordinator's life. A fresh install lands here on its first message.
  private readonly legacySweptSessions = new Set<string>();
  // Sessions that looked clean once. See sweepLegacySeen: one empty listing is not proof.
  private readonly legacySweepCleanOnce = new Set<string>();

  // Per-session tail for the dedup claim (see handle). Only the claim is serialized — the STT call and
  // delivery stay concurrent, so a slow transcription never blocks the next note's dedup.
  private readonly claimTails = new Map<string, Promise<unknown>>();

  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.claimTails.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.claimTails.set(key, next);
    void next.catch(() => undefined).finally(() => {
      if (this.claimTails.get(key) === next) this.claimTails.delete(key);
    });
    return next;
  }

  constructor(private readonly deps: CoordinatorDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  async handle(sessionId: string, msg: IncomingMessage): Promise<void> {
    const { config, store, logger } = this.deps;
    try {
      // Not our concern → no event at all.
      if (!config.enabledMessageTypes.includes(msg.type)) return;
      if (!msg.media) return;

      // Idempotency first, so every outcome (including skips) fires at most once per message id. Kept in
      // durable storage rather than memory: with chatDelivery 'reply' a duplicate transcript is a second
      // quote-reply the CONTACT sees, so this has to survive a worker restart, which is exactly when
      // WhatsApp is most likely to redeliver. Best-effort: read-modify-write is not atomic across a truly
      // simultaneous #466 re-fire (documented).
      // Serialized per session: the check and the write are a read-modify-write over ONE list, every
      // await in between is an IPC round-trip to the host, and `handle()` is deliberately floated off the
      // hook — so a burst (the engine materializes several voice notes at once) interleaved, and the last
      // writer overwrote the others' ids. Each lost id is a second paid STT call AND, with
      // chatDelivery 'reply', a duplicate transcript the CONTACT sees. The pre-1.1.0 one-key-per-note
      // scheme had no read-modify-write and so no such window; this restores that guarantee.
      const claimed = await this.serialize(sessionId, async () => {
        const seenKey = `seen:${sessionId}`;
        const seen = (await store.get<string[]>(seenKey)) ?? [];
        if (seen.includes(msg.id)) return false;
        await store.set(seenKey, [msg.id, ...seen].slice(0, SEEN_HISTORY));
        return true;
      });
      if (!claimed) return;
      await this.sweepLegacySeen(sessionId);

      const media = msg.media;
      if (media.omitted || !media.data) {
        await this.emit(sessionId, msg, { status: 'skipped', reason: 'media_unavailable' });
        return;
      }
      if (!media.mimetype || !media.mimetype.startsWith('audio/')) return; // defensive: not audio

      // Size is checked BEFORE decoding. Decoding first meant an oversized note — the very thing this
      // guard exists to reject — was materialized as a Buffer anyway, on top of the base64 string already
      // in memory, against a 256 MB worker heap that the host does not respawn if it blows.
      if (decodedBase64Size(media.data) > config.maxSizeBytes) {
        await this.emit(sessionId, msg, { status: 'skipped', reason: 'too_large' });
        return;
      }
      const audio = Buffer.from(media.data, 'base64');

      // One key per session holding {bucket, count}, not one key per session per HOUR — the hourly keys
      // were never deleted, so they accumulated for the life of the install.
      const rateKey = `rate:${sessionId}`;
      const bucket = Math.floor(this.now() / 3_600_000);
      const rate = await store.get<{ bucket: number; count: number }>(rateKey);
      const count = rate?.bucket === bucket ? rate.count : 0;
      if (count >= config.maxPerHour) {
        await this.emit(sessionId, msg, { status: 'skipped', reason: 'rate_limited' });
        return;
      }
      await store.set(rateKey, { bucket, count: count + 1 });

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

  /**
   * Delete a few pre-1.1.0 `seen:<sessionId>:<messageId>` keys per transcription. Without this an
   * upgraded install keeps paying the old cost forever: those keys are never read again, but the host
   * still stats every one of them on every write. Awaited rather than floated — the whole coordinator
   * already runs off the message-delivery path, and floating it made the cleanup non-deterministic —
   * but fully best-effort: a failure here must never affect a transcription.
   */
  private async sweepLegacySeen(sessionId: string): Promise<void> {
    if (this.legacySweptSessions.has(sessionId)) return; // nothing left; stop paying for the list()
    // BOTH pre-1.1.0 families. The dedup markers were `seen:<sid>:<msgId>` and the rate counter was
    // `rate:<sid>:<hour>` — one key per hour, also never deleted. Sweeping only the first would leave a
    // year-old install with ~8760 counter keys, i.e. the exact per-write stat cost this is here to remove.
    // The trailing ':' is what keeps these from matching the 1.1.0 keys `seen:<sid>` and `rate:<sid>`.
    const prefixes = [`seen:${sessionId}:`, `rate:${sessionId}:`];
    try {
      let remaining = 0;
      for (const prefix of prefixes) {
        const stale = (await this.deps.store.list(prefix)).filter(k => k.startsWith(prefix));
        for (const key of stale.slice(0, LEGACY_SWEEP_PER_RUN)) await this.deps.store.delete(key);
        remaining += Math.max(0, stale.length - LEGACY_SWEEP_PER_RUN);
      }
      // Retire only after TWO consecutive clean passes. The host's `list()` swallows its own errors and
      // resolves `[]`, so a single empty result is not proof the session is clean — and retiring on a
      // transient failure would strand the legacy keys forever, which is the thing being fixed.
      if (remaining === 0) {
        if (this.legacySweepCleanOnce.has(sessionId)) this.legacySweptSessions.add(sessionId);
        else this.legacySweepCleanOnce.add(sessionId);
      } else {
        this.legacySweepCleanOnce.delete(sessionId);
      }
    } catch {
      /* best-effort cleanup — never surfaces, and retries on the next transcription */
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
