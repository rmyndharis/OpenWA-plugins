# Changelog

All notable changes to HTTP Action Bot are listed here. Versions follow [Semantic Versioning](https://semver.org/),
and the top entry's version must match `manifest.json`.

## [Unreleased]

## [0.2.8] - 2026-09-05

### Fixed

- **A WhatsApp Channel or broadcast-list post can no longer fire a backend request.** The only
  chat-scope gate was the group flag, and a `@newsletter` post arrives flagged as a non-group chat, so
  a channel this account merely follows could match an action and perform a real, irreversible write
  on behalf of a sender the operator has no relationship with.
- The README described the handler as always returning `{ continue: true }`; it claims a message that
  matched an action, so a keyword bot or a flow does not answer the same command.

### Changed

- **Verified against OpenWA v0.23.4** (testedOpenWAVersion 0.23.3 -> 0.23.4).

## [0.2.7] - 2026-08-25

### Changed

- Dedup markers are stored in a fixed number of sharded keys rather than one key per answered message.
  The host re-measures its storage quota by stat-ing every key on every write, synchronously, on the
  gateway event loop, so a busy install (about 86,000 markers inside the 3-day window at 20 commands a
  minute) made every write in every plugin on the gateway stat that many files. Markers written before
  this are still honoured and are drained by the existing hourly sweep, so no command is re-fired.
- Enabling the plugin now warns when an action sets `request.headers`. Those values are returned
  unmasked by the plugins API: the host redacts config per schema field, and every action lives inside
  one `actions` field, so marking it secret would hide the action definitions themselves. Credentials
  belong in the Token / API key field.

### Fixed

- A poll or a shared contact card no longer triggers an action. OpenWA 0.23.2 fills the message body for
  both, so a poll titled with a configured prefix could fire a real request against the configured
  backend and claim the message. Business button and list replies still trigger actions.
- A whitespace-only body is ignored, matching the guard the other command plugins use.

### Changed

- **Verified against OpenWA v0.23.3** (testedOpenWAVersion 0.23.0 → 0.23.3).

## [0.2.6] - 2026-08-20

### Changed

- **Verified against OpenWA v0.23.0** (testedOpenWAVersion 0.22.0 → 0.23.0).

## [0.2.5] - 2026-08-19

### Changed

- **Verified against OpenWA v0.22.0** (testedOpenWAVersion 0.20.0 → 0.22.0).

## [0.2.4] - 2026-08-16

### Changed

- **Verified against OpenWA v0.20.0** (testedOpenWAVersion 0.19.0 → 0.20.0); the catalog download URL now pins #sha256= for production installs.

## [0.2.3] — 2026-08-15

### Fixed

- **The manifest's `sdkVersion` is a string again.** It had been changed to the number `1`, while the
  host types it as a string (`sdkVersion.split('.')` on hosts that read it). Harmless here only
  because this plugin declares no ingress route, so the host never reads the field today — but it was
  the same regression that broke loading for the ingress plugins, and a future host that reads
  `sdkVersion` unconditionally would fail this plugin at load too.

### Changed

- **Compatibility re-verified against OpenWA v0.19.0** (testedOpenWAVersion 0.14.0 → 0.19.0). The
  manifest passes the v0.19.0 host's load-time validation (manifest, ingress and main-entry
  checks) and the built bundle loads under the loader contract. No capability surface this plugin
  uses changed between 0.14 and 0.19; the v0.19 breaking changes are host-side (API key length,
  removed REST endpoints, the plain-http install pin) and do not touch this plugin.

## [0.2.2] — 2026-08-12

### Changed

- **Declared the `storage:use` permission.** Answered commands are recorded in plugin storage for
  three days, and that record is what makes a command idempotent: if the host redelivers a message,
  the marker is what stops the REST call being made a second time. OpenWA is moving `ctx.storage`
  behind a permission the manifest has to declare, and without it those markers cannot be written or
  read. This plugin's job is to cause side effects in someone else's system, so losing idempotency
  does not degrade the plugin — it means one WhatsApp command can create two orders, two tickets, or
  two charges. Declaring the permission changes nothing on the hosts you run today: an unrecognized
  permission is ignored, so 0.2.2 behaves exactly like 0.2.1.

## [0.2.1] — 2026-08-01

### Changed

- **Status promoted from `beta` to `stable`.** No behaviour changed in this release. A manual install
  smoke on a real OpenWA 0.12.1 host — the one check that cannot be automated — has now been run in
  full and passed: install from package, configure, and enable; a POST command with path and JSON-body
  templating (reply carried the templated body, the sender's phone number resolved correctly, the
  configured bearer credential reached the upstream); a command against an upstream 404 (the configured
  not-found template was used); a command against an upstream 500 (the configured error template was
  used); disable/re-enable (configuration survived, a command worked afterwards); and a host restart
  (the plugin came back enabled and a command was confirmed working afterwards). With another
  responder plugin installed alongside, commands were answered by this plugin and non-command messages
  went to the other plugin, confirming the co-installation ordering behaves as documented.

## [0.2.0] — 2026-07-31

### Fixed

