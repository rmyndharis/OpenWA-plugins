# Changelog

All notable changes to the **After-Hours Auto-Reply** plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this plugin adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The version here always matches `manifest.json`'s `version`.

## [Unreleased]

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
