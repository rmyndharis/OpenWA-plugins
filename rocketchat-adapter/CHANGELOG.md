# Changelog

All notable changes to the **Rocket.Chat Adapter** plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this plugin adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-12

### Added

- Development preview of a text-only, one-to-one WhatsApp and Rocket.Chat Omnichannel adapter (`baseUrl` HTTPS origin, `sessionId`, optional `department`).
- Session and destination scoped visitor credentials and room mappings with LRU eviction of inactive contacts (`MAX_CHATS = 500`).
- Visitor phone enrichment from telephone JIDs and best-effort `@lid` canonical/contact resolution (`engine:read`, OpenWA 0.30.0+).
- Bounded persistent inbound retry queue drained per chat with up to 4 concurrent workers, deterministic Rocket.Chat message IDs, ambiguous-send history reconciliation, and independent dead-letter retention (100 entries, 7 days) with idempotent `replay` and `clear` controls.
- Host-verified shared-secret webhook ingress (`omnichannel`) with outbound reply deduplication and filtering of unrelated rooms, visitor echoes, transcripts, attachments, edits, and internal notes.
- Dashboard translations across all 14 supported non-English locales.
