# Changelog

All notable changes to the **Chat Flow** plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this plugin adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The version here always matches `manifest.json`'s `version`.

## [Unreleased]

## [1.1.7] - 2026-08-25

### Fixed

- **Flow state is recorded before the message it describes is sent.** A storage write that failed after
  the greeting had gone out left the flow unstarted, and with the documented empty `trigger` the next
  message read as another first message and greeted again: one outbound WhatsApp message per inbound
  message, uncapped. The same ordering now applies when advancing into a sub-menu, which previously
  could show a menu the stored path had not moved to and then match the next answer a level up.
- **Debug logging no longer writes message content.** `Trigger check` logged the full trimmed body of
  every inbound message, `Loaded state` logged the stored path (the options a contact had picked), and
  `Input matched option` logged the input and the reply text. Release 1.1.3 removed one line of this
  and left the rest. Raising `LOG_LEVEL` to debug no longer turns the plugin log into a transcript.

- A shared contact card or a poll no longer starts the flow or draws "Invalid option". OpenWA 0.23.2
  fills the message body for both (a card carries its vCard, a poll its question), so a non-empty body
  is no longer proof that someone typed at the menu. Business button and list replies are still
  accepted, and a captioned image still reaches the menu as before.

### Changed

- **Verified against OpenWA v0.23.3** (testedOpenWAVersion 0.23.0 → 0.23.3).

## [1.1.6] - 2026-08-20

### Changed

- **Verified against OpenWA v0.23.0** (testedOpenWAVersion 0.22.0 → 0.23.0).

## [1.1.5] - 2026-08-19

### Changed

- **Verified against OpenWA v0.22.0** (testedOpenWAVersion 0.20.0 → 0.22.0).

## [1.1.4] - 2026-08-16

### Changed

- **Verified against OpenWA v0.20.0** (testedOpenWAVersion 0.19.0 → 0.20.0); the catalog download URL now pins #sha256= for production installs.

## [1.1.3] — 2026-08-15

### Fixed

- **The debug log no longer records the text of every incoming message.** The line runs for each inbound
  message and the dashboard renders plugin logs. It now records the body length, which is what the
  diagnostic actually uses.



### Changed

- **Compatibility re-verified against OpenWA v0.19.0** (testedOpenWAVersion 0.14.0 → 0.19.0). The
  manifest passes the v0.19.0 host's load-time validation (manifest, ingress and main-entry
  checks) and the built bundle loads under the loader contract. No capability surface this plugin
  uses changed between 0.14 and 0.19; the v0.19 breaking changes are host-side (API key length,
  removed REST endpoints, the plain-http install pin) and do not touch this plugin.

## [1.1.2] — 2026-08-12

### Changed

- **Declared the `storage:use` permission.** This plugin is a state machine, and its entire state —
  where each conversation currently sits in the menu tree — lives in plugin storage. OpenWA is moving
  `ctx.storage` behind a permission the manifest has to declare, and without it there is nothing left
  to run on: a contact would get the greeting and the top-level menu, then have their answer read as
  another first message and be sent the same greeting again. This is the one plugin in the catalog for
  which the missing declaration is total rather than partial. Declaring it changes nothing on the
  hosts you run today — an unrecognized permission is ignored — so 1.1.2 behaves exactly like 1.1.1.

## [1.1.1] — 2026-08-01

No behaviour change. 1.1.0 has now been smoke-tested against a newer host, so the tested-version field
is updated to match.

### Verified

- **Confirmed against a live OpenWA 0.12.1 host**, with a connected WhatsApp session, this plugin
  enabled alongside four other responder plugins (including faq-bot and after-hours) and driven by real
  messages from a second connected WhatsApp number. A message matching the configured trigger word
  started the menu flow, answered by this plugin and by nothing else — and once the contact was inside
  the menu, this plugin continued to own their replies until the flow was cleared, confirming the 1.1.0
  responder-priority fix holds with a full set of co-installed responders.
- **Not covered:** group chats, media messages, and behaviour under load.

## [1.1.0] — 2026-07-31

### Fixed

- **Which bot answered a message inside an open flow depended on plugin enable order.** This plugin ran
  at the default hook priority, the same one other auto-reply plugins use by default, so whether this
  plugin's in-flow menu or a co-installed bot's reply won for a given message could change across a
  restart or re-enable — even though this plugin already correctly claimed only the messages it answered.
  It now registers at an explicit responder priority: after a command prefix, before a keyword bot, so the
  order is the same on every restart no matter which plugins are also installed.

## [1.0.8] — 2026-07-30

### Fixed

- **Stickers and voice notes drove the menu.** The inbound guard checked that `body` was a string but not
  that it had content, and a message with no text — a sticker, a voice note, an image sent without a
  caption — carries an empty one. (A captioned image does carry its caption, and still reaches the menu.) With the documented empty
  `trigger` a bare sticker started the flow; with a flow already open, a photo drew an "Invalid option"
  reply — and the plugin claimed the event, so a sibling auto-replier never saw it either. A message with
  no text content is now ignored outright.

