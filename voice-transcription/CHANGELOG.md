# Changelog

All notable changes to the Voice Note Transcription plugin are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.2.8] - 2026-08-25

### Changed

- **Verified against OpenWA v0.23.3** (testedOpenWAVersion 0.23.0 → 0.23.3).

## [1.2.7] - 2026-08-20

### Changed

- **Verified against OpenWA v0.23.0** (testedOpenWAVersion 0.22.0 → 0.23.0).

## [1.2.6] - 2026-08-19

### Changed

- **Verified against OpenWA v0.22.0** (testedOpenWAVersion 0.20.0 → 0.22.0).

## [1.2.5] - 2026-08-16

### Changed

- **Verified against OpenWA v0.20.0** (testedOpenWAVersion 0.19.0 → 0.20.0); the catalog download URL now pins #sha256= for production installs.

## [1.2.4] — 2026-08-15

### Fixed

- **The multipart boundary for an upload is now drawn from the CSPRNG.** It was built from two
  `Math.random()` values. The audio bytes come from a sender, so a boundary that can be predicted is one
  that can be embedded to forge extra parts of the request. Matches the producers in the other plugins.


### Changed

- **`chatDelivery: reply` now says what it does in a group.** The option posts a quote-reply to the
  sender, which in a group is visible to every member — the transcript of a voice note read out to the
  whole chat. The behaviour is unchanged and still defaults to `off`; the config description and the
  README table now state the group consequence before an operator turns it on.


### Changed

- **Compatibility re-verified against OpenWA v0.19.0** (testedOpenWAVersion 0.14.0 → 0.19.0). The
  manifest passes the v0.19.0 host's load-time validation (manifest, ingress and main-entry
  checks) and the built bundle loads under the loader contract. No capability surface this plugin
  uses changed between 0.14 and 0.19; the v0.19 breaking changes are host-side (API key length,
  removed REST endpoints, the plain-http install pin) and do not touch this plugin.

## [1.2.3] — 2026-08-12

### Changed

- **Declared the `storage:use` permission.** Two things live in plugin storage, one key each per
  WhatsApp session: the list of voice notes already transcribed, and the hourly counter behind the
  rate cap. OpenWA is moving `ctx.storage` behind a permission the manifest has to declare, and
  without it both are refused — which costs money rather than just state. The de-duplication list is
  what stops the same voice note being sent to the speech-to-text backend twice, and the counter is
  what enforces `maxPerHour`; lose them and every redelivery becomes another paid transcription with
  no ceiling, plus a duplicate transcript the contact sees when `chatDelivery` is set to `reply`.
  Declaring the permission changes nothing on the hosts you run today — an unrecognized permission is
  ignored — so 1.2.3 behaves exactly like 1.2.2.

## [1.2.2] — 2026-08-08

### Fixed

- **Spanish now translates the configuration fields, not just the plugin name** — the `es` locale carried
  `name` and `description` but no `config` block, so a Spanish dashboard showed a Spanish title above
  thirteen English field labels. Every other locale already had one.

## [1.2.1] — 2026-08-01

No behaviour change. 1.2.0 has now been smoke-tested against a newer host, so the tested-version field
is updated to match.

### Verified

- **Confirmed against a live OpenWA 0.12.1 host**, with a connected WhatsApp session, against a real
  self-hosted faster-whisper server (`Systran/faster-whisper-small.en`) speaking the OpenAI-compatible
  `/v1/audio/transcriptions` API at `http://localhost:9010`, with `chatDelivery: reply`. A genuine
  Ogg/Opus WhatsApp voice note was sent from a second connected number; the plugin downloaded the media
  through the host, uploaded it as multipart through `ctx.net.fetch`, and the ASR server logged
  `POST /v1/audio/transcriptions 200`. The spoken sentence came back into the chat as text, matching what
  was said.
- **The transformer-band fix from 1.2.0 holds**: the hook registered at priority 40, the Transformer
  band assigned in `PLUGIN-STANDARD.md`.
- **Not covered:** load, concurrency, or long audio.

## [1.2.0] — 2026-07-31

### Fixed

- **A voice note could go untranscribed if another auto-reply plugin was also installed.** This plugin
  ran at the default hook priority — the same one an auto-reply plugin claiming its messages also runs
  at by default — so whether this plugin ever saw the voice note at all depended on which plugin happened
  to register first, which could change across a restart or re-enable. It now registers in the
  transformer band, ahead of every responder, so it sees and transcribes the voice note before any
  responder can answer it, instead of racing them for registration order.

## [1.1.0] — 2026-07-30

### Added

