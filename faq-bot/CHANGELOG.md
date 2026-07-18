# Changelog

All notable changes to the **FAQ / Auto-Reply Bot** plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this plugin adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The version here always matches `manifest.json`'s `version`.

## [Unreleased]

### Fixed

- **Per-session config overrides are now honored at message time.** The hook previously read a config
  snapshot cached at enable, so a per-session override (e.g. a different rule set or fallback reply for one
  WhatsApp number) set via the dashboard after enable was ignored. The hook now re-parses `ctx.config` on
  each event, which the host resolves to the firing session's slice. An invalid config for a session is
  logged and skipped instead of replying with a stale snapshot. The enable-time fail-fast validation and the
  invalid-regex skip warning are retained.

## [0.1.6] — 2026-07-02

### Fixed

- **An empty character class (`[]` / `[^]`) no longer bypasses the regex safety screen.** The class
  parser treated a leading `]` as a literal member (POSIX), but in JavaScript `[]` is an empty class and
  `[^]` matches any char — so `[^](a+)+!` was mis-parsed as one atom and its catastrophic `(a+)+` tail
  slipped through and could pin the worker. The parser now follows JS class semantics. (Differential
  fuzzing confirms the screen rejects everything the pre-0.1.5 screen did, with no reintroduced hole.)

### Changed

- **Fewer false rejections of safe patterns.** Adjacent overlapping quantifiers are now rejected only at
  **3 or more** in a row (`.*.*.*`) — two adjacent (`.*.*`, `.*\d+`) is `O(n²)`, safe under the 1000-char
  cap, and is now allowed. A repeated variable-width group is rejected only when the repeat is unbounded
  or large (≥10, e.g. `(a?){40}`); a small bounded repeat like `(ab?){2}` or `(\d{2,4}){3}` is allowed.

## [0.1.5] — 2026-07-02

### Fixed

- The regex safety check now rejects two further catastrophic-backtracking classes it previously
  missed: **adjacent overlapping quantifiers** in one concatenation (e.g. `.*.*.*`, `\w*\w*` —
  polynomial) and a **group repeated `{n}`/`*`/`+` times whose body has a variable-width quantifier**
  (e.g. `(a?){40}` — exponential). A pattern that lands in either class is skipped with a warning like
  any other unusable pattern, so a crafted 1000-character message can no longer pin the plugin worker.
  Ordinary patterns — adjacent *disjoint* classes (`a*b*c*`, `order\s+\d+`), a wildcard separated by a
  literal (`.*urgent.*`), and fixed-width nesting (`(\d{2}){3}`) — are unaffected.

### Changed

- The README **Security** section now states accurately that the parse-time screen (not the sandbox
  hook timeout) is what bounds a runaway pattern, and notes the still-uncovered overlapping-alternation
  class (e.g. `(a|a)*`).

## [0.1.4] — 2026-06-24

### Changed

- The **Rules (JSON)** field now renders as a multi-line editor (manifest `textarea`) and its
  description carries a copy-pasteable example, so the expected JSON shape is obvious.

### Fixed

- A single rule object is now accepted and wrapped in an array automatically, instead of failing
  with "rules must be a JSON array" — pasting one `{ "mode", "pattern", "reply" }` just works.
- Invalid-rules errors now include a concrete example and a "use double quotes, not single" hint,
  so the common single-quote / unquoted-key mistakes are easy to correct.

## [0.1.3] — 2026-06-23

### Fixed

- The regex safety check now also rejects a nested unbounded quantifier hidden behind one or more
  wrapping groups (e.g. `((a+))+`, `(((a+)))*`). The previous check only inspected a group that was
  directly quantified, so an extra layer of parentheses could slip a catastrophic pattern through.
  Patterns that carry only a single quantifier (e.g. `((ab)+)`) are still accepted.

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