## [1.0.7] — 2026-07-22

### Fixed

- **The menu-option rows are usable again.** Each option row rendered with its key field stretched
  across the full width, pushing the reply text and the row's own buttons outside the panel, where they
  were cut off and unreachable — so a menu could not be edited at all. The row now lays out as intended:
  a narrow key, the reply text filling the space, and the Remove and Sub-option buttons visible beside
  them.
- **The greeting placeholder no longer suggests typing `\n` for a line break.** It showed
  `Hi! Please choose:\n1. Hosting` literally, and a `\n` typed into the greeting is delivered to
  WhatsApp exactly as written rather than as a new line. The example is now shown across real lines.

### Added

- **The editor follows the dashboard's dark theme.** It was always light, so on a dark dashboard it
  appeared as a bright panel in the middle of the dialog. It now uses whichever theme the dashboard
  reports (OpenWA 0.10.5+), and falls back to the operating system preference on older versions.

## [1.0.6] — 2026-07-18

### Fixed

- **Per-session config overrides are now honored at message time.** The hook previously read a config
  snapshot cached at enable, so a per-session override (e.g. a different menu tree for one WhatsApp number)
  set via the dashboard after enable was ignored. The hook now re-parses `ctx.config` on each event, which
  the host resolves to the firing session's slice. An invalid config for a session is logged and skipped
  instead of driving the flow with a stale snapshot. The enable-time fail-fast validation is retained.

## [1.0.5] — 2026-07-02

### Fixed

- The periodic expired-state sweep now re-reads an entry immediately before deleting it, so a flow
  re-created by a message in the gap between the scan and the delete is not wiped.
- Restored the `## [1.0.3]` changelog heading that a prior edit dropped (its entries had been folded
  under 1.0.4 by mistake).

### Changed

- `onEnable` clears any existing sweep timer before starting a new one (defensive idempotency, matching
  the other timer-using plugins).

## [1.0.4] — 2026-07-02

### Fixed

- **Group flows are now per-participant.** With `respondInGroups` enabled, flow state was keyed by the
  group chat alone, so every member shared one menu position — one member's reply advanced or reset the
  flow another member was walking. State is now scoped to `(chat, sender)` in a group; 1:1 chats are
  unchanged. (Existing in-progress group flows reset once on upgrade.)
- **Abandoned flow states are reclaimed.** Per-state expiry only ran when a chat messaged again, so a
  flow started and then abandoned lingered in plugin storage indefinitely. The plugin now sweeps expired
  states on enable and periodically (every 30 min; state TTL is 15 min).

## [1.0.3] — 2026-06-23

### Fixed

- Messages for the same chat are now processed one at a time (per-session/chat lock), closing a race
  where two near-simultaneous messages could read the same flow state and produce lost or duplicated
  navigation (e.g. a double greeting or a resurrected leaf). The bounded invalid-path re-process runs
  inside the lock to avoid self-deadlock, and the lock map self-evicts when a chat's queue drains.
- If a config edit leaves an in-flight user parked on a node that no longer has options, the flow now
  ends cleanly instead of replying "Invalid option" on every message until the 15-minute expiry.

## [1.0.2] — 2026-06-23

### Added

- Localized dashboard text (`name`, `description`, config field titles) for es, fr, it, ar, he, te, zh-CN,
  zh-HK via `manifest.i18n`. English remains the default + fallback. Translations are machine-generated;
  human review recommended for ar/he/te.

## [1.0.1] — 2026-06-23

### Fixed

- Menu lookups now use `Object.hasOwn`, so a message whose text is an `Object.prototype` member name
  (e.g. `constructor`, `toString`, `__proto__`) is treated as an invalid option instead of falsely matching
  an inherited member (which previously replied with empty text and ended the flow). Option keys that
  collide with such names are also accepted by config validation (no more spurious "duplicate" error);
  a literal `__proto__` option key is rejected explicitly.

## [1.0.0] — 2026-06-23

First release. Built against the OpenWA v0.7 plugin contract.

### Added

- Interactive menu flow: a trigger word (or any message) sends a greeting + numbered menu; replies select
  options and traverse a configurable menu tree; leaf nodes end the flow.
- Per-(session, chat) state in `ctx.storage`, expiring after 15 minutes of inactivity; the trigger word
  restarts an active flow. Invalid stored paths (after a config edit) reset safely with bounded re-processing.
- The flow definition is read from the resolved per-session `ctx.config` (the platform owns activation),
  and applies live via `onConfigChange`.
- `respondInGroups` toggle (default off — direct chats only). Declares only `messages:send`.
- A visual flow-tree config editor (`configUi`).
