# Changelog

All notable changes to the **FAQ / Auto-Reply Bot** plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this plugin adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The version here always matches `manifest.json`'s `version`.

## [Unreleased]

## [0.1.2] — 2026-06-23

### Changed

- `regex` rules are now validated for catastrophic-backtracking risk at parse time. A pattern that
  nests an unbounded quantifier inside another (e.g. `(a+)+`, `(\w+\s?)*`) is skipped with a warning
  like any other unusable pattern, so a single rule can no longer stall message handling on a crafted
  input. Ordinary patterns — including lookahead and backreferences — are unaffected.
- The per-chat fallback cooldown now tracks usage as least-recently-used: re-inserting a chat on each
  reply so a busy chat's cooldown is preserved when the map reaches its cap, instead of being evicted
  by first-seen order.

## [0.1.1] — 2026-06-23

### Added

- Localized dashboard text (`name`, `description`, config field titles) for es, fr, it, ar, he, te, zh-CN,
  zh-HK via `manifest.i18n`. English remains the default + fallback. Translations are machine-generated;
  human review recommended for ar/he/te.

## [0.1.0] — 2026-06-23

First release. Built against OpenWA v0.6.1.

### Added

- Auto-reply to inbound messages from operator-defined rules with per-rule matching:
  `contains` / `exact` (case-insensitive) and `regex` (compiled with the `i` flag). First matching
  rule wins; replies are sent as a quoted reply to the triggering message.
- Optional configurable fallback reply when no rule matches (empty = stay silent), throttled per chat
  by `fallbackCooldownSec`.
- `respondInGroups` toggle (default off — direct chats only).
- Invalid `regex` rules are skipped with a warning; a structurally invalid `rules` config fails fast.
