# Changelog

All notable changes to the **AI Responder** plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this plugin adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The version here always matches `manifest.json`'s `version`.

## [Unreleased]

## [0.1.2] - 2026-10-28

### Changed

- Align plugin metadata with OpenWA v0.26.0.
- Document that a per-session override that points `apiBaseUrl` at another origin must also set `apiKey`, which OpenWA 0.26.0 no longer inherits.

## [0.1.1] - 2026-10-15

### Changed

- Align plugin metadata with OpenWA v0.25.0 and complete dashboard translations for all supported locales.

## [0.1.0] - 2026-09-24

### Added

- Answers inbound WhatsApp messages with a reply from any OpenAI-compatible Chat Completions API
  (`apiBaseUrl`, `apiKey`, `model`, optional `systemPrompt`), sent as a quoted reply.
- Single-turn: each message is sent on its own, with no conversation history.
- Replies converted from Markdown to WhatsApp formatting.
- Runs at hook priority 97, after every other responder, and claims each message it answers.
- The provider call runs off the hook, so a slow provider never delays message delivery.
- Hourly limits per chat (`maxRepliesPerChatPerHour`) and per session (`maxRepliesPerSessionPerHour`),
  kept in memory, and at most eight provider calls open at once.
- Bounded cost per message: input cut to `maxInputChars`, output capped by `maxOutputTokens`, request
  timeout `timeoutMs`.
- Skips its own messages, contact cards, polls, orders, product cards, locations, channels, broadcasts,
  messages delivered more than five minutes late, and redeliveries; groups only with `respondInGroups`.
- `apiBaseUrl` must be https; http only for a loopback host.
