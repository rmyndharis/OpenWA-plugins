# Changelog

All notable changes to the Chatwoot Adapter plugin are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- **An empty chat list no longer retires bulk backfill permanently.** The engine returns an empty list
  while it is still warming up, and the completion marker is durable — so a sweep that ran at the wrong
  moment disabled bulk backfill for that session forever. The marker is left unset so a later enable
  tries again.
- **Chatwoot request errors no longer carry the customer's phone number.** These errors surface in
  `healthCheck`, which the dashboard renders, and the contact-search URL carries the number in its query
  string. The query is dropped and the response body is no longer appended; the path still says which
  endpoint failed, which is what the diagnostic is for.
- **An agent reply can no longer reach the wrong customer.** Chatwoot conversation ids are per-account
  autoincrement, so two relayed accounts share one routinely. Alongside the tenant-scoped reverse
  mapping, an unscoped one was rewritten on every link, leaving it pointing at whichever session linked
  last — a delivery that arrived without a session scope resolved through it and was sent to that
  session's chat. The unscoped mapping is now claimed only while unclaimed and marked unusable once a
  second session claims the same id, so such a delivery is dropped and logged rather than guessed.
  Mappings written before scoping keep resolving, and single-tenant hosts are unaffected.
- **Recovering one session no longer drops another session's replies.** Unlinking by conversation id
  deleted the shared unscoped mapping as well, silently breaking the other tenant until its next
  inbound message. It is now removed only when it belongs to the session being unlinked.

- **Attachment uploads now use an unpredictable multipart boundary.** The boundary was built from the
  conversation id and the file's byte length, both of which a sender can work out from the media they
  send — so an attachment crafted to contain that exact boundary could close the part early and append
  parts of its own to the request reaching Chatwoot. The boundary is now 16 random bytes, which removes
  the possibility rather than filtering for it.

## [0.9.1] — 2026-08-12

### Changed

- **Declared the `storage:use` permission.** This plugin leans on plugin storage more than anything
  else in the catalog, and each of the four things it keeps there prevents a different visible
  failure: the WhatsApp-chat-to-Chatwoot-conversation mapping (without it every message opens a new
  conversation instead of continuing the existing one), the de-duplication buckets (without them a
  redelivered message is posted to Chatwoot twice), the retry queue (without it a message that arrives
  while Chatwoot is briefly unreachable is simply lost), and the one-shot bulk-import marker (without
  it a re-enable re-imports history that is already there). OpenWA is moving `ctx.storage` behind a
  permission the manifest has to declare; without it all four are refused. Declaring it changes
  nothing on the hosts you run today — an unrecognized permission is ignored — so 0.9.1 behaves
  exactly like 0.9.0.

## [0.9.0] — 2026-08-05

### Added

- **An agent's "Reply to" in Chatwoot now reaches WhatsApp as a real quote.** The adapter posts every
  message with its WhatsApp id as `source_id`, and when an agent replies to a specific message Chatwoot
  hands that id back as `content_attributes.in_reply_to_external_id` — but the outbound relay ignored it,
  so the reply arrived as a plain message and the person on WhatsApp couldn't tell which message it
  answered. The relay now passes it through as the send envelope's `replyTo`.

  Quoting is best-effort, and delivering the reply always wins over decorating it. A **text** reply is
  quoted; if the quoted message has fallen outside the engine's retained window (whatsapp-web.js keeps
  about 100 messages per chat, Baileys 5,000 overall) the engine refuses the quote, and the reply is
  re-sent unquoted instead of failing. A reply carrying an **attachment** is never quoted: the engine's
  media path cannot quote at all, so the attachment goes out with its caption and no quote. A reply whose
  quoted message has no external id (for example a note imported by an external tool without a
  `source_id`) goes out unquoted, as before.

### Fixed

- **Inbound messages no longer dead-letter when the phone number already belongs to a Chatwoot contact
  keyed under a different identifier.** A contact created by hand, by another integration, or before this
  adapter took over the inbox can hold the chat's phone number without the adapter's JID identifier. The
  create then 422s, the identifier-based fallback search misses the contact, and — because the same
  collision recurs on every delivery — each message from that chat burned its whole retry budget into the
  dead-letter queue while the plugin's health stayed green until the retries were exhausted. The adapter
  now falls back to searching by phone number, adopts the matching contact, and re-keys its identifier to
  the JID so future lookups resolve it directly. The re-key is best-effort: if it fails (say, a
  conflicting identifier on another contact), the phone match alone still delivers the message — merging
  the duplicate contacts in Chatwoot remains safe, as before. A contact already keyed to a WhatsApp JID is
  adopted but never re-keyed, so a chat seen under both JID forms cannot flip the contact back and forth.

