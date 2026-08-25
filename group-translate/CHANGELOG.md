# Changelog

All notable changes to the **Group Auto-Translation** plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this plugin adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The version here always matches `manifest.json`'s `version`.

## [Unreleased]

## [1.3.6] - 2026-08-25

### Fixed

- A shared contact card is no longer translated. OpenWA 0.23.2 fills the message body with the card's
  vCard, which sent a third party's name and number to the translation backend, posted a
  machine-translated card back into the group, and let language detection pin the sender's language
  from vCard field names on their first shared card. Poll questions are still translated: a poll
  question is ordinary prose.

### Changed

- **Verified against OpenWA v0.23.3** (testedOpenWAVersion 0.23.0 → 0.23.3).

## [1.3.5] - 2026-08-20

### Changed

- **Verified against OpenWA v0.23.0** (testedOpenWAVersion 0.22.0 → 0.23.0).

## [1.3.4] - 2026-08-19

### Changed

- **Verified against OpenWA v0.22.0** (testedOpenWAVersion 0.20.0 → 0.22.0).

## [1.3.3] - 2026-08-16

### Changed

- **Verified against OpenWA v0.20.0** (testedOpenWAVersion 0.19.0 → 0.20.0); the catalog download URL now pins #sha256= for production installs.

## [1.3.2] — 2026-08-15

### Fixed

- **A group message can no longer stall the plugin worker.** The filter that skips messages with
  nothing to translate was a single regular expression whose emoji branch overlapped its URL branch —
  `\p{Emoji}` matches ASCII digits, `#` and `*`, because those are keycap-sequence components. Each
  additional link-shaped token multiplied the backtracking space, so a 145-character message took
  several seconds of uninterruptible CPU and `maxLength` allows 2000. The filter now scans token by
  token, which is linear regardless of input.
- **A message of only digits or punctuation is translated again.** The same emoji property classified
  `1` and `#5` as emoji, so those messages were skipped silently. The filter now uses
  `\p{Extended_Pictographic}`, which is the property that actually means "picture character".


### Changed

- **Compatibility re-verified against OpenWA v0.19.0** (testedOpenWAVersion 0.14.0 → 0.19.0). The
  manifest passes the v0.19.0 host's load-time validation (manifest, ingress and main-entry
  checks) and the built bundle loads under the loader contract. No capability surface this plugin
  uses changed between 0.14 and 0.19; the v0.19 breaking changes are host-side (API key length,
  removed REST endpoints, the plain-http install pin) and do not touch this plugin.

## [1.3.1] — 2026-08-12

### Changed

- **Declared the `storage:use` permission.** Each group's settings — whether translation is on, the
  language learned for every participant, and any delegated controllers — are kept in plugin storage.
  OpenWA is moving `ctx.storage` behind a permission the manifest has to declare, and a plugin that
  does not name it will have those reads and writes refused once the host enforces that. The failure
  would surface mid-conversation rather than at install: the plugin would keep running and quietly
  forget every group's configuration. Declaring it now costs nothing on the hosts you are running
  today — an unrecognized permission is ignored — so this release behaves exactly like 1.3.0
  everywhere 1.3.0 ran.

## [1.3.0] — 2026-08-01

### Fixed

- **Group admins were refused their own commands.** WhatsApp delivers the author of a group message
  under a privacy id (`…@lid`) while the group's participant list comes back under phone ids
  (`…@c.us`). Those two carry unrelated numbers, so an admin failed every comparison and `/tr on`,
  `/tr setlang`, `/tr grant` and the rest were silently denied. Only the group's creator was ever
  recognized, because WhatsApp reports the owner in the author's own dialect — and in a group created
  by the bot's own number, even that did not help, since the bot's own messages are never processed.
  The result was a group with no working administrator at all.

  When the direct comparison finds nothing, the plugin now asks the host to resolve the author to its
  phone identity and compares again. The same bridge fixes `/tr grant`: a controller delegated by
  phone number is now recognized when they speak. The lookup costs one call, is spent only on what
  would otherwise be a denial, and is remembered afterwards.