- **Your own STT and delivery hosts no longer require forking the plugin.** The manifest now declares
  `sttBaseUrl` and `deliveryWebhookUrl` as `net.allowConfigHosts`, so any **https** URL you configure is
  admitted by the host's outbound gate automatically. Previously the only allowed hosts were the four
  baked into `net.allow`, and the setup guide told you to edit `manifest.json` and re-package the plugin
  to use your own webhook — which meant that following the documented setup produced a plugin whose
  every delivery attempt was blocked, swallowed by the fail-open delivery path, and invisible because
  this plugin has no health check. The static `net.allow` entries remain: config-derived hosts are
  https-only, so they are what still covers a plain-`http` local backend.

### Fixed

- **Storage keys no longer grow without bound.** OpenWA 0.12.0 re-measures a plugin's storage quota on
  every write by stat-ing every one of its keys, so keys that are written once and never deleted make
  each subsequent write more expensive — permanently. This plugin wrote one dedup key per transcribed
  voice note and one counter key per session per hour, and deleted neither. Dedup now uses a single
  capped list per session (the 500 most recent message ids, ample against any redelivery window) and the
  rate limiter a single `{bucket, count}` key per session, so the key count is now proportional to the
  number of sessions rather than to how long the plugin has been running. Keys written by earlier
  versions are swept away a few at a time as transcriptions run, so an upgraded install recovers without
  a long delete loop at enable — which matters now that enabling happens unattended at host boot.
- **The hourly spend cap is serialized too.** Collapsing the per-hour counter keys into one key per
  session turned its check-and-increment into a read-modify-write the old scheme did not have: two notes
  straddling an hour boundary wrote different keys before, but now the pre-boundary write can land last
  and restore the previous bucket, restarting the new hour at zero and doubling a cap whose stated job is
  bounding paid-API spend.
- **The dedup claim is serialized per session.** Collapsing the per-note keys into one list per session
  made the check-and-write a read-modify-write, and `handle()` runs deliberately off the message hook —
  so a burst (the engine materializes several voice notes at once) interleaved and the last writer
  overwrote the others' ids. Each lost id is a second paid STT call and, with `chatDelivery: reply`, a
  duplicate transcript the contact sees. Only the claim is serialized; transcription and delivery stay
  concurrent.
- **The legacy sweep clears the old hourly rate keys too, and no longer retires on one empty listing.**
  It originally swept only `seen:<sid>:*`, leaving the pre-1.1.0 `rate:<sid>:<hour>` keys — one per
  hour, also never deleted — to keep taxing every write on an upgraded install. And because the host's
  `list()` swallows its own errors and resolves empty, a single transient failure looked like a clean
  session and permanently retired the sweep, stranding exactly the keys it exists to remove. Both
  families are swept now, and there is no retirement at all: an empty listing and a failed one are
  indistinguishable, so any "this session is clean, stop looking" rule can strand the very keys the sweep
  exists to remove. What it saved was a readdir of a directory this release already made small.
- **`timeoutMs` is clamped in code, not just in the manifest.** A `configSchema` `max` is a form hint
  the host never enforces, so a stored value above the ceiling still reached the STT client and made
  the capability timer race the fetch abort — reporting an STT timeout as a capability timeout.
- **Audio size is checked before the base64 is decoded.** An oversized voice note — precisely what the
  guard exists to reject — was decoded into a Buffer first, on top of the base64 string already held in
  memory, against a 256 MB worker heap that the host does not respawn if it is exhausted.
- **`timeoutMs` no longer allows a value that races the host.** The schema permitted 30000 and described
  it as the host ceiling, but the per-capability budget is also 30000, so the two expired together and
  the resulting failure was reported as a capability timeout rather than an STT timeout. The maximum is
  now 25000.
- **An unset STT base URL is reported at enable.** The host does not enforce a `required` config field,
  so the plugin enabled cleanly with no backend and then failed every transcription with a net-allow
  error that read like a broken allowlist rather than a missing setting.

## [1.0.2] — 2026-07-18

### Fixed

- **Declared the `messages:send` permission required by in-chat delivery.** The `chatDelivery` feature
  (`self` / `reply`) sends the transcript back into WhatsApp via `ctx.messages.sendText` / `ctx.messages.reply`,
  both gated by the `messages:send` permission, but the manifest only declared `net:fetch`. As a result,
  enabling `chatDelivery: 'self'` or `'reply'` threw `PluginCapabilityError` on every transcript send (the
  default `'off'` masked it). The permission is now declared, so in-chat delivery works as documented.

- **Per-session config overrides are now honored at message time without resetting the circuit breaker
  on every message.** The coordinator was built once at `onEnable` and the hook read that cached instance,
  so a per-session override (e.g. a different STT backend or delivery webhook for one session) set via the
  dashboard after enable was ignored. The hook now recomputes a signature of the coordinator-affecting
  config fields per event and rebuilds the coordinator only when that signature changes — so an override
  takes effect, while the STT provider's circuit-breaker state is preserved across messages for an
  unchanged backend (a naive per-event rebuild would open/close the backend anew on each call and defeat
  the breaker's purpose).

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
