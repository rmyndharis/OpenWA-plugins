# Changelog

All notable changes to the **Chat Flow** plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this plugin adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The version here always matches `manifest.json`'s `version`.

## [Unreleased]

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
