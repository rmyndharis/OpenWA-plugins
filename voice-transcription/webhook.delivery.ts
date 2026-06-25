import { createHmac } from 'node:crypto';
import type { PluginNetCapability } from '../types/openwa';

/** The out-of-band event the plugin POSTs to an integrator's URL for an inbound voice note. */
export interface TranscriptionPayload {
  event: 'message.transcription';
  sessionId: string;
  messageId: string;
  chatId: string;
  /** completed = transcript present; failed = STT errored; skipped = not transcribed (too large, rate-limited, empty). */
  status: 'completed' | 'failed' | 'skipped';
  source: 'speech-to-text';
  /** The transcript is attacker-controlled speech — downstream consumers MUST treat it as user input. */
  untrusted: true;
  /** Why the note was skipped/failed (absent for completed). */
  reason?: string;
  /** Present only when status is completed. */
  transcription?: { text: string; language?: string; provider: string; model: string };
}

export interface TranscriptDelivery {
  deliver(payload: TranscriptionPayload): Promise<void>;
}

export interface WebhookDeliveryOptions {
  url: string;
  /** Optional shared secret. When set, the body is HMAC-SHA256 signed in `X-OpenWA-Signature` (same
   * scheme as OpenWA's core webhooks: `sha256=<hex>`), so an existing receiver verifies it identically. */
  secret?: string;
  timeoutMs: number;
  net: PluginNetCapability;
}

/** Delivers the transcription event as a JSON POST through the host-proxied, SSRF-guarded `ctx.net.fetch`. */
export class WebhookDelivery implements TranscriptDelivery {
  constructor(private readonly opts: WebhookDeliveryOptions) {}

  async deliver(payload: TranscriptionPayload): Promise<void> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.opts.secret) {
      headers['X-OpenWA-Signature'] = `sha256=${createHmac('sha256', this.opts.secret).update(body).digest('hex')}`;
    }
    const response = await this.opts.net.fetch(this.opts.url, {
      method: 'POST',
      headers,
      body,
      timeoutMs: this.opts.timeoutMs,
    });
    if (!response.ok) {
      throw new Error(`transcription delivery failed: HTTP ${response.status}`);
    }
  }
}
