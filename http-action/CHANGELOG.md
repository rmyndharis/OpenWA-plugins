# Changelog

All notable changes to HTTP Action Bot are listed here. Versions follow [Semantic Versioning](https://semver.org/),
and the top entry's version must match `manifest.json`.

## [0.1.2] — 2026-07-30

### Fixed

- **`{{sender.phone}}` was empty for every sender.** It read `msg.senderPhone`, which the host assigns
  *after* the `message:received` chain has run — and then only for `@lid` senders — so a hook handler
  never observes it set. A template using it as a path segment requested an empty segment and got a 404,
  which surfaced as the `notFoundTemplate` with nothing logged. The number is now derived from the sender
  JID, whose user part *is* the MSISDN for a plain chat. A `@lid` sender still yields an empty value on
  purpose: a privacy id's numeric part is not a phone number, and sending it upstream as one would be
  worse than sending nothing.
- **`{{sender.id}}` was the group in group chats.** In a group `msg.from` is the group JID; `author` is
  the participant who actually sent the message. Every member therefore resolved to the same value, so a
  per-user lookup or an authorization check written against `sender.id` silently applied to the group.
- **A failed dedup read dropped the command without a trace.** The check is fail-closed by design, but a
  storage error was indistinguishable from a genuine duplicate: no reply, no error template, and no log
  line. It stays fail-closed and now says so.
- **An empty rendered reply was sent as an empty bubble.** A template referencing a field the response
  does not carry renders to an empty string, and the host coerces the envelope rather than rejecting it.
  The error template is now substituted, and the empty render is logged as the template bug it is.
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
