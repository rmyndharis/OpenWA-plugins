# Changelog

All notable changes to the **Group Auto-Translation** plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this plugin adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The version here always matches `manifest.json`'s `version`.

## [Unreleased]

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
