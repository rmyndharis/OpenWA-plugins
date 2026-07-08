// Standard Webhooks signature verification (https://www.standardwebhooks.com/).
//
// Supabase's HTTP auth hooks sign requests per the spec:
//   headers: webhook-id, webhook-timestamp (unix seconds), webhook-signature
//   webhook-signature: "v1,<base64(HMAC-SHA256(key, "{id}.{timestamp}.{rawBody}"))>"
//   key: base64-decode(whsec_<base64>) — secret pasted as "v1,whsec_<base64>"
//
// Pure and total: never throws — returns { ok: false, reason } so the caller maps failure to
// the right behavior (throw → retry/DLQ) without a try/capture.

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface VerifyStandardWebhooksInput {
  rawBody: string;
  headers: Record<string, string>; // lower-cased keys (OpenWA delivers them this way)
  secret: string; // the configured secret, e.g. "v1,whsec_<base64>" or bare "<base64>"
  now: number; // ms epoch (injected so replay tests are deterministic)
  toleranceSec?: number; // default 300
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

const DEFAULT_TOLERANCE_SEC = 300;

// Lowercase header keys once so lookups are case-insensitive (OpenWA delivers them lowercased,
// but a security function should not assume that).
function lowerHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

/**
 * Strip the Standard Webhooks secret prefix to raw base64 key material:
 * "v1,whsec_<b64>" → "<b64>", "whsec_<b64>" → "<b64>", "<b64>" → "<b64>".
 * Returns undefined when empty or prefix-only.
 */
export function parseWebhookSecret(secret: string): string | undefined {
  let s = secret.trim();
  if (s.startsWith('v1,')) s = s.slice(3);       // secret version tag (may be absent)
  if (s.startsWith('whsec_')) s = s.slice(6);    // symmetric-key marker
  return s.length > 0 ? s : undefined;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Verify a Standard Webhooks signature. The signature header may carry multiple space-separated
 * "v1,..." candidates (spec allows rotation); accepts the first match. Supabase sends a single v1.
 */
export function verifyStandardWebhooks(input: VerifyStandardWebhooksInput): VerifyResult {
  const keyB64 = parseWebhookSecret(input.secret);
  if (!keyB64) return { ok: false, reason: 'empty webhook secret' };

  let key: Buffer;
  try {
    key = Buffer.from(keyB64, 'base64');
  } catch {
    return { ok: false, reason: 'webhook secret is not valid base64' };
  }
  if (key.length === 0) return { ok: false, reason: 'webhook secret decodes to empty key' };

  const hh = lowerHeaders(input.headers);
  const id = hh['webhook-id'];
  const tsRaw = hh['webhook-timestamp'];
  const sigHeader = hh['webhook-signature'];
  if (!id || !tsRaw || !sigHeader) {
    return { ok: false, reason: 'missing webhook-id/webhook-timestamp/webhook-signature header' };
  }

  const ts = Number.parseInt(tsRaw, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'invalid webhook-timestamp' };

  const tolerance = input.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  const skewSec = Math.abs(input.now / 1000 - ts);
  if (skewSec > tolerance) return { ok: false, reason: 'replay: timestamp outside tolerance' };

  // Supabase sends uncompressed UTF-8; rawBody is the exact signed bytes (utf8 string).
  const signed = `${id}.${tsRaw}.${input.rawBody}`;
  const expected = createHmac('sha256', key).update(signed).digest('base64');

  // Signature header is a space-separated list of "version,signature" candidates.
  for (const candidate of sigHeader.split(' ')) {
    const comma = candidate.indexOf(',');
    if (comma < 0) continue;
    const version = candidate.slice(0, comma);
    const provided = candidate.slice(comma + 1);
    if (version !== 'v1') continue;
    if (safeEqual(provided, expected)) return { ok: true };
  }
  return { ok: false, reason: 'webhook-signature mismatch' };
}
