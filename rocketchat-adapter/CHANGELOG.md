# Changelog

## [Unreleased]

### Fixed

- Separate bounded dead-letter retention from live capacity; add idempotent clear/replay controls.
- Ignore unrelated workspace rooms and reclaim inactive visitor mappings with LRU eviction.
- Drain due messages per chat with bounded concurrency and no provider I/O under the storage lock.
- Include phone numbers only for telephone JIDs; complete all supported translations.
- Resolve LID visitor phones through authoritative engine contact IDs/canonical mappings, with a bounded best-effort lookup that also enriches existing visitors (requires OpenWA 0.30.0 and engine:read).
- Require configured HTTPS origins instead of shipping a hard-coded laboratory grant.

## [0.1.0] - 2026-11-02

### Added

- Development preview of a text-only, one-to-one WhatsApp ↔ Rocket.Chat Omnichannel adapter.
- Session/destination-scoped visitor mappings, bounded persistent retries and deduplication.
- Host-verified shared-secret webhook ingress and filtering of visitor echoes/internal notes.

This version is a local development preview, not a published GitHub release.
