# Changelog

All notable changes to the Chatwoot Adapter plugin are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.5.4] — 2026-07-21

### Fixed

- **Every outgoing WhatsApp message was delivered twice while the adapter was enabled.** With "Relay your
  own outbound sends" on (the default), the adapter mirrors anything you send — from the WhatsApp app, a
  linked phone, or the OpenWA API — into the Chatwoot thread as an outgoing message. Chatwoot then
  announces that mirror back over the webhook, and because the adapter only ignored *incoming* Chatwoot
  posts, it treated its own mirror as a fresh agent reply and sent it to WhatsApp a second time. The
  recipient genuinely received two copies of every message. The adapter now records the Chatwoot message
  it creates and recognises the announcement as its own, exactly as it already did in the other
  direction. The one-time history import was affected the same way and is fixed by the same change — with
  "History backfill" enabled it could have re-sent imported messages to the contact.

  No action is needed beyond updating; de-duplication is keyed on the Chatwoot message id, never on
  message content, so genuine repeat messages are still delivered.

### Changed

- **Reply de-duplication is now scoped by the WhatsApp session that owns the conversation**, rather than
  by the session scope attached to the incoming webhook delivery. The two agree on a normal
  session-scoped setup, but an integration instance configured without a session scope previously fell
  back to a global namespace keyed by the bare Chatwoot message id — and because Chatwoot numbers
  messages per account, two Chatwoot accounts on one gateway could collide there and suppress each
  other's agent replies. The new scope is always defined and always matches, so that collision cannot
  occur.

  Upgrade note, and only for an instance running **without** a session scope: de-duplication markers
  written before this release are not carried over. If Chatwoot re-announces an already-relayed message
  under a new delivery id during the upgrade, that reply may be sent once more. Duplicate deliveries are
  already discarded by the gateway ahead of the plugin, so this is unlikely; markers are short-lived
  either way and the situation resolves itself immediately after the upgrade.

## [0.5.3] — 2026-07-20

### Fixed

- **Setup guide no longer prescribes a mint path that can never verify webhooks**
  ([OpenWA #821](https://github.com/rmyndharis/OpenWA/issues/821)). It previously told you to mint the
  instance from the dashboard and "paste the Chatwoot webhook secret" there — but the dashboard's
  instance form has no secret field and auto-generates one, which can never match Chatwoot's, so every
  Chatwoot → OpenWA delivery failed HMAC verification with a 401 while inbound (which uses the API
  token, not the webhook secret) kept working. Setup now mints via the REST API (the only path that
  accepts a secret), states the concrete minimum Chatwoot version (v4.12.0, the first release with
  per-webhook secrets + timestamped webhook signatures), and a new Troubleshooting section maps the 401
  symptom to its causes. Documentation only — no runtime code changed.

## [0.5.2] — 2026-07-04

### Fixed

- **The internal de-duplication markers no longer grow without bound.** The adapter keeps one marker per
  relayed message — to skip WhatsApp re-deliveries and its own echoed sends — and these were never cleaned
  up, so the plugin's storage grew for the life of the install and the inbound-retry timer's periodic scan
  got progressively slower on a long-running instance. Markers now carry a timestamp and are pruned once
  they pass a 3-day retention window, which comfortably outlasts any realistic WhatsApp re-delivery or
  own-send echo, so normal live de-duplication is unaffected. No configuration or action is needed;
  existing markers are migrated automatically.

## [0.5.1] — 2026-07-03

### Fixed

- **A contact who migrates to `@lid` no longer splits into a duplicate Chatwoot conversation on inbound.**
  Their `@lid` messages now resolve to the existing `<phone>@c.us` conversation (via the host
  `canonicalChatId` resolver + a dual lookup), mirroring the outbound fix in 0.4.0. Best-effort — it
  applies whenever the lid→phone mapping is known: after any reply to the contact, or on every inbound
  when OpenWA's `RESOLVE_LID_TO_PHONE=true` is set (recommended to fully close the gap; it also helps the
  outbound path).

## [0.5.0] — 2026-07-03

### Added

- **Inbound relay is now retried instead of dropped** when Chatwoot is transiently unreachable (#609).
  A failed inbound message is held in a durable, storage-backed queue and re-posted on a timer until it
  succeeds; a message that keeps failing is dead-lettered after several attempts. The plugin's health
  check surfaces the pending backlog and any dead-lettered messages.
  - This makes inbound delivery **at-least-once** (previously at-most-once — a failed post was logged and
    dropped). As a result, a message that actually reached Chatwoot but whose response was lost may, on
    rare occasions, be re-posted as a duplicate.

## [0.4.0] — 2026-07-03

### Added

- **Relay your own outbound sends** into Chatwoot, so a conversation isn't one-sided when you reply from a
  linked phone, the WhatsApp app, or the OpenWA API (#615). These mirror into the contact's **existing**
  mapped Chatwoot conversation as `outgoing` messages (a send to a chat not yet in Chatwoot is skipped —
  it appears once the contact replies, never as a duplicate conversation). Replies you send from within
  Chatwoot are recognized and never duplicated. New `relayOwnMessages` setting, **on by default**; turn it
  off to keep phone-composed messages out of the helpdesk. When the `@lid` mapping is resolvable, own
  sends to a contact WhatsApp has migrated to `@lid` land in their existing conversation instead of a
  duplicate, via the new host `canonicalChatId` resolver. Requires OpenWA 0.8.7+.

## [0.3.0] — 2026-07-03

### Added

- **History backfill** so agents see prior WhatsApp context in Chatwoot instead of a conversation that
  starts mid-thread (#609). Two composable modes, both off by default:
  - **Lazy (`backfillLimit`)** — when a chat first opens as a Chatwoot conversation, its recent messages
    (both directions, with media) are replayed oldest→newest before the triggering message, so the thread
    reads in order. Deduped against the live path, so nothing double-posts.
  - **Bulk (`backfillAllOnce`)** — a one-time sweep that imports the history of every existing chat on
    setup, for mirroring a whole inbox. Sequential, best-effort, runs once per session.
  - Business-side (`fromMe`) messages post as Chatwoot `outgoing`, contact messages as `incoming`.
  - Requires OpenWA 0.8.6+ (the `engine.getChatHistory` capability, bridged to sandboxed plugins) and the
    `engine:read` permission. History that can't be fetched (e.g. the Baileys engine, which doesn't support
    it, or a chat with no fetchable history) is skipped — the bulk sweep never creates empty conversations.

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
- **Locations and stickers relay as first-class types.** A shared location posts as a Chatwoot text bubble
  with its coordinates and an openable maps link (previously an empty message); a sticker is uploaded as a
  `image/webp` attachment named `sticker.webp` so it renders. (#609)

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
