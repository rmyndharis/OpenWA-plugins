# Changelog

All notable changes to the **Google Sheets Logger** plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this plugin adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The version here always matches `manifest.json`'s `version`.

## [Unreleased]

## [0.2.2] — 2026-06-23

### Fixed

- `flushIntervalSec` and `flushBatchSize` are now clamped to safe positive values. A non-numeric or
  zero/negative interval previously coerced to `NaN`, which made the flush timer fire roughly every
  millisecond (a hot-loop that burns CPU and Google Sheets API quota). Invalid values now fall back to
  the documented defaults (5s / 20 rows).

## [0.2.1] — 2026-06-23

### Added

- Localized dashboard text (`name`, `description`, config field titles) for es, fr, it, ar, he, te, zh-CN,
  zh-HK via `manifest.i18n`. English remains the default + fallback. Translations are machine-generated;
  human review recommended for ar/he/te.

## [0.2.0] — 2026-06-22

First packaged release. Built and reviewed against OpenWA v0.6.1.

### Added

- Buffered batch logging of WhatsApp message events (`message:received`, `message:sent`,
  `message:failed`, `message:ack`) to a Google Sheet via a service-account JWT (RS256, signed with
  Node's built-in `crypto` — no runtime dependencies).
- 14-column row schema: `timestamp, sessionId, event, direction, chatId, from, to, senderName,
  isGroup, type, body, messageId, ackStatus, error`.
- Retain-on-failure flushing: rows are kept and retried on a Sheets error; buffer is capped at 5000
  rows (oldest dropped past the cap, with a warning) and persisted to `ctx.storage` across restarts.
- CSV / Google Sheets formula-injection neutralization, plus `valueInputOption=RAW` writes.
- Plugin version surfaced at runtime — in the enable log line and the `healthCheck` message — baked
  from `manifest.json` at build time.

### Changed

- Formula-injection guard split: ID/enum cells (chatId, from, to, messageId, status, type) keep the
  full guard (`= + - @`); free-text cells (body, senderName, error) guard only `= @`, so legitimate
  content like a phone number (`+62812…`) or a negative number is no longer prefixed with a quote.

### Fixed

- Data-loss race on disable: `onDisable` now awaits an in-flight flush (the flush guard is a Promise,
  not a boolean), so rows restored after a failed flush are persisted instead of being overwritten by
  an empty buffer.
- `flushBuffer` is safe against concurrent buffer mutation — it takes ownership of the batch before
  awaiting and restores it ahead of newer rows on failure.
- `onConfigChange` drains the buffer to the current Sheets client before swapping it on a
  spreadsheet/credential rotation, so pre-rotation rows land in the sheet they belong to.
