# Changelog

All notable changes to the **FAQ / Auto-Reply Bot** plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this plugin adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The version here always matches `manifest.json`'s `version`.

## [Unreleased]

## [0.2.6] - 2026-08-25

### Fixed

- **Ambiguous repeated alternations are rejected at parse time.** `(a|a)*`, `(a|ab)+`,
  `^([a-z]|[a-z0-9])+$` and `^(\w|\d)+$` all let the regex engine consume the same text more than one
  way, which is exponential: the third takes 259 ms against 23 characters and over a minute against 31,
  well inside the body cap. One short message from any stranger pinned the plugin worker, and because a
  running regex cannot be interrupted, every later message queued behind it and the plugin stopped
  answering. Unambiguous alternations such as `(one|two|three)+` are unaffected, including where two
  branches share a first letter.
- A matched rule now answers the same chat at most once every 10 seconds. A rule whose reply also
  matches its own pattern is a fixed point, and a colliding autoresponder on the other end traded
  messages with it at full rate. Rules are throttled independently, so different questions still get
  their own answers.

- A shared contact card or a poll no longer matches a rule or draws `fallbackReply`. OpenWA 0.23.2 fills
  the message body for both, and a vCard is free text (name, organization, notes, numbers) that readily
  matches a `contains` or `regex` rule. Business button and list replies are still answered.

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

- **A message with no text no longer draws a fallback reply.** A sticker, image or voice note arrives
  with an empty body, so no rule could match it and the fallback answered a picture with "I did not
  understand" — and claimed the event, so a plugin that could handle media never saw it.
- **A failed fallback send no longer silences the chat for a whole cooldown window.** The cooldown slot
  is claimed before the send, so a send that threw spent the window on a reply that never arrived. The
  slot is released on failure; a matched rule is retried on the next message the same way.
- **Two rule patterns that could freeze the plugin are now rejected.** The safety analyser reasoned that
  a small bounded repeat is bounded by its constant, which holds for a variable-width body but not for an
  unbounded one: `(a+){3}` expands to `a+a+a+` and backtracks exponentially. It also treated any group as
  breaking a run of adjacent unbounded quantifiers, but a group that can match empty does not — so
  `.*(x?).*(x?).*` was `.*.*.*` in disguise. Both are refused now. Patterns of the shape `(ab?){2}` and
  `.*(x).*(y).*`, which really are bounded, are still accepted.


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
  enabled alongside four other responder plugins (including chat-flow and after-hours) and driven by
  real messages from a second connected WhatsApp number. A message matching a configured keyword rule
  was answered by this plugin and by nothing else, confirming the 0.2.0 message-claiming and
  responder-priority fixes hold with a full set of co-installed responders.
- **Not covered:** group chats, media messages, and behaviour under load.

## [0.2.0] — 2026-07-31

### Fixed

- **A matched rule or fallback reply could draw a second answer from another auto-reply plugin.** This
  plugin knew whether it had replied but never acted on it, so a co-installed bot behind it in the hook
  chain could answer the same message a second time. It now claims a message whenever it actually sends a
  reply — for a matched rule or the fallback — and never claims when nothing was delivered, so a failed
  send or an unmatched message still leaves the next plugin free to answer.
- **This plugin now registers at an explicit responder priority**, after a command prefix and an in-flow
  state machine, before a catch-all bot — instead of the registration-order default, which could put it
  ahead of or behind another responder depending on enable order.

## [0.1.8] — 2026-07-30

### Fixed

- **One pathological rule could hide every other skipped rule.** The startup warning joined all skipped
  regex patterns into a single line, and the host caps a log line at 8 KiB and drops the overflow — so a
  single very long pattern took the rest of the diagnostic with it. Each pattern is now truncated to 80
  characters before joining, so no single rule can crowd out the rest. With enough skipped rules the line
  can still reach the cap — the count at the front stays accurate either way, and is the signal to look
  at the config.

## [0.1.7] — 2026-07-18

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
