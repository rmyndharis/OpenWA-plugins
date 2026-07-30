# OpenWA Plugin Standard

The conventions every plugin in this repository follows, so the catalog stays consistent and
management/automation stays easy. Verified against OpenWA's plugin runtime (sandboxed worker model,
v0.7.x).

## Principles

| Concern | Lives in | Notes |
| ------- | -------- | ----- |
| Machine-readable metadata | `manifest.json` | Single source of truth. OpenWA reads required fields and ignores unknown ones. |
| Human-readable docs | `README.md` | Standard section order (below). |
| Dated version history | `CHANGELOG.md` | Keep a Changelog + SemVer. The release date lives here. |
| Computed artifacts (size, sha256) | release time | GitHub Release notes + assets — never hand-written. |
| Cross-plugin index | `plugins.json` (repo root) | **Generated** from manifests + changelogs. Don't edit by hand. |

## Repository layout

```
OpenWA-plugins/
├─ plugins.json            # generated catalog (one entry per plugin)
├─ PLUGIN-STANDARD.md      # this file
├─ scripts/catalog.mjs     # catalog generator + drift check
├─ package.mjs             # per-plugin build + validate + package (zip)
└─ <plugin-id>/
   ├─ manifest.json
   ├─ README.md            # Details (generated block) + Features + …
   ├─ CHANGELOG.md
   ├─ index.ts             # default-exports an IPlugin class
   ├─ *.ts, *.test.ts
   └─ dist/index.js        # built artifact (gitignored)
```

## `manifest.json`

```jsonc
{
  // ── Required by OpenWA (install fails without these) ──
  "id": "my-plugin",            // /^[a-z0-9][a-z0-9._-]*$/i, unique, not reserved
  "name": "My Plugin",          // shown in the dashboard
  "version": "1.0.0",           // SemVer; MUST equal the top released CHANGELOG heading
  "type": "extension",          // only "extension" is user-installable
  "main": "dist/index.js",      // require()-able entry, present in the package

  // ── Surfaced by OpenWA ──
  "description": "…",            // rendered in the dashboard card + returned by the API
  "provides": ["feature-tag"],  // rendered as tags in the dashboard card
  "permissions": [],            // see the five values below — enforced at the capability boundary
  "sessions": ["*"],            // capability session scope (static; editing config can't widen it)
  "hooks": ["message:received"],// declared interest
  "configSchema": { … },        // declarative config form (see vocabulary below); mark secrets "secret": true

  // ── v0.7 contract ──
  "sessionScoped": true,        // default true: only runs for sessions an operator activates it for
                                //   (ctx.config is the resolved per-session slice). false = global, always on.
  "net": { "allow": ["api.example.com:443"] }, // outbound-HTTP allowlist for ctx.net.fetch (needs "net:fetch")
  "configUi": { "entry": "config/index.html", "height": 600 }, // sandboxed-iframe config editor (see below)

  // ── Returned by the API (not yet rendered by the dashboard) ──
  "author": "Name <email>",     // string form (npm-style)
  "license": "MIT",

  // ── Standard catalog metadata (OpenWA stores but ignores; used by our tooling) ──
  "homepage": "https://github.com/rmyndharis/OpenWA-plugins/tree/main/my-plugin",
  "repository": "https://github.com/rmyndharis/OpenWA-plugins",
  "keywords": ["…"],
  "status": "stable",           // "stable" | "beta" | "development"
  "minOpenWAVersion": "0.7.0",  // compatibility convention (OpenWA does not enforce it yet)
  "testedOpenWAVersion": "0.7.0"
}
```

Repo gates (enforced by `scripts/catalog.mjs`, hard failure in CI): every manifest must declare
`sessionScoped` explicitly, and a `status: "stable"` manifest must declare `testedOpenWAVersion`. A
missing `i18n` block (or missing locales) is a warning, not a failure.

### `configSchema` field vocabulary (v0.7)

A JSON-Schema-ish object the host renders into an authenticated form (writes go through
`PUT /plugins/:id/config`). `{ "type": "object", "properties": { <key>: <field> } }`, where each
field is:

| Key | Applies to | Effect |
| --- | ---------- | ------ |
| `type` | all | `string` · `number` · `boolean` · `textarea` (multi-line string) · `object` · `array` |
| `title` / `description` | all | label + helper text |
| `default` | all | seeded into the form; also the blank value for a new array row |
| `required` | all | marks the label (advisory — not hard-enforced by the host) |
| `secret` | scalar | masked on read (shown as `***`); an unchanged `***` write keeps the stored value. Works at **any depth** (nested object / array row). |
| `enum` | scalar | renders as a `<select>` of the listed values |
| `min` / `max` | number / string·textarea / array | value bound · min/maxLength · row count (HTML attribute, advisory) |
| `pattern` | string / textarea | HTML validation regex |
| `properties` | `object` | nested fields, rendered as a sub-group |
| `items` | `array` | the element schema; **array-of-rows** when `items.type === 'object'` (add/remove rows in the form) |

`items` and `properties` nest arbitrarily (e.g. a menu tree of options → sub-options). The plugin
still reads `ctx.config` as `Record<string, unknown>` and must validate defensively — the schema only
drives the host's form, it is not enforced server-side.

### `configUi` — sandboxed-iframe config editor (v0.7)

For a richer editor than the declarative form, ship `configUi: { entry, height? }`. The host serves
`entry` (a plugin-relative path) over an authenticated route and injects it as the `srcdoc` of a
`sandbox="allow-scripts"` iframe (opaque origin — no access to the dashboard, its API key, or storage).
When both `configUi` and `configSchema` are present, the dashboard prefers the iframe.

- **Self-contained.** Inline your JS/CSS — a sandboxed opaque-origin srcdoc can't load subresources,
  and the iframe has no network of its own. The editor talks ONLY to the host over `postMessage`:
  - `→ host { type: 'config:get' }` then `← host { type: 'config:value', config, schema }`
  - `→ host { type: 'config:save', config }` then `← host { type: 'config:saved' }` or `{ type: 'config:error', message }`