- **A command could draw a reply from another auto-reply plugin too.** This plugin returns before its
  action finishes running, so it never claimed the message — meaning any co-installed bot behind it in
  the hook chain would also answer the same command. It now claims a message as soon as it matches one of
  the configured commands, so a command addressed to this plugin only ever gets this plugin's answer.
- **This plugin now registers first among responders.** A command prefix is the most specific trigger a
  responder can have, so it now runs ahead of keyword bots and flows, at an explicit priority instead of
  the registration-order default.

## [0.1.2] — 2026-07-30

### Fixed

- **`{{sender.phone}}` was empty for every sender.** It read `msg.senderPhone`, which the host assigns
  *after* the `message:received` chain has run — and then only for `@lid` senders — so a hook handler
  never observes it set. A template using it as a path segment requested an empty segment and got a 404,
  which surfaced as the `notFoundTemplate` with nothing logged. The number is now derived from the sender
  JID, whose user part *is* the MSISDN for a plain chat. A `@lid` sender still yields an empty value on
  purpose: a privacy id's numeric part is not a phone number, and sending it upstream as one would be
  worse than sending nothing.
- **Only a real user JID becomes a phone number.** The JID→digits helper first shipped in this
  release denylisted `@lid`, which is not enough: a group, channel or broadcast JID has a numeric
  local part too, so those were emitted as if they were phone numbers — worse than the empty value
  they replaced. It now allowlists `@c.us` / `@s.whatsapp.net` and strips the `:device` suffix
  Baileys can append. Caught in self-review before release.
- **`{{sender.id}}` was the group in group chats.** In a group `msg.from` is the group JID; `author` is
  the participant who actually sent the message. Every member therefore resolved to the same value, so a
  per-user lookup or an authorization check written against `sender.id` silently applied to the group.
- **A failed dedup read dropped the command without a trace.** The check is fail-closed by design, but a
  storage error was indistinguishable from a genuine duplicate: no reply, no error template, and no log
  line. It stays fail-closed and now says so.
- **An empty rendered reply was sent as an empty bubble.** A template referencing a field the response
  does not carry renders to an empty string, and the host coerces the envelope rather than rejecting it.
  The error template is now substituted, and the empty render is logged as the template bug it is.
- **The empty-reply fallback can no longer swallow the reply.** Rendering the error template can throw
  (a too-deep path, a prototype key, too many placeholders); outside a try/catch that rejected out of the
  handler, so the contact got nothing at all where previously an empty bubble was at least sent and the
  message marked seen. It degrades to the built-in default now.
- **An `exact` trigger missed a trailing space.** Mobile keyboards routinely append one after an
  autocorrected word, so `ping ` did not match a `ping` trigger. The `exact` comparison is now trimmed;
  the `prefix` arm still slices the original body, so argument positions are unchanged.
- **README claimed a 0.8.7 floor and a `development` status**, contradicting the manifest's 0.8.0 and
  `beta` on the same page. 0.8.0 is the correct floor — it is the release that introduced both
  `conversation:send` and `net.allowConfigHosts`.

## [0.1.1] — 2026-07-27

### Fixed
- **`minOpenWAVersion` corrected from 0.8.7 to 0.8.0.** Both capabilities http-action relies on — `conversation:send` and `net.allowConfigHosts` — shipped in OpenWA 0.8.0 (the Integration Fabric release). The 0.8.7 floor was overstated and refused an install on servers that would in fact run the plugin correctly.

## [0.1.0] — 2026-07-11

### Added
- Plugin scaffold: `manifest.json`, `IPlugin` lifecycle (`onEnable`, `healthCheck`), `message:received` hook with off-dispatch handling and inbound guards (`fromMe`, empty body, missing ids, group opt-in).
- Config layer (`config.ts`): fixed-https `baseUrl` (an `allowConfigHosts` key, required — no code-side default), server-relative path validation (rejects protocol-relative `//`, absolute URLs, fragments, control/null chars), dangerous-header blocklist (hop-by-hop + `x-forwarded-*`), CRLF injection rejection, `actions` JSON-string parsing, per-action structural validation, optional `bodyTemplate` for POST.
- Template engine (`url-template.ts`): prototype-safe dot-path access, `renderText` (replies), `renderPath` (URL-encoded segments), `renderJson` (JSON-safe body), bounded path depth + placeholder count.
- HTTP client (`client.ts`): fixed-origin URL build, encoded query, auth (none/bearer/apikey), rendered headers, `application/json` POST with re-parsed body, 256 KiB response cap, invalid-JSON guard. Mirrors `ctx.net.fetch(url, init)`.
- Matcher (`matcher.ts`): `exact`/`prefix` + case toggle + quoted-argument parsing, first-match-wins.
- Handler (`handleMessage`): match → fetch → status mapping (2xx/404/other) → render → `conversations.send` (quoted text reply), with default templates and a 4000-char reply cap.
- Reliability (`reliability.ts`): storage-backed idempotency (`claim`, fail-closed, 3-day TTL) + throttled `prune` so storage can't grow unbounded + in-memory per-chat `allowCooldown` (fail-open, LRU-capped).
- Test suites for every module (node:test); passes typecheck, `catalog:check`, build, and the loader contract. Order-status, stock-lookup, and ticket-creation use cases run end-to-end through the real message path.