- **A failing relay now says why, on the plugin's health check.** The reason a message did not reach
  Chatwoot — the API status and response body, a refused private address, a certificate error — was
  written to the host's log and nowhere else, while the health check reported only counts. An operator
  saw "1 dead-lettered after 5 attempts" with no way to find out what went wrong. The health check now
  appends `last error: …` whenever something is actually failing.
- **A `baseUrl` with a path is rejected when the settings are saved, instead of failing on every
  message.** The plugin appends `/api/v1/accounts/<id>` to this value, so a URL copied out of the
  Chatwoot dashboard's address bar (`https://chat.example.com/app/accounts/2/settings/inboxes/8`)
  produced a nonsense request path and 404'd every relay — while the plugin enabled cleanly and looked
  healthy until the retries ran out. It now has to be the origin only.

### Verified

- **Reproduced and confirmed against a live OpenWA 0.12.1 host** (Baileys engine) and a self-hosted
  Chatwoot v4.16.2: an API-channel inbox previously fed by a custom bridge had contacts keyed
  `wa:<digits>`. Every inbound WhatsApp message from those chats 422'd and dead-lettered
  ("2 dead-lettered after 5 attempts"). Manually re-keying the contacts' identifiers to the JID — exactly
  what this fix automates — immediately restored inbound relay for those chats.

## [0.8.0] — 2026-08-01

### Added

- **The adapter now recovers when a Chatwoot conversation is deleted out of band.** Previously, once an
  operator deleted a conversation directly in Chatwoot, the adapter's cached mapping kept pointing at the
  dead conversation: every following WhatsApp message from that chat was posted to it, rejected, and
  retried against the same dead id until the plugin gave up — the chat silently stopped reaching Chatwoot,
  and your own outbound sends to it were dropped outright. The adapter now detects the rejection, drops
  the stale mapping, rebuilds the conversation through its normal path — reusing the existing Chatwoot
  contact, so no duplicate contact is created — and re-posts the message into the fresh conversation. If
  the rebuild itself fails, the message falls back to the existing retry queue rather than looping
  forever. Where "History backfill" is enabled, a rebuilt conversation imports the chat's recent history
  like any newly created one, so the agent doesn't open an empty thread.

  This recovery is intentionally not attempted while draining the retry queue: a queued message is already
  a re-attempt of a previous failure, and rebuilding there too would mint a new conversation on every
  retry instead of converging. Those messages spend their retry budget as before, and the next live
  message from that chat heals the mapping.

### Verified

- **Confirmed against a live OpenWA 0.12.1 host**, with a connected WhatsApp session and a real Chatwoot
  instance. A conversation the adapter had mapped was deleted in Chatwoot, and posting to it was confirmed
  rejected. The next WhatsApp message from that chat caused the adapter to drop the stale mapping and mint
  a fresh conversation, keeping the same Chatwoot contact. The message was delivered into the new
  conversation: nothing entered the retry queue and the plugin reported healthy.
- **Not covered live:** the recovery path for your own outbound sends, and the retry-drain path
  deliberately not recovering — both are covered by automated tests but were not exercised against a live
  host.

## [0.7.1] — 2026-07-31

No behaviour change. 0.7.0 has now been smoke-tested against a newer host, so the tested-version field
is updated to match.

### Verified

- **0.7.0 confirmed working against a live OpenWA 0.12.1 host**, with a connected WhatsApp session and a
  real Chatwoot instance. It installed in place over the previous build with its configuration and API
  token preserved, the message hook registered at priority 20, and live inbound messages relayed to
  Chatwoot.
- **History-backfill bookkeeping behaved as designed.** A newly mapped chat got `backfillDone: false`
  written at creation; a failing history fetch incremented `backfillAttempts` and left `backfillDone`
  false rather than being recorded as a completed import; and after three failed attempts the plugin
  stopped fetching history for that chat, with plugin health reporting `1 chat(s) gave up on history
  import after 3 attempts` while remaining healthy overall.
