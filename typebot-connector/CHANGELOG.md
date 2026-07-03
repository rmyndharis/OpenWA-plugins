# Changelog

All notable changes to the Typebot Connector plugin are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] — 2026-07-03

Initial release — a WhatsApp ↔ Typebot bridge that runs a Typebot flow as the WhatsApp bot.

- **Auto-start:** every in-scope chat (1:1 and, by default, groups) starts a Typebot session on the first
  message and advances it on each reply, via Typebot's live Chat API (`startChat` / `continueChat`).
- **Rendering:** text bubbles (Markdown → WhatsApp formatting), image/video/audio bubbles (sent as native
  media), and `choice` / `picture choice` inputs rendered as a numbered list. A numeric reply is mapped back
  to the chosen option.
- **Inputs:** typed inputs (email/number/url/date/time/phone/rating) are passed through and validated by
  Typebot; `file input` accepts a WhatsApp media reply, uploads it to Typebot, and submits the file URL.
- **Lifecycle:** the session resets when the flow ends (no further input) or after an idle timeout;
  an expired server session restarts cleanly.
- **Runtime:** runs sandboxed in the plugin worker; the Typebot call is off-dispatch (never blocks the WA
  pipeline) and serialized per chat. No public URL or webhook required.

Requires OpenWA **≥ 0.8.2** with Integration SDK v1 (`net:fetch` + `conversation:send`) — media bubbles use
the media-send support added to `conversation.send` in 0.8.2.
