# Changelog

All notable changes to the **Chat Flow** plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this plugin adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The version here always matches `manifest.json`'s `version`.

## [Unreleased]

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
