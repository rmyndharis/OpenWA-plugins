# Changelog

All notable changes to the Chatwoot Adapter plugin are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] — 2026-07-03

### Added

- **Reply/quote context is forwarded to Chatwoot.** Every relayed message now carries its WhatsApp id as
  `source_id`, and a reply carries `content_attributes.in_reply_to_external_id`, so a swipe-to-reply shows
  its quoted bubble in Chatwoot instead of a bare, context-less line. (#606)
- **Voice notes relay both ways.** Inbound WhatsApp voice notes are uploaded as Chatwoot voice messages
  (`is_voice_message`, `voice.ogg`); a voice note whose blob was dropped for size posts a short
  placeholder instead of an empty bubble. Outbound audio attachments from Chatwoot are sent back to
  WhatsApp as PTT voice notes, and image/video/file attachments are relayed as their native media type —
  previously any attachment without text was silently dropped. Requires OpenWA 0.8.3+. (#607)
- **Contact names self-heal for `@lid` chats.** A chat first seen from a privacy-id (`@lid`) sender is
  seeded in Chatwoot with the bare id; once a real WhatsApp display name arrives on a later message, the
  Chatwoot contact is renamed to it. Best-effort, only when the name actually changed, and never for
  group contacts. (#609)
- **Self-hosted Chatwoot guidance** in the README: `baseUrl` must be a public `https` URL (LAN/`localhost`
  are rejected by the SSRF guard), how to expose a self-hosted instance, and how to avoid 502/530 on large
  media uploads through a tunnel. (#609)

## [0.1.1] — 2026-07-02

### Fixed

- **Cross-tenant isolation for multi-account deployments.** The reverse conversation map and the
  Chatwoot-side idempotency markers were keyed by the Chatwoot conversation/message id alone. Because
  plugin storage is shared across every session and Chatwoot ids are per-account autoincrement, two
  instances bound to different Chatwoot accounts could collide — an agent reply could be delivered to the
  wrong WhatsApp session, or silently dropped. Both are now scoped by the delivery's WA session; a legacy
  unscoped key is kept so single-tenant and pre-upgrade conversations are unaffected.
- **A transient WhatsApp-send failure no longer drops an agent reply.** The outbound dedup marker was
  written before the send, so a momentary failure suppressed the retry. It is now written only after a
  successful send.
- **Attacker-controlled media filename/mimetype can no longer inject multipart parts** into the upload to
  the Chatwoot API — CR/LF (and a quote) are stripped from the part headers.
- **`baseUrl` is validated at enable time.** A non-https or credentialed `baseUrl` — which the host net
  allowlist rejects, silently failing every inbound relay — now fails fast when the plugin is enabled.
- **A malformed `conversation_updated` payload no longer retry-loops.** A non-object `changed_attributes`
  element is guarded instead of throwing a `TypeError`.

## [0.1.0] — 2026-07-02

Initial release — two-way WhatsApp ↔ Chatwoot sync.

- **WhatsApp → Chatwoot:** relays inbound messages (1:1 and groups) into a Chatwoot API-channel inbox as `incoming` messages, including media as attachments. Contacts are keyed on the WhatsApp JID (safe across WhatsApp's `@lid` migration); a group maps to a single synthetic contact with sender-prefixed messages.
- **Chatwoot → WhatsApp:** relays agent replies (`message_type: outgoing`, non-private) back to WhatsApp; drops the adapter's own posts, foreign inboxes, and private notes.
- **Handover:** when a human agent is assigned in Chatwoot, other OpenWA bots stop auto-replying on that chat; automation resumes when the conversation is unassigned.
- Inbound and outbound are serialized by an in-worker per-chat lock (no duplicate contacts/conversations on a cold-start burst), with idempotency on both WhatsApp and Chatwoot message ids.

Requires an OpenWA host with Integration SDK v1 (webhook ingress, `ctx.mappings`, the session+chat handover gate, and `net.allowConfigHosts`), and a Chatwoot version that HMAC-signs account-level webhooks with a timestamp (see the README setup guide).
