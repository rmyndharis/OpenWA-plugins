# Changelog

All notable changes to this plugin are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres
to [Semantic Versioning](https://semver.org/).

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
