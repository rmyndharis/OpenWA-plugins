# Changelog

All notable changes to the **Group Auto-Translation** plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this plugin adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The version here always matches `manifest.json`'s `version`.

## [Unreleased]

## [1.0.4] — 2026-06-25

### Fixed

- Translations now actually apply. The LibreTranslate client read the response with `res.json()`, but the
  sandboxed `ctx.net.fetch` returns the body as a string and provides no `.json()` method (functions can't
  cross the worker boundary) — so every call threw and failed open, a silent no-op. The client now parses
  `res.body` directly.

## [1.0.3] — 2026-06-23

### Fixed

- Participant lookups now reject prototype keys (`__proto__`, `constructor`, `prototype`) and test
  existence with `hasOwnProperty`, so a crafted participant/target id can no longer read or write
  `Object.prototype`.
- Concurrent messages for the same group are serialized through a per-(session, chat) lock, closing a
  load→mutate→save race that could duplicate the help announcement or drop a participant-language update.
  The lock map self-evicts when a chat's queue drains.
- A LibreTranslate `/translate` response without a string `translatedText` now fails the call (counted by
  the circuit breaker and excluded from the reply) instead of posting the literal text `undefined`.

## [1.0.2] — 2026-06-23

### Fixed

- Telugu (`te`) localization: the `libretranslateUrl` field title was left in English ("LibreTranslate URL");
  it is now localized to "LibreTranslate చిరునామా", matching the other locales.

## [1.0.1] — 2026-06-23

### Added

- Localized dashboard text (`name`, `description`, config field titles) for es, fr, it, ar, he, te, zh-CN,
  zh-HK via `manifest.i18n`. English remains the default + fallback. Translations are machine-generated;
  human review recommended for ar/he/te.

## [1.0.0] — 2026-06-23

First release. Built against the OpenWA v0.7 plugin contract.

### Added

- Auto-translation of group messages between participants' languages via a LibreTranslate backend, with
  in-chat `/tr` commands (help, status, on/off, setlang, auto, ignore/unignore, grant/revoke). Admin-gated
  via `ctx.engine.getGroupInfo`; disabled until enabled.
- All outbound calls go through the host's SSRF-guarded `ctx.net.fetch`; the LibreTranslate host must be in
  the manifest `net.allow` allowlist. Per-call timeout defaults to 4000ms (≤ the host hook budget), with a
  circuit breaker that backs off a flaky backend.