### Changed

- **The LibreTranslate backend is configurable without repackaging the plugin.** `libretranslateUrl`
  was checked against a fixed `localhost:7001` entry, so pointing the plugin at any other instance
  meant editing the manifest and rebuilding the `.zip` — and every other value silently failed. Any
  loopback address on any port is now accepted as shipped, and any other host is accepted over https
  through the manifest's `allowConfigHosts`. A loopback or private address still needs
  `SSRF_ALLOWED_HOSTS` on the OpenWA host; a plain-http backend on a non-loopback host still needs the
  manifest edit, because the host admits a config-supplied host only over https.

## [1.2.0] — 2026-08-01

### Changed

- **This plugin no longer introduces itself in your groups unless you ask it to.** Until now, enabling
  it made it post a "👋 Translation bot…" message into a group the first time it saw any message there.
  That fired **per group**, so a single enable announced the bot into every group the WhatsApp account
  belonged to — and the account running a plugin is usually somebody's own WhatsApp, not a dedicated
  bot number. The introduction is now controlled by a new **Announce this bot in new groups** setting,
  which is **off by default**, including for installs upgrading from an earlier version.

  Nothing else about the plugin was reachable without addressing it first: translation still requires
  an admin to run `/tr on`, and the same introduction text is still available to anyone on demand with
  `/tr help`. If you want the old behaviour, turn the new setting on.

## [1.1.1] — 2026-08-01

No behaviour change. 1.1.0 has now been smoke-tested against a newer host, so the tested-version field
is updated to match.

### Verified

- **Confirmed against a live OpenWA 0.12.1 host**, with a connected WhatsApp session, driven by real
  WhatsApp messages from a second connected number in a real WhatsApp group, against a real self-hosted
  LibreTranslate instance (English + Indonesian models) reachable at `http://localhost:7001` from inside
  the host container. `/tr status` reported `Translator: ok` — a live health probe of LibreTranslate
  through the host-proxied `ctx.net.fetch`. `/tr on` returned `✅ Translation activated.`, and both
  `/tr setlang en` (self) and `/tr setlang id <number>` applied and read back correctly in `/tr status`.
  The message `good morning, how are you today` was answered with
  `ID: selamat pagi, bagaimana kabarmu hari ini`.
- **The transformer-band fix from 1.1.0 holds**: the hook registered at priority 50, the Transformer
  band assigned in `PLUGIN-STANDARD.md`.
- **Not covered:** load or concurrency.

## [1.1.0] — 2026-07-31

### Fixed

- **A message could go untranslated entirely if another auto-reply plugin was also installed.** This
  plugin ran at the default hook priority — the same one an auto-reply plugin claiming its own messages
  runs at by default — so whether this plugin ever got a chance to translate a given message depended on
  which plugin happened to register first, which could change across a restart or re-enable. It now
  registers in the transformer band, ahead of every responder, so it translates an eligible message
  before any responder can answer it, instead of racing them for registration order. Note this only
  affects when the translation runs: a translated message is still passed on afterward, so a co-installed
  auto-reply plugin can still see and answer the original text. This plugin claims only its own `/tr`
  admin commands, never a translated conversational message.

## [1.0.7] — 2026-07-30

### Fixed

- **An empty translation is dropped instead of thrown away.** Whatever the backend returned was forwarded
  straight into the send, and a backend that answers 200 with a blank translation is a real case. OpenWA
  0.12 rejects an empty positional capability argument outright, so that stopped being a blank WhatsApp
  bubble and became a thrown capability error the coordinator swallowed — a translation that silently
  never arrives either way. It is now dropped deliberately, at the one place that can tell why.
- **An empty translation is dropped where it is produced, not at the send.** The guard first shipped in
  the gateway could never fire: the formatter prefixes each entry with a flag and language code, so a
  blank translation still rendered a non-empty `🇪🇸 ES:` bubble. It is now dropped at the point the
  translation is collected, which also keeps the decision log's count honest.
