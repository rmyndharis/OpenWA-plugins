# Changelog

All notable changes to this plugin are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres
to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- **The README no longer promises a dead-session `503` that Option B cannot deliver** — the host
  preflight probes the instance's `sessionScope`, so a blank scope skips the check and a delivery whose
  fallback session is down is acked `200` and lost with no provider retry. Both the provisioning list
  and the Security section now scope that guarantee to Option A.

## [0.3.0] — 2026-07-30

### Removed

- **The `engine:read` permission, and the `canonicalChatId` round-trip that needed it.** The call looked
  like it protected an OTP addressed to a contact keyed by a `@lid` privacy id, but it could never change
  anything: the chat id is always derived as `<digits>@c.us`, and the host's resolver returns a user-kind
  jid unchanged. It cost a 2-second race, a live-engine dependency on the OTP critical path, and a
  permission this plugin did not need — for a guaranteed round-trip to the same string. The README
  already claimed the plugin asked for no `engine:read`; now that is true.

### Fixed

- **The documented setup order could not succeed.** The guide said to install and enable the plugin
  first, but enabling validates the plugin's *base* config and refuses to start without `appName`, while
  the instance minted in step 1 carries a *per-instance* config. Following the README as written left
  enable failing. A base-config step now comes before enable.

### Documentation

- Delivery is **at-least-once**, and returning from the handler completes the job but does not guarantee
  it runs once: if an outcome is never recorded, the host's reconciler re-dispatches the row. The replay
  carries the same payload, so the contact receives the *same* code again — noise, not a security
  problem. Recorded explicitly, along with why there is deliberately no per-delivery dedup store: it
  would put an unbounded key-per-delivery on the OTP critical path to suppress a duplicate of an
  identical message.
- Per-user ordering and the retry/DLQ path require `QUEUE_ENABLED=true`; with the queue off, ingress
  runs inline, takes no ordering lock, and makes one attempt.

## [0.2.0] — 2026-07-23

### Added

- Resolve the phone-derived `<digits>@c.us` chat id through `ctx.engine.canonicalChatId` (OpenWA
  0.8.7+, new `engine:read` permission) before sending, so OTPs still land in the right chat for
  contacts keyed by a `@lid` privacy id. Best-effort: on older hosts or a resolution failure the
  phone JID is used unchanged.

## [0.1.0] — 2026-07-07

### Added

- Receive Supabase Auth's Send SMS hook (HTTP, Standard Webhooks-signed) on the ingress route
  `send-sms` and deliver the OTP over WhatsApp.
- Host-side Standard Webhooks verification: the manifest declares `signature.scheme:
  "standard-webhooks"`, and the host verifies `webhook-id` / `webhook-timestamp` / `webhook-signature`
  (base64 HMAC-SHA256 over `${webhook-id}.${webhook-timestamp}.${rawBody}`, constant-time, 5-min replay
  window) against the instance secret before the plugin runs. This logic originated in the plugin's
  `verify.ts` and was ported into the OpenWA server (`ingress-signature.ts`, `verifyStandardWebhooks`),
  so the plugin no longer ships its own copy.
- Synchronous feedback via the host `response` contract: a `session-alive` preflight returns **503**
  on a dead WhatsApp session and a declared **200 `application/json`** ack on success; a bad signature
  is rejected **401** by the host. Supabase learns immediately whether the OTP could be handed off — a
  dead session is no longer swallowed as a silent accept.
- Operator-configurable message template with `{appName}` and `{otp}` placeholders.
- Per-user ordering via `conversationId: { jsonPointer: "/user/id" }`; dedup keys on `webhook-id`.
- Async ingress with retry + DLQ: the handler runs from the ingress worker; the WhatsApp send is
  fire-and-forget to stay within the worker's 5 s dispatch budget (an awaited slow send would time out
  and retry into a duplicate OTP).
