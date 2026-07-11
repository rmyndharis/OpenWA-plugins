# Changelog

All notable changes to HTTP Action Bot are listed here. Versions follow [Semantic Versioning](https://semver.org/),
and the top entry's version must match `manifest.json`.

## [0.1.0] — 2026-07-11

### Added
- Initial scaffold: `manifest.json`, `IPlugin` lifecycle (`onEnable`, `healthCheck`), `message:received` hook with off-dispatch handling and inbound guards (`fromMe`, empty body, missing ids, group opt-in).
- Security-critical config layer (`config.ts`): fixed-https `baseUrl` (an `allowConfigHosts` key, required — no code-side default), server-relative path validation (rejects protocol-relative `//`, absolute URLs, fragments, control/null chars), dangerous-header blocklist (hop-by-hop + `x-forwarded-*`), CRLF injection rejection, `actions` JSON-string parsing, per-action structural validation.
- Adversarial test suite for the config layer (`config.test.ts`).
