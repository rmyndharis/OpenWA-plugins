# Changelog

All notable changes to the Typebot Connector plugin are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- **The manifest's `sdkVersion` is a string again.** It had been changed to the number `1`, while the
  host types it as a string (`sdkVersion.split('.')` on hosts that read it). Harmless here only
  because this plugin declares no ingress route, so the host never reads the field today — but it was
  the same regression that broke loading for the ingress plugins, and a future host that reads
  `sdkVersion` unconditionally would fail this plugin at load too.
- **A malformed upstream response no longer throws out of the hook.** `messages` and `clientSideActions`
  were only checked for null, so a Typebot server returning either as an object or a string raised a
  TypeError inside the message handler. They are array-checked now and degrade to no bubbles.



### Changed

- **Compatibility re-verified against OpenWA v0.19.0** (testedOpenWAVersion 0.14.0 → 0.19.0). The
  manifest passes the v0.19.0 host's load-time validation (manifest, ingress and main-entry
  checks) and the built bundle loads under the loader contract. No capability surface this plugin
  uses changed between 0.14 and 0.19; the v0.19 breaking changes are host-side (API key length,
  removed REST endpoints, the plain-http install pin) and do not touch this plugin.

## [0.2.2] — 2026-08-12

### Changed

- **Declared the `storage:use` permission.** The plugin keeps one small record per conversation in
  plugin storage — the Typebot session id, what input the bot is waiting for, and when the chat was
  last active. Typebot owns the flow itself; this record is the only thing tying a WhatsApp chat to
  its running Typebot session. OpenWA is moving `ctx.storage` behind a permission the manifest has to
  declare, and without it that record cannot be read or written: every reply from a contact would be
  treated as a brand-new conversation and restart the flow from the top, forever. Declaring the
  permission changes nothing on the hosts you run today — an unrecognized permission is ignored — so
  0.2.2 behaves exactly like 0.2.1.

## [0.2.1] — 2026-07-31

### Fixed

- **Uploading a file at a Typebot file-upload step got stuck in a loop.** The photo or document reached
  storage every time, but the flow answered "Invalid message. Please, try again." and asked for the same
  file again, indefinitely. A file-upload step expects the uploaded file's URL as the answer itself, while
  a text step that merely allows an attachment expects the typed answer with the file attached alongside
  it — the plugin was sending the second shape for both, so a file-upload step never accepted what it was
  sent. Each is now answered the way it expects, and a file-upload step advances the flow like any other.

### Verified

- **Confirmed fixed against a live self-hosted Typebot install.** On 2026-07-31, a real WhatsApp photo was
  smoke-tested end-to-end through OpenWA 0.12.1 against a self-hosted Typebot v3.17.2 instance: the upload
  reached storage and the file-upload step advanced the flow to the next block.

## [0.2.0] — 2026-07-31

### Fixed

- **A chat in scope for this bot could also draw a reply from another auto-reply plugin.** This plugin
  returns before the flow turn finishes running, so it never claimed the message — meaning any
  co-installed bot behind it in the hook chain would also answer. It now claims a chat as soon as it
  determines the chat is in scope (the same check `handleTurn` re-applies before acting), so an outage on
  the Typebot side produces silence for that message rather than a different plugin answering on this
  bot's behalf.
- **This plugin now registers at an explicit responder priority**, after a command prefix and any
  keyword-based bot, since it auto-starts a flow for every in-scope chat and should not pre-empt a more
  specific trigger.

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
- **Only a real user JID becomes a phone number.** The JID→digits helper first shipped in this
  release denylisted `@lid`, which is not enough: a group, channel or broadcast JID has a numeric
  local part too, so those were emitted as if they were phone numbers — worse than the empty value
  they replaced. It now allowlists `@c.us` / `@s.whatsapp.net` and strips the `:device` suffix
  Baileys can append. Caught in self-review before release.
- **One failed part silenced the rest of the turn.** The send loop had no per-part isolation, so a single
  failure — an unreachable `mediaHost`, a host media path that refuses the envelope — aborted every part
  after it. Because state is persisted *before* sending (deliberately: the Typebot server has already
  advanced), the contact was left with a half-delivered turn while the plugin believed the prompt was
  out, and their next message was matched against an input they never saw. Each part is now isolated and
  a failure is logged.
- **Rows from sessions that stop sending entirely are reclaimed too.** The abandoned-session sweep is
  scoped to the session whose message triggered it, because its threshold comes from that session's
  config — but that leaves a disabled or deleted tenant's rows with nothing to list them, and every
  stored key is stat-ed on every write, so they tax every other session's turns forever. A second,
  unscoped pass removes rows idle past a week, a threshold no per-session timeout plausibly exceeds.
- **A group message with no author is skipped instead of merged.** Group flows are keyed per sender, and
  an authorless message fell back to a shared `unknown` key — so every such participant drove the SAME
  Typebot session and one contact's answer advanced another contact's flow. There is no safe way to
  attribute it, so the turn is skipped.
- **The abandoned-session sweep is scoped to one WhatsApp session.** Its threshold comes from the
  config resolved for the session whose message triggered it, and `sessionTimeoutMinutes` is
  overridable per session — so an unscoped sweep applied one session's (possibly 5-minute) timeout
  to every other session's rows and deleted flows still live under their own, longer, timeout: a
  contact halfway through a long form would have silently restarted at question one. The sweep and
  its throttle are now both per session. Caught in self-review before release.
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
