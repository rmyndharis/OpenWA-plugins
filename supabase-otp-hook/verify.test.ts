import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { parseWebhookSecret, verifyStandardWebhooks } from './verify.ts';

// A realistic Standard Webhooks key: 32 random bytes, base64. Secret pasted as "v1,whsec_<b64>".
const keyBytes = randomBytes(32);
const keyB64 = keyBytes.toString('base64');
const secret = `v1,whsec_${keyB64}`;

const ts = 1_700_000_000;
const now = ts * 1000;
const id = 'msg_123';
const rawBody = JSON.stringify({
  user: { id: 'u1', phone: '+15551234567' },
  sms: { otp: '123456' },
});

function sign(t: number, body: string = rawBody): string {
  return 'v1,' + createHmac('sha256', keyBytes).update(`${id}.${t}.${body}`).digest('base64');
}

function headers(sig: string, t: number = ts): Record<string, string> {
  return {
    'webhook-id': id,
    'webhook-timestamp': String(t),
    'webhook-signature': sig,
  };
}

test('parseWebhookSecret strips v1, and whsec_ prefixes', () => {
  assert.equal(parseWebhookSecret(`v1,whsec_${keyB64}`), keyB64);
  assert.equal(parseWebhookSecret(`whsec_${keyB64}`), keyB64);
  assert.equal(parseWebhookSecret(keyB64), keyB64);
  assert.equal(parseWebhookSecret('  v1,whsec_abc  '), 'abc');
});

test('parseWebhookSecret returns undefined for empty / prefix-only values', () => {
  assert.equal(parseWebhookSecret(''), undefined);
  assert.equal(parseWebhookSecret('   '), undefined);
  assert.equal(parseWebhookSecret('v1,whsec_'), undefined);
  assert.equal(parseWebhookSecret('whsec_'), undefined);
});

test('verifies a correctly signed request with all supported secret formats', () => {
  const h = headers(sign(ts));
  assert.equal(verifyStandardWebhooks({ rawBody, headers: h, secret, now }).ok, true);
  assert.equal(verifyStandardWebhooks({ rawBody, headers: h, secret: `whsec_${keyB64}`, now }).ok, true);
  assert.equal(verifyStandardWebhooks({ rawBody, headers: h, secret: keyB64, now }).ok, true);
});

test('rejects a wrong signature', () => {
  const r = verifyStandardWebhooks({ rawBody, headers: headers('v1,Zm9vYmFy'), secret, now });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /mismatch/);
});

test('rejects a stale timestamp beyond tolerance', () => {
  const stale = ts - 3600; // 1h old, beyond the 300s window
  const r = verifyStandardWebhooks({ rawBody, headers: headers(sign(stale), stale), secret, now });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /tolerance/);
});

test('accepts a timestamp within tolerance', () => {
  const near = ts + 60; // 60s skew
  const r = verifyStandardWebhooks({ rawBody, headers: headers(sign(near), near), secret, now });
  assert.equal(r.ok, true);
});

test('rejects when a header is missing', () => {
  assert.equal(verifyStandardWebhooks({ rawBody, headers: { 'webhook-id': id, 'webhook-timestamp': String(ts) }, secret, now }).ok, false);
  assert.equal(verifyStandardWebhooks({ rawBody, headers: { 'webhook-id': id, 'webhook-signature': sign(ts) }, secret, now }).ok, false);
  assert.equal(verifyStandardWebhooks({ rawBody, headers: { 'webhook-timestamp': String(ts), 'webhook-signature': sign(ts) }, secret, now }).ok, false);
});

test('rejects an invalid timestamp', () => {
  const r = verifyStandardWebhooks({ rawBody, headers: { 'webhook-id': id, 'webhook-timestamp': 'not-a-number', 'webhook-signature': sign(ts) }, secret, now });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /invalid webhook-timestamp/);
});

test('rejects an empty/short secret', () => {
  const r = verifyStandardWebhooks({ rawBody, headers: headers(sign(ts)), secret: '', now });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /empty webhook secret/);
});

test('signature is computed over the exact raw body (re-serialization would break it)', () => {
  // A different raw body, even if it JSON-parses to the same object, must not verify against the
  // original signature — the HMAC is over bytes, not semantics.
  const reordered = JSON.stringify({ sms: { otp: '123456' }, user: { id: 'u1', phone: '+15551234567' } });
  const r = verifyStandardWebhooks({ rawBody: reordered, headers: headers(sign(ts)), secret, now });
  assert.equal(r.ok, false);
});

test('header names are case-insensitive', () => {
  const r = verifyStandardWebhooks({
    rawBody,
    headers: {
      'Webhook-Id': id,
      'WEBHOOK-TIMESTAMP': String(ts),
      'webhook-Signature': sign(ts),
    },
    secret,
    now,
  });
  assert.equal(r.ok, true);
});

test('accepts a space-separated signature list and picks the matching v1 candidate', () => {
  const fake = 'v1,Zm9vYmFy';
  const good = sign(ts);
  const r = verifyStandardWebhooks({ rawBody, headers: headers(`${fake} ${good}`), secret, now });
  assert.equal(r.ok, true);
});

test('ignores non-v1 signature candidates', () => {
  const v2 = 'v2,' + createHmac('sha256', keyBytes).update(`${id}.${ts}.${rawBody}`).digest('base64');
  const r = verifyStandardWebhooks({ rawBody, headers: headers(v2), secret, now });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /mismatch/);
});

// ── tolerance boundary tests ─────────────────────────────────────────────────

test('accepts a timestamp exactly at the tolerance boundary', () => {
  const boundary = ts - 300; // exactly DEFAULT_TOLERANCE_SEC old
  const r = verifyStandardWebhooks({ rawBody, headers: headers(sign(boundary), boundary), secret, now });
  assert.equal(r.ok, true);
});

test('rejects a timestamp one second past the tolerance boundary', () => {
  const past = ts - 301;
  const r = verifyStandardWebhooks({ rawBody, headers: headers(sign(past), past), secret, now });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /tolerance/);
});

test('rejects a future timestamp beyond tolerance', () => {
  const future = ts + 3600;
  const r = verifyStandardWebhooks({ rawBody, headers: headers(sign(future), future), secret, now });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /tolerance/);
});

// ── signature header edge cases ──────────────────────────────────────────────

test('rejects a signature header with an empty v1 value', () => {
  const r = verifyStandardWebhooks({ rawBody, headers: headers('v1,'), secret, now });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /mismatch/);
});

test('rejects a malformed signature without a version comma', () => {
  const r = verifyStandardWebhooks({ rawBody, headers: headers('Zm9vYmFy'), secret, now });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /mismatch/);
});

// ── secret edge cases ────────────────────────────────────────────────────────

test('verifies with a secret that has leading/trailing whitespace', () => {
  const r = verifyStandardWebhooks({ rawBody, headers: headers(sign(ts)), secret: `  ${secret}  `, now });
  assert.equal(r.ok, true);
});

test('rejects a secret that decodes to an empty key', () => {
  assert.equal(verifyStandardWebhooks({ rawBody, headers: headers(sign(ts)), secret: 'v1,whsec_!!!', now }).ok, false);
  assert.equal(verifyStandardWebhooks({ rawBody, headers: headers(sign(ts)), secret: 'v1,whsec_', now }).ok, false);
});
