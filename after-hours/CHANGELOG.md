# Changelog

All notable changes to the **After-Hours Auto-Reply** plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this plugin adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The version here always matches `manifest.json`'s `version`.

## [Unreleased]

## [0.2.6] - 2026-08-25

### Fixed

- **An overnight window now covers the following morning, not the same one.** A window such as
  `22:00-06:00` under `mon` was read entirely out of the Monday entry, so the plugin stayed silent on
  Monday morning, which nothing had declared open, and replied on Tuesday morning, which the Monday
  window actually covers. A window belongs to the day it opens on. This supersedes the 0.2.2 note that
  described an overnight window as open late and early on the same day.
- A blank `cooldownSec` falls back to the 3600s default instead of disabling the throttle. An empty
  string became `0`, which is the documented "reply every time" value, so every after-hours message
  from the same contact drew its own reply.

### Added

- A `healthCheck` reporting the live timezone and cooldown. It turns unhealthy when a config edit made
  after enable fails validation: the plugin answers nothing in that state, and the host otherwise
  reports a plugin with no health check as healthy.

### Changed

- **Verified against OpenWA v0.23.3** (testedOpenWAVersion 0.23.0 → 0.23.3).

## [0.2.5] - 2026-08-20

### Changed

- **Verified against OpenWA v0.23.0** (testedOpenWAVersion 0.22.0 → 0.23.0).

## [0.2.4] - 2026-08-19

### Changed

- **Verified against OpenWA v0.22.0** (testedOpenWAVersion 0.20.0 → 0.22.0).

## [0.2.3] - 2026-08-16

### Changed

- **Verified against OpenWA v0.20.0** (testedOpenWAVersion 0.19.0 → 0.20.0); the catalog download URL now pins #sha256= for production installs.

## [0.2.2] — 2026-08-15

### Fixed

- **Overnight and all-day windows are accepted.** `22:00-06:00` and `00:00-00:00` are ordinary business
  hours, but the parser rejected any window whose open was not before its close — which made the whole
  schedule unparseable rather than just that day. The comparison understands a wrapped window now, so an
  overnight one is open late and early and closed in between.
- **The send-retry backoff map is now bounded.** An entry is added when a send fails and removed on the
  next delivery, so a chat that never messages again left one behind. Every other piece of state in this
  plugin was already capped; this was the exception.



### Changed

- **Compatibility re-verified against OpenWA v0.19.0** (testedOpenWAVersion 0.14.0 → 0.19.0). The
  manifest passes the v0.19.0 host's load-time validation (manifest, ingress and main-entry
  checks) and the built bundle loads under the loader contract. No capability surface this plugin
  uses changed between 0.14 and 0.19; the v0.19 breaking changes are host-side (API key length,
  removed REST endpoints, the plain-http install pin) and do not touch this plugin.

## [0.2.1] — 2026-08-01

No behaviour change. 0.2.0 has now been smoke-tested against a newer host, so the tested-version field
is updated to match.

### Verified

- **Confirmed against a live OpenWA 0.12.1 host**, with a connected WhatsApp session, this plugin
  enabled alongside four other responder plugins (including chat-flow and faq-bot) and driven by real
  messages from a second connected WhatsApp number. A message matching nothing more specific fell
  through to the other catch-all responder rather than this plugin, as expected from the 0.2.0
  last-registered priority; with that other catch-all disabled, the same kind of message was then
  answered by this plugin with its configured away message.
- **Not covered:** group chats, media messages, and behaviour under load.

## [0.2.0] — 2026-07-31

### Fixed

- **A delivered away message could draw a second answer from another auto-reply plugin.** This plugin
  knew whether it had replied but never acted on it, so a co-installed bot behind it in the hook chain
  could answer the same message too. It now claims a message only when the away reply actually sent — a
  suppressed or failed send still leaves the next plugin free to answer.
- **This plugin now registers last among responders**, since the away message is a catch-all that should
  only speak when nothing more specific has already answered — instead of the registration-order default,
  which could put it ahead of another responder depending on enable order.

## [0.1.4] — 2026-07-30

### Fixed

- **A failed away reply silenced the chat for the whole cooldown.** The per-chat slot is taken *before*
  the send, so a reply that then failed left nothing delivered and nothing retryable until the window
  expired. That path is easier to hit on OpenWA 0.12, where another plugin vetoing `message:sending`
  surfaces here as a thrown error indistinguishable from a transport failure. The slot is now rewound rather than released — clearing it outright removed the only throttle, so a
  permanently blocked send turned every inbound message into another attempt. The next try lands a fixed
  backoff from the failure,
  when the reply fails, so the contact's next message tries again.
- **The failure backoff is an absolute deadline, not a rewound cooldown timestamp.** Expressing it as a
  rewind only makes sense against the cooldown value it was computed from, and config is re-read per
  message — so an operator lowering `cooldownSec` in the dashboard turned the stored value into "long
  past" and handed back the un-throttled retry the backoff exists to prevent.
- **`minOpenWAVersion` corrected from 0.6.2 to 0.7.0.** Per-session config — which the 0.1.3 fix and the
  README's "Per-session config: Supported" both depend on — landed in 0.7.0. On a 0.6.x host the plugin
  installed happily and then ignored every per-session override, replying with the base away message on
  every number.

## [0.1.3] — 2026-07-18

### Fixed

- **Per-session config overrides are now honored at message time.** The hook previously read a config
  snapshot cached at enable, so a per-session override (e.g. a different schedule or away message for one
  WhatsApp number) set via the dashboard after enable was ignored. The hook now re-parses `ctx.config` on
  each event, which the host resolves to the firing session's slice. An invalid config for a session is
  logged and skipped instead of replying with a stale snapshot. The enable-time fail-fast validation is
  retained so a bad base config still surfaces in the dashboard.

## [0.1.2] — 2026-06-23

### Changed

- The per-chat cooldown map now evicts least-recently-used entries (re-inserting a chat on each reply)
  instead of first-seen order, so a continuously-active chat keeps its cooldown when the map reaches its
  cap rather than being evicted and allowed to bypass the throttle.

## [0.1.1] — 2026-06-23

### Added

- Localized dashboard text (`name`, `description`, config field titles) for es, fr, it, ar, he, te, zh-CN,
  zh-HK via `manifest.i18n`. English remains the default + fallback. Translations are machine-generated;
  human review recommended for ar/he/te.

## [0.1.0] — 2026-06-23

First release. Built against OpenWA v0.6.2.

### Added

- Auto-reply with a configurable away/closing message to inbound messages received outside a per-day
  business-hours schedule (`mon`..`sun` → `"HH:MM-HH:MM"` or closed), interpreted in a configurable
  IANA `timezone`. Replies are quoted, and throttled per chat by `cooldownSec`.
- `respondInGroups` toggle (default off — direct chats only).
- A structurally invalid `schedule` (bad day/time, `open >= close`, all-closed) or an unknown
  `timezone` fails fast, surfacing as `ERROR` in the dashboard.
