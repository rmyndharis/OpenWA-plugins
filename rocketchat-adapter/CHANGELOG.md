# Changelog

All notable changes to the **Rocket.Chat Adapter** plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this plugin adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-11-24

### Changed

- Verify compatibility with OpenWA `0.32.1` and bump `testedOpenWAVersion`.

### Fixed

- Pass `sessionId` to `ctx.net.fetch` so background pump retries resolve `allowConfigHosts` against the configured session.
- Register the bridge on enable and config change even when `deadLetterAction` is `"none"`.
- Strip trailing lone UTF-16 high surrogates when truncating visitor display names.
- Ignore malformed omnichannel webhook payloads without triggering ingress retries or failure counts.

## [0.1.1] - 2026-11-21

### Changed

- Align plugin metadata with OpenWA v0.31.0.
- Document delivery after an ambiguous send, the inline webhook budget with the host queue off, and the 503 preflight.

### Fixed

- Relay a text message whose id the engine could not read, under a stable id derived from its chat, send time and text.

## [0.1.0] - 2026-11-12

### Added

- Development preview of a text-only, one-to-one WhatsApp and Rocket.Chat Omnichannel adapter (`baseUrl` HTTPS origin, `sessionId`, optional `department`).
- Session and destination scoped visitor credentials and room mappings with LRU eviction of inactive contacts (`MAX_CHATS = 500`).
- Visitor phone enrichment from telephone JIDs and best-effort `@lid` canonical/contact resolution (`engine:read`, OpenWA 0.30.0+).
- Bounded persistent inbound retry queue drained per chat with up to 4 concurrent workers, deterministic Rocket.Chat message IDs, ambiguous-send history reconciliation, and independent dead-letter retention (100 entries, 7 days) with idempotent `replay` and `clear` controls.
- Host-verified shared-secret webhook ingress (`omnichannel`) with outbound reply deduplication and filtering of unrelated rooms, visitor echoes, transcripts, attachments, edits, and internal notes.
- Dashboard translations across all 14 supported non-English locales.
