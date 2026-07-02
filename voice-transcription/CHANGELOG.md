# Changelog

All notable changes to the Voice Note Transcription plugin are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.1] — 2026-07-02

### Fixed

- **A webhook-delivery failure no longer suppresses the in-chat transcript.** When both
  `deliveryWebhookUrl` and `chatDelivery` were configured, a transient webhook error threw before the
  chat send, so the transcript reached neither channel. The two sinks are now isolated: a webhook failure
  is warned and the in-chat delivery still runs.
- **Untrusted media mimetype is validated before it reaches the STT upload's multipart headers.** The
  inbound `mimetype` is now accepted only as a well-formed `type/subtype` token (codec suffix stripped);
  anything else — including a CRLF-bearing value — falls back to `audio/ogg`. The part filename is already
  fixed to `voice.ogg`, so valid formats (e.g. `audio/ogg; codecs=opus`) are unaffected.

### Added

- Initial release. Transcribes inbound WhatsApp voice notes via an OpenAI-compatible
  `/v1/audio/transcriptions` backend (self-hosted Speaches/faster-whisper, or hosted Groq/OpenAI) and
  delivers a `message.transcription` event to a configurable webhook — the integration channel for
  bots/AI to read and reply to audio.
- Runs **off the message-delivery critical path**: the `message:received` hook returns immediately and
  the STT call + delivery run as an un-awaited promise, so transcription never blocks or delays message
  delivery (and is not bound by the host's 5s hook budget).
- Audio is uploaded as a binary multipart body (intact across the sandbox boundary); the part is labeled
  `voice.ogg`/`audio/ogg` so OpenAI-compatible servers accept WhatsApp's OGG/Opus without transcoding.
- Guards: message-type filter (default `voice`), exact `maxSizeBytes` cost guard, best-effort per-session
  hourly rate limit, and a best-effort idempotency guard that suppresses near-simultaneous engine re-fires.
- Status events: delivers `completed` (with transcript), `failed` (STT errored), or `skipped` (too large,
  rate-limited, empty) — so a consumer always knows a voice note was received even when it can't be read.
- Optional **in-chat delivery** (`chatDelivery`: `off` | `self` | `reply`, default `off`) for operators who
  want the transcript inside WhatsApp; `self` notes it to your own number without leaking to the sender.
  Webhook delivery is optional too — the plugin can run chat-only.
- Webhook payloads are **HMAC-SHA256 signed** in `X-OpenWA-Signature` (same scheme as OpenWA core webhooks)
  when a delivery secret is set, so existing verification reuses the same check.
- STT **circuit breaker**: after repeated failures the backend is skipped for a cooldown, so a degraded
  provider isn't hammered.
- Fail-open throughout — any STT or delivery error is logged and skipped, never disrupting delivery.
- The delivered transcript is marked `untrusted: true` (`source: "speech-to-text"`): downstream LLM
  consumers must treat it as user-role input.