- **`timeoutMs` is clamped in code, not just hinted in the schema.** A `configSchema` `min` is a form
  hint the host never enforces, and the host clamps a fetch timeout of `<= 0` up to 1 ms — so a config of
  `0` made every translate abort instantly, with the coordinator swallowing the error and nothing logged.
  Values are now clamped to 500–30000 where it is actually enforceable.

## [1.0.6] — 2026-07-18

### Fixed

- **Per-session config overrides are now honored at message time without resetting the circuit breaker
  on every message.** The coordinator was built once at `onEnable` and the hook read that cached
  instance, so a per-session override (e.g. a different LibreTranslate instance or command prefix for one
  session) set via the dashboard after enable was ignored. The hook now recomputes a signature of the
  coordinator-affecting config fields per event and rebuilds the coordinator only when that signature
  changes — so an override takes effect, while the LibreTranslate client's circuit-breaker state is
  preserved across messages for an unchanged backend (a naive per-event rebuild would open/close the
  backend anew on each call and defeat the breaker's purpose).

## [1.0.5] — 2026-07-02

### Fixed

- **`denyReply` is now honored.** The denial reply for a restricted command was sent unconditionally,
  ignoring the `denyReply` config (which the manifest documents as default `false`). It now replies only
  when `denyReply` is enabled — so by default an unauthorized user cannot make the bot echo an "admins
  only" message back into the group on every attempt.

### Changed

- **README Security section corrected.** It previously claimed `SSRF_ALLOWED_HOSTS` "no longer applies to
  plugins" — the opposite of the truth. The host SSRF guard blocks loopback/private addresses at connect
  for every `ctx.net.fetch` regardless of `net.allow`, so a self-hosted LibreTranslate on
  `localhost`/`127.0.0.1`/a private host (including the default `http://localhost:7001`) requires
  `SSRF_ALLOWED_HOSTS=<hostname>` on the gateway. The Security section and config table now say so.

## [1.0.4] — 2026-06-25

### Fixed

- Translations now actually apply. The LibreTranslate client read the response with `res.json()`, but the
  sandboxed `ctx.net.fetch` returns the body as a string and provides no `.json()` method (functions can't
  cross the worker boundary) — so every call threw and failed open, a silent no-op. The client now parses
  `res.body` directly.

## [1.0.3] — 2026-06-23

### Fixed

- Participant lookups now reject prototype keys (`__proto__`, `constructor`, `prototype`) and test
  existence with `hasOwnProperty`, so a crafted participant/target id can no longer read or write
  `Object.prototype`.
- Concurrent messages for the same group are serialized through a per-(session, chat) lock, closing a
  load→mutate→save race that could duplicate the help announcement or drop a participant-language update.
  The lock map self-evicts when a chat's queue drains.
- A LibreTranslate `/translate` response without a string `translatedText` now fails the call (counted by
  the circuit breaker and excluded from the reply) instead of posting the literal text `undefined`.

## [1.0.2] — 2026-06-23

### Fixed

- Telugu (`te`) localization: the `libretranslateUrl` field title was left in English ("LibreTranslate URL");
  it is now localized to "LibreTranslate చిరునామా", matching the other locales.

## [1.0.1] — 2026-06-23

### Added

- Localized dashboard text (`name`, `description`, config field titles) for es, fr, it, ar, he, te, zh-CN,
  zh-HK via `manifest.i18n`. English remains the default + fallback. Translations are machine-generated;
  human review recommended for ar/he/te.

## [1.0.0] — 2026-06-23

First release. Built against the OpenWA v0.7 plugin contract.

### Added

- Auto-translation of group messages between participants' languages via a LibreTranslate backend, with
  in-chat `/tr` commands (help, status, on/off, setlang, auto, ignore/unignore, grant/revoke). Admin-gated
  via `ctx.engine.getGroupInfo`; disabled until enabled.
- All outbound calls go through the host's SSRF-guarded `ctx.net.fetch`; the LibreTranslate host must be in
  the manifest `net.allow` allowlist. Per-call timeout defaults to 4000ms (≤ the host hook budget), with a
  circuit breaker that backs off a flaky backend.