- **Upgrading left existing conversations alone.** A mapping document in the pre-0.7.0 shape — carrying
  neither backfill field, as every chat mapped by an older version does — was untouched: no history
  fetch was attempted and nothing was written to it.
- **Not covered:** a successful history import. The test host's engine does not support history
  retrieval, so the path where every message in the backfill window posts and the import is marked
  complete was not exercised.

## [0.7.0] — 2026-07-31

History-backfill reliability release, plus a registration-order fix.

### Fixed

- **A large history-backfill window could fail outright.** Requesting attachments for every message in a
  wide window could exceed the host's 30-second import budget, so the whole import failed rather than
  arriving late. Attachments are now fetched only when the configured window is 25 messages or smaller;
  above that, older media arrives in Chatwoot as a placeholder line instead of the file. The history
  backfill setting is clamped to 100, and its description explains the 25-message attachment threshold.
- **A failed history import for a chat was gone for good.** Whether a chat had been imported used to be
  inferred rather than recorded, so an import that failed partway had no way to know it needed to try
  again. It's now stored on the chat's own record, so a chat that failed its import is retried
  automatically on its next message — up to three attempts before the plugin gives up on that chat.
  **Upgrading does not re-import your existing conversations.** History import applies to chats first
  seen from this version onward; a chat that was already open in Chatwoot before the upgrade is left
  exactly as it is, so no thread gets a second copy of its history — unless you turn on the one-time
  bulk-import option afterward, which re-imports history into chats that already have it.
- **A Chatwoot outage during import could mark a chat as "imported" with nothing in it.** The import is
  now only recorded as done once every message in the window has actually posted to Chatwoot.
- **Chats that gave up on history import are now visible.** They're counted in this plugin's health
  status, instead of failing silently.
- **Logged/mirrored messages could go missing when another plugin was also installed.** This plugin
  registered its inbound and outbound hooks at the default priority, tied with (or behind) plugins that
  end the event chain for the message they handle. It now registers early, at observer priority, so it
  always sees a message before anything else decides that message is spoken for.

## [0.6.0] — 2026-07-30

Storage-behaviour release, prompted by OpenWA 0.12.0. The host now enforces a 50 MiB per-plugin storage
quota and re-measures it on **every** write by stat-ing every one of the plugin's storage keys —
synchronously, on the gateway's own event loop. Two long-standing designs in this adapter turned that
into message loss and a gateway-wide stall.

### Fixed

- **Dedup markers no longer use one storage key per message.** With a 3-day retention a session at
  10 messages/minute held roughly 43,000 marker files, so every inbound message made the host stat all
  43,000 before it could write the next marker — stalling HTTP, websockets and engine callbacks for the
  whole gateway, and getting worse in proportion to traffic. The hourly prune added a further round-trip
  per marker. Markers now live in a fixed 256 sharded buckets keyed by a hash of the marker id, so the
  key count is constant no matter the volume while the per-message cost stays exactly what it was (one
  read, one write). Buckets drop their own expired entries as they are written, so nothing needs a global
  scan. Markers written by earlier versions are still honoured — missing one would re-post an inbound
  message, or send a Chatwoot agent's reply to the recipient a second time — and the extra read that
  costs is retired automatically once the last of them has been pruned.
- **Marker writes are serialized per bucket.** Sharding replaced one storage key per marker with a
  read-modify-write over a shared bucket, and every await inside it is a round-trip to the host — so two
  marks that hash to the same bucket could interleave and the later write would drop the earlier marker.
  The surrounding per-chat and per-conversation locks cannot prevent that: they are keyed by chat, and a
  shard is shared across chats. A lost `cw` marker re-sends an agent's reply to the contact; a lost `wa`
  marker re-posts an inbound to Chatwoot. The one-key-per-marker scheme had no such window, so this
  restores the guarantee rather than adding a new one.
