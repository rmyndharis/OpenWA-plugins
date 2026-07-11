# Changelog

All notable changes to HTTP Action Bot are listed here. Versions follow [Semantic Versioning](https://semver.org/),
and the top entry's version must match `manifest.json`.

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
