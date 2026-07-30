# Changelog

All notable changes to the Typebot Connector plugin are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.1] — 2026-07-30

First release verified against a live server: a self-hosted Typebot v3.17.2 driven over real WhatsApp
through OpenWA 0.12.1, rather than against unit tests alone. That run is what found the first item.

### Fixed

- **`{{waNumber}}` reached every flow empty.** It read `msg.senderPhone`, which the host assigns *after*
  the `message:received` chain has run, and then only for `@lid` senders — so a hook handler never
  observes it set. Measured on the live server: the same published flow rendered `num=[628999000]` when
  its Chat API was called directly, and `num=[]` on the identical message routed through this plugin. Any
  flow branching on the contact's number therefore took the empty branch for every contact, silently. The
  value now falls back to the digits of the sender JID — the participant's JID in a group, where
  `from`/`chatId` is the group rather than a person. A `@lid` sender still yields an empty string on
  purpose: a privacy id's numeric part is not a phone number, and feeding it to a CRM lookup as one would
  be worse than feeding it nothing.
- **One failed part silenced the rest of the turn.** The send loop had no per-part isolation, so a single
  failure — an unreachable `mediaHost`, a host media path that refuses the envelope — aborted every part
  after it. Because state is persisted *before* sending (deliberately: the Typebot server has already
  advanced), the contact was left with a half-delivered turn while the plugin believed the prompt was
  out, and their next message was matched against an input they never saw. Each part is now isolated and
  a failure is logged.
- **Sessions abandoned mid-flow were never cleaned up.** A completed flow clears its own row, but a
  contact who simply stops replying leaves one behind forever. Beyond disk, that has a running cost:
  OpenWA re-measures a plugin's storage quota on every write by stat-ing every key it owns, so abandoned
  rows make each later turn slower, permanently. Rows idle past `sessionTimeoutMinutes` are now swept at
  most hourly, driven by traffic rather than a timer so a disabled plugin leaves nothing running.

### Documentation

- A text input's **placeholder is sent to the contact as the prompt** — WhatsApp has no input field to
  show it in. This is intended, but it means a placeholder written for a web form ("Type here…") reads as
  a nonsense chat message. Write placeholders as prompts.
- `apiHost` **must be https**, which the plugin already enforces at enable. A self-hosted Typebot reached
  over plain http cannot be used: the host admits an operator-configured host only when it is https, and
  the token this plugin sends would otherwise travel in clear text. Front a self-hosted instance with TLS.

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
