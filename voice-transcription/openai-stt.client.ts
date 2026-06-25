import type { PluginNetCapability } from '../types/openwa';
import { buildMultipartBody, MultipartField } from './multipart.ts';

export interface SttResult {
  text: string;
  language?: string;
}

export interface SttProvider {
  transcribe(audio: Uint8Array, mimetype: string): Promise<SttResult>;
}

export interface OpenAiSttOptions {
  /** Base URL of an OpenAI-compatible STT server (e.g. http://localhost:8000 — Speaches/faster-whisper). */
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Optional language hint (BCP-47); empty/undefined = auto-detect. */
  language?: string;
  timeoutMs: number;
  net: PluginNetCapability;
  /** Consecutive failures before the circuit opens (default 5). */
  failureThreshold?: number;
  /** How long the circuit stays open after tripping (default 30000ms). */
  cooldownMs?: number;
  /** Injectable clock (defaults to Date.now). */
  now?: () => number;
}

/**
 * Calls an OpenAI-compatible `/v1/audio/transcriptions` endpoint over the host-proxied, SSRF-guarded
 * `ctx.net.fetch`. The audio is uploaded as a binary multipart body (a Buffer) — it crosses the
 * sandbox→host boundary via structuredClone intact, which a string body could not.
 */
export class OpenAiSttClient implements SttProvider {
  private readonly base: string;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private consecutiveFailures = 0;
  private openUntil = 0;

  constructor(private readonly opts: OpenAiSttOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 30000;
    this.now = opts.now ?? (() => Date.now());
  }

  isHealthy(): boolean {
    return this.consecutiveFailures < this.failureThreshold;
  }

  async transcribe(audio: Uint8Array, mimetype: string): Promise<SttResult> {
    // Circuit breaker: while open, fail fast without touching a known-bad backend.
    if (this.now() < this.openUntil) {
      throw new Error('STT circuit open');
    }
    try {
      const result = await this.doTranscribe(audio, mimetype);
      this.consecutiveFailures = 0;
      return result;
    } catch (err) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.openUntil = this.now() + this.cooldownMs;
      }
      throw err;
    }
  }

  private async doTranscribe(audio: Uint8Array, mimetype: string): Promise<SttResult> {
    const boundary = `----openwaFormBoundary${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    const fields: MultipartField[] = [
      { name: 'model', value: this.opts.model },
      { name: 'response_format', value: 'json' },
    ];
    if (this.opts.language) fields.push({ name: 'language', value: this.opts.language });

    // Strip the codec suffix ("audio/ogg; codecs=opus" → "audio/ogg") and always name the part
    // `voice.ogg`: OpenAI-compatible servers key the decoder off the filename extension and reject a
    // bare ".opus", but accept ogg/oga.
    const contentType = mimetype.split(';')[0].trim() || 'audio/ogg';
    const formBody = buildMultipartBody(boundary, fields, [
      { name: 'file', filename: 'voice.ogg', contentType, data: audio },
    ]);

    const headers: Record<string, string> = { 'content-type': `multipart/form-data; boundary=${boundary}` };
    if (this.opts.apiKey) headers['authorization'] = `Bearer ${this.opts.apiKey}`;

    const response = await this.opts.net.fetch(`${this.base}/v1/audio/transcriptions`, {
      method: 'POST',
      headers,
      body: formBody,
      timeoutMs: this.opts.timeoutMs,
    });
    if (!response.ok) {
      throw new Error(`STT request failed: HTTP ${response.status}`);
    }
    const data = JSON.parse(response.body) as { text?: unknown; language?: unknown };
    if (typeof data?.text !== 'string') {
      throw new Error('STT response contained no text');
    }
    return { text: data.text, language: typeof data.language === 'string' ? data.language : undefined };
  }
}