- **Declare your fields in `configSchema` too.** The host only hands the iframe the schema-declared,
  secret-redacted config (so an undeclared key can't leak a secret to untrusted UI); fields you don't
  declare won't pre-fill, and secrets you mark `secret: true` arrive masked and are restored on save.

### Per-session config (v0.7)

A session-scoped plugin (`sessionScoped` ≠ false) may carry per-session config **overrides** on top of
the base (`'*'`) config. The host resolves them automatically: `ctx.config` is the override
shallow-merged over the base for the session whose event is firing (the base when there's no override,
or for a non-session-attributed event). **Read `ctx.config` inside your hook handler** to get the
right slice; reading it at load/lifecycle time yields the base. No plugin code is needed — the operator
sets overrides via the dashboard/API.

#### Author requirement: re-resolve config inside the hook

Because `ctx.config` is a **getter** that returns a different value per firing session, **caching it at
`onEnable` and reading the cache in the hook silently ignores per-session overrides** — the cache holds
the base `*` config. Two patterns honor overrides correctly:

- **Per-event re-parse (simplest).** Call your `parseConfig(ctx.config)` inside the hook handler, not at
  `onEnable`. This is the recommended pattern for plugins whose config is plain values (strings, numbers,
  booleans, rule lists). Keep a `parseConfig(ctx.config)` at `onEnable` too as fail-fast validation so a
  bad base config surfaces in the dashboard immediately, but don't keep the *result* as hook state.
- **Config-signature caching (for stateful coordinators).** If your hook reads a *stateful object* built
  from config — a client with a circuit breaker, a connection pool, a coordinator — a naive per-event
  rebuild resets that state on every message (e.g. the circuit breaker never trips). Instead, compute a
  stable signature of the coordinator-affecting config fields per event and rebuild **only when the
  signature changes**. Two messages from sessions with the same resolved config reuse the same
  coordinator (its breaker/state survives); a per-session override that changes a field triggers one
  rebuild on the next hook fire.

> ⚠️ **Anti-pattern.** Do NOT store `this.config = parseConfig(ctx.config)` at `onEnable` and read
> `this.config` in the hook. This breaks per-session overrides and has been the source of multiple bugs
> (PRs #38, #39). Re-parse per event, or use signature-caching for a stateful coordinator.

If your plugin **cannot** support per-session config — typically because it holds a single shared sink
(e.g. one buffer, one queue) that can't attribute work to a session at flush time — that is an
acceptable design choice, but it **must be documented** in the plugin's README **Compatibility** section
under a `### Per-session config` heading, with the reason and any workaround (e.g. "run one instance per
session"). See the per-plugin README convention below.

**Reserved ids** (cannot be used): `whatsapp-web.js`, `baileys`, `auto-reply`, `translation`.
**Package limits** (enforced by OpenWA at install): ≤ 5 MB compressed, ≤ 200 files, ≤ 20 MB uncompressed.
**Ship compiled JS** — the loader `require()`s `main`; build with `node package.mjs <id>`.

## Runtime contract (observed)

These behaviors are **observed from the host, not a written host contract** — they are load-bearing for
correct plugins and were each learned the hard way. Re-verify against OpenWA core when upgrading.

1. **`ctx.net.fetch` responses have no `.json()` / `.text()` / `.arrayBuffer()`** — functions cannot
   cross the worker structuredClone boundary, so the response is a plain
   `{ ok, status, statusText, headers, body }`. Read `res.body` (a UTF-8 string, capped at 10 MiB
   host-side) and `JSON.parse(res.body)`. Those three method stubs used to be carried on the vendored
   type as runtime-throwing placeholders; they have been removed, so a plugin that still calls one now
   fails the typecheck instead of at runtime.
2. **Hook handlers are bounded to ~5 s.** Never await slow work (HTTP calls, media processing) inside a
   hook: return `{ continue: true }` synchronously and float the promise
   (`void handle().catch(log)`). The same applies to ingress handlers (see supabase-otp-hook's
   fire-and-forget send).
3. **Hosts declared via config (`net.allowConfigHosts`) must be required, non-empty config** — the net
   gate reads the RAW `ctx.config`, so a **code-side** default host is invisible to the gate and every
   fetch silently no-ops. Fail fast in `readConfig` when the host field is empty. A **manifest**
   `configSchema` `default` does reach the gate: the host seeds top-level declared defaults into the
   stored and runtime config at load, so a manifest default and a code default that disagree now
   resolve to the manifest's, silently. (Top-level only — defaults nested under `properties`/`items`
   are not seeded. A required field with no declared default deliberately stays absent, because that
   needs real operator input; the host never enforces `required` itself.)
4. **Host boot re-enables every plugin the operator had enabled** (OpenWA ≥ 0.12; earlier hosts really
   did require a manual re-enable). The runtime `status` is still reset on load, but the operator's
   standing decision is persisted separately and replayed at boot. `ctx.config` and `ctx.storage`
   survive, so dedup/state markers in storage are safe. What this demands of a plugin:
   - **`onEnable` must be idempotent** — it now runs unattended on every restart, not just on an
     operator click.
   - **`onEnable` must not touch `ctx.engine.*` / `ctx.messages.*` or await network I/O.** Boot restore
     runs before sessions connect and before the HTTP listener opens; a slow or engine-dependent
     `onEnable` blocks startup and burns the 30 s lifecycle budget for nothing.
   - **In-memory state does NOT survive** (each enable spawns a fresh worker). A cooldown or throttle
     kept only in a `Map` silently re-arms on every restart — persist it or document the reset.
   - **A plugin left in ERROR is not restored**; nothing respawns a crashed worker, so an operator must
     re-enable it explicitly.
   - `onDisable` now runs on graceful shutdown (SIGTERM), and `onUnload` on uninstall/in-place update.
5. **Cross-host redirects cannot be blocked plugin-side** (`PluginNetRequestInit` exposes no redirect
   option) — redirect-based SSRF defense is the host's job; do not treat it as a plugin release gate.
6. **`ctx.storage` charges per KEY, not just per byte.** Each key is one JSON file, and the host
   re-measures the plugin's 50 MiB quota on **every** `set` with a synchronous readdir + stat of every
   existing key — on the host's event loop. One key per message is therefore a gateway-wide stall
   waiting to happen: bucket instead (one key per session per hour holding a map, pruned by deleting
   whole buckets). Always handle a rejected `set` — a swallowed quota error is silent data loss, and a
   `healthCheck` that ignores it reports green while dropping messages.
7. **`{ continue: false }` is a veto on exactly two events.** On `message:sending` it blocks the send
   (the API caller gets HTTP 400) and on `webhook:before` it cancels that delivery. On every
   notification event (`message:received`, `message:sent`, `session:*`, …) it only stops the remaining
   handler chain — the host still persists the message, still fires webhooks, and still pushes to the
   websocket. Use it to claim an event against sibling plugins, never to hide one.
8. **`webhook:before` is the widest surface a plugin can subscribe to, and nothing gates it.** A
   handler can cancel any of the operator's webhook deliveries and rewrite the outbound body
   (`{ payload }` replaces it; the host re-asserts only `event`/`sessionId`/`timestamp` and the
   dedupe ids, and caps the result at 1 MiB). Treat a `webhook:before` subscription in a submitted
   plugin with the same scrutiny as an ingress route.
9. **Host bounds, none of them visible from the types:** 30 s per lifecycle phase; 30 s per capability
   call, except the send verbs (`messages.sendText`, `messages.reply`, `conversations.send`) at 120 s;
   5 s per hook dispatch, after which the host fails **open** with `{ continue: true }` and discards
   your result; 32 concurrent capability calls per plugin (the 33rd throws); 50 MiB storage; 10 MiB
   fetch response body; 200 log lines / 10 s at 8 KiB per line.
10. **The worker is crash containment, not a security boundary** (core says so itself). Plugin code can
   `require('fs')`/`('net')`/`('child_process')`; what the worker actually buys you is a 256 MB heap
   ceiling and a crash that doesn't take the gateway down. Review submitted plugins accordingly.

**Permissions** — the five values the host enforces, and what each unlocks:

| Permission | Unlocks |
|---|---|
| `messages:send` | `ctx.messages.sendText` / `.reply` |
| `engine:read` | `ctx.engine.*` (group info, contacts, chats, number check, chat history, `canonicalChatId`) |
| `net:fetch` | `ctx.net.fetch`, further scoped by manifest `net.allow` / `net.allowConfigHosts` |
| `conversation:send` | `ctx.conversations.send` **and** `ctx.handover.set` **and** `ctx.mappings.*` |
| `webhook:ingress` | `ctx.registerWebhook`; **required** whenever the manifest declares `ingress`, or the whole plugin fails to load |

An ingress route with `signature.scheme: "none"` is a hard load failure for the entire plugin unless the
operator sets `ALLOW_UNSIGNED_INGRESS=true`. `mode: "sync-reply"` is inert dead code — declare
synchronous behavior via `ingress[].response` instead. A `WebhookResponse` returned from your handler is
ignored; the provider's reply comes from `ingress[].response.ack` (default 202).

`minOpenWAVersion` is advisory (never enforced by the host). Still bump it when a plugin *requires* a
newer capability: `canonicalChatId` → 0.8.7, Integration SDK v1 (`sdkVersion: 1`) → 0.8.x,
`getChatHistory` → 0.8.5. Keep `testedOpenWAVersion` honest: it is the newest host the plugin was
actually smoke-tested against.

## `README.md` — required sections (in order)

1. **Title + one-line tagline**, then a small badge row in this exact order:
   1. `type` — `https://img.shields.io/badge/type-<type>-blue.svg`
   2. `license` — `https://img.shields.io/badge/license-MIT-green.svg`
   3. `OpenWA` — `https://img.shields.io/badge/OpenWA-%E2%89%A5%20<minOpenWAVersion>-25D366.svg`
   4. `downloads` — cumulative .zip downloads across all releases of this plugin, fed by
      `scripts/download-badges.mjs` (see the `download-badges` workflow) via the `badges` branch.
      Copy this line verbatim, substituting `<id>`:
      ```md
      [![downloads](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Frmyndharis%2FOpenWA-plugins%2Fbadges%2Fdownloads%2F<id>.json)](https://github.com/rmyndharis/OpenWA-plugins/releases?q=<id>)
      ```
2. **Details** — a generated table between `<!-- BEGIN DETAILS … -->` and `<!-- END DETAILS -->`
   (identifier, version, released, status, author, license, type, requires-OpenWA, keywords, repository).
   Regenerated by `scripts/catalog.mjs`; do not edit by hand.
3. **Features** — concrete capabilities as a bullet list.
4. **What it logs / does** — behavior detail.
5. **Setup** — prerequisites in numbered steps.
6. **Install** — `curl` examples (upload zip, set config, enable) and/or the Releases download.
7. **Configuration** — a table: key · required · default · description.
8. **Compatibility** — version-specific behavior and known caveats. Include a `### Per-session config`
   subsection stating whether per-session config overrides are supported (and any caveat — see
   [Per-session config](#per-session-config-v07) above).
9. **Security** — the threat model relevant to this plugin.
10. **Changelog** — link to `CHANGELOG.md`.
11. **License**.

## `CHANGELOG.md`

[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) + [SemVer](https://semver.org/):

- An `## [Unreleased]` section at the top, then `## [MAJOR.MINOR.PATCH] — YYYY-MM-DD` headings in
  descending order, with `### Added / Changed / Fixed / Removed / Security` subsections.
- **The top released heading's version MUST equal `manifest.json`'s `version`** — enforced by
  `scripts/catalog.mjs --check` in CI.
- SemVer: **MAJOR** = breaking change for operators, **MINOR** = new capability, **PATCH** = fixes.

## `plugins.json` (generated catalog)

One entry per plugin, written by `scripts/catalog.mjs` from each manifest + changelog:

```jsonc
{
  "id", "name", "version", "type", "status", "description", "author", "license",
  "keywords", "minOpenWAVersion", "testedOpenWAVersion",
  "releasedAt",           // from the top CHANGELOG heading
  "repoPath", "repoUrl", "homepage",
  "download"              // predictable GitHub Release asset URL: <repo>/releases/download/<id>-v<version>/<id>.zip
}
```

Size and sha256 are **not** in the catalog — they are release artifacts (GitHub Release notes/assets),
so the catalog stays deterministic and CI's drift check stays stable. This file is also the data source
for a future OpenWA in-dashboard marketplace.

## Tooling (npm scripts)

| Script | What it does |
| ------ | ------------ |
| `node package.mjs <id>` | Validate manifest (required fields + `version` == top CHANGELOG heading), bundle to `dist/index.js`, zip to `<id>.zip` with the built-in STORE writer (`scripts/zip-store.mjs` — no external `zip` CLI needed), print size + sha256. |
| `npm run catalog` | Regenerate `plugins.json`, the root README catalog table, and every plugin README **Details** block. |
| `npm run catalog:check` | Same, in-memory; fail if the committed files are out of date, a version↔changelog drift exists, or a manifest gate fails (CI). |
| `npm test` | Run the full suite (`scripts/run-tests.mjs` auto-discovers every plugin dir by its `manifest.json`, plus `scripts/`) with `node --test` + `tsx`. |
| `npm run test:coverage` | Same, with Node's built-in coverage report. |
| `npm run typecheck` | `tsc --noEmit` over every `*/**/*.ts` (plugin dirs are not hardcoded). |
| `node scripts/download-badges.mjs [out-dir]` | Sum per-plugin .zip downloads across all GitHub Releases and write shields.io endpoint JSON files (run by the `download-badges` workflow; also runnable locally to preview the numbers). |

## Release process

Tag a release as **`<plugin-id>-vX.Y.Z`** (the version must match the manifest + changelog). The
`release` GitHub Action builds the plugin, attaches `<id>.zip` + `<id>.zip.sha256` to a GitHub Release,
and uses the matching CHANGELOG section as the release notes. Users install by downloading that asset
and uploading it in the dashboard (until the in-dashboard marketplace lands).
