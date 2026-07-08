# Changelog

All notable changes to this plugin are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres
to [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-07-07

### Added

- Receive Supabase Auth's Send SMS hook (HTTP, Standard Webhooks-signed) on the ingress route
  `send-sms` and deliver the OTP.
- Self-verifies the Standard Webhooks signature (`webhook-id` / `webhook-timestamp` /
  `webhook-signature`) inside the sandboxed handler using `node:crypto`. The manifest declares
  `signature.scheme: "none"` so the host skips verification.
- Operator-configurable message template with `{appName}` and `{otp}` placeholders.
- Per-user ordering via `conversationId: { jsonPointer: "/user/id" }`; dedup keys on `webhook-id`.
- `sync-reply` ingress mode: the handler returns its actual outcome to Supabase — 200
  `application/json` after the session liveness probe, 400/401 client errors, 500 misconfiguration,
  503 dead session, and 504 if the host handler timeout is exceeded.
- Probes session liveness via `canonicalChatId` before the WhatsApp send; the WhatsApp send is
  fire-and-forget because Supabase's hook has a 5 s timeout and does not retry.
