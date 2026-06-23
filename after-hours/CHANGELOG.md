# Changelog

All notable changes to the **After-Hours Auto-Reply** plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this plugin adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The version here always matches `manifest.json`'s `version`.

## [Unreleased]

## [0.1.0] — 2026-06-23

First release. Built against OpenWA v0.6.2.

### Added

- Auto-reply with a configurable away/closing message to inbound messages received outside a per-day
  business-hours schedule (`mon`..`sun` → `"HH:MM-HH:MM"` or closed), interpreted in a configurable
  IANA `timezone`. Replies are quoted, and throttled per chat by `cooldownSec`.
- `respondInGroups` toggle (default off — direct chats only).
- A structurally invalid `schedule` (bad day/time, `open >= close`, all-closed) or an unknown
  `timezone` fails fast, surfacing as `ERROR` in the dashboard.