- **The retry queue was sized seven times larger than the entire storage quota.** 500 pending entries at
  up to 700 KB of media each is ~350 MiB against a 50 MiB budget, so a media backlog hit the quota at
  around 74 entries: `storage.set` then rejected, the "drop the oldest entry" policy never ran, and the
  message was lost outright — it had already been marked seen. The pairing is now 80 × 200 KB ≈ 16 MiB,
  documented as a pair so neither can be raised without redoing the multiplication. Note the trade-off:
  the lower per-entry media cap means an attachment above roughly 150 KB binary is now *queued* as a
  placeholder rather than as the file, so if the relay only succeeds on retry the agent sees
  `📎 invoice.pdf` instead of the document. Previously that held up to ~512 KB. Losing fidelity on the
  failure path is the price of not losing the message itself on the quota.
- **A message that could neither be relayed nor queued is now reported.** That failure was swallowed by a
  `.catch` that logged and returned null, and because the retry queue cannot count an entry it never
  managed to store, `healthCheck` went on reporting the plugin healthy while messages disappeared. Such
  a message is now counted and surfaced in the health message as `LOST`, which also marks the plugin
  unhealthy.
- **A storage failure while marking a message seen no longer escapes the handler.** The `markSeen` call
  sat outside the `try`, so a rejected write left the message neither relayed nor queued for retry; it
  now takes the same retry path as a failed relay.
- **Polls relayed as an empty Chatwoot bubble.** `poll` is a message type OpenWA reports with an empty
  body, and it had no placeholder, so the post was rejected with a 422 and — the message being already
  marked seen — dropped after five retries, leaving the plugin permanently unhealthy. Polls now relay as
  `📊 Poll`, and the placeholder fallback can no longer return an empty string for any bodyless type
  (`call`, `revoked`, `masked`, `unknown`, or any type a future host adds).

## [0.5.7] — 2026-07-23

### Fixed

- **New Chatwoot contacts were almost always created without a `phone_number`.** The phone was set
  only from `msg.senderPhone`, which the host populates solely for `@lid` senders under
  `RESOLVE_LID_TO_PHONE=true` — so plain `@c.us` chats, and `@lid` chats whose lid→phone mapping was
  already warmed, reached Chatwoot with no phone, breaking contact search and downstream merges. A new
  `resolvePhone` helper now derives the number from the host-resolved sender or the canonical `@c.us`
  chat id (whose JID user-part is the MSISDN), while deliberately ignoring `contact.number` (it carries
  LID digits, not the real phone, for `@lid` senders). Groups and genuinely unresolved `@lid` chats
  still create without a phone. Applies to new contacts only; existing rows are untouched.

## [0.5.6] — 2026-07-23

### Fixed

- **A backfilled or mirrored message could be delivered twice when Chatwoot's echo webhook arrived
  mid-post.** The adapter marks its own `outgoing` posts as "seen" only after Chatwoot confirms the
  post, but the `message_created` echo webhook can be processed before that confirmation returns —
  and inbound/backfill hold a different per-chat lock than the webhook path, so nothing serialized
  the two. The echo then looked unmarked and was relayed to WhatsApp as a duplicate. The post and its
  echo-marker write now hold a conversation-scoped lock that the webhook dedup also takes, so the
  echo always waits for the marker and is correctly skipped (regression test included).

## [0.5.5] — 2026-07-22

### Fixed

- **Two of your own messages in a row could go missing from the Chatwoot thread.** When WhatsApp does
  not return an id for a message you send — which happens occasionally, and more often on the Baileys
  engine — the adapter used that missing id as its "already relayed" key. Every such message therefore
  shared one key: the first reached Chatwoot, and any later one was treated as a duplicate and dropped
  for the next three days. Silently, and only in Chatwoot: the message itself reached the recipient
  normally. Messages without an id are now always relayed. They cannot be de-duplicated, so on the rare
  occasion WhatsApp re-delivers one you may see it twice in the thread — visible, unlike losing it.

### Changed

- **Promoted from beta to stable.** The two-way relay has now been exercised end to end on both engines
  (whatsapp-web.js and Baileys) against a live WhatsApp account: inbound relay, agent replies with text
  and media, your own outbound messages mirrored without being re-sent, and a real history import.
  Tested against OpenWA 0.10.5.

  One limitation to be aware of, unchanged by this release: WhatsApp is migrating contacts to privacy
  ids (`@lid`), and a contact first seen under its privacy id creates a separate Chatwoot contact from
  one already known by phone number. The adapter resolves the two together whenever it can, and never
  creates a second conversation for a chat it has already mapped, but a contact whose mapping is lost or
  who arrives privacy-id-first can appear twice. See the README.

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
