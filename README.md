<div align="center">

# OpenWA Plugins

**Official & community plugins for [OpenWA](https://github.com/rmyndharis/OpenWA) — the open-source WhatsApp API Gateway.**

Extend your WhatsApp gateway with drop-in capabilities: log conversations to a spreadsheet, auto-reply to customers, greet new leads, and more — installed in seconds, no fork required.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Built for OpenWA](https://img.shields.io/badge/built%20for-OpenWA-25D366.svg)](https://github.com/rmyndharis/OpenWA)
[![Plugin type](https://img.shields.io/badge/plugin%20type-extension-blue.svg)](#plugin-contract)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

[Install a plugin](#installing-a-plugin) · [Plugin catalog](#plugin-catalog) · [Write your own](#authoring-a-plugin) · [Contributing](#contributing)

</div>

---

> **Status:** Active — a growing catalog. This repository is the home for installable OpenWA plugins and the conventions for building them. The catalog grows as plugins reach release.

## Overview

OpenWA ships with a small, security-first plugin runtime. A plugin is a self-contained folder — a `manifest.json` plus a compiled entry file — that reacts to WhatsApp activity through a typed **hook** system and acts through a narrow, permission-gated **capability** API. Plugins are uploaded as a `.zip`, loaded in a **disabled** state, and only run after an administrator explicitly enables them.

This repository provides:

- **A curated catalog** of ready-to-install plugins, each packaged for the OpenWA dashboard.
- **A reference authoring workflow** — vendored OpenWA types, a one-command build-and-package script, and a worked example you can copy.
- **Accurate, code-verified documentation** of the plugin contract (the upstream design docs describe several features that are not yet implemented; everything here reflects the shipped runtime).

## Plugin catalog

<!-- BEGIN PLUGIN CATALOG -->
| Plugin | Description | Version | Status |
| ------ | ----------- | ------- | ------ |
| [`after-hours`](./after-hours) | Auto-replies with a configurable away/closing message to messages received outside business hours. | 0.1.3 | stable |
| [`chat-flow`](./chat-flow) | Interactive, stateful auto-reply: a trigger word starts a greeting + numbered menu, replies traverse a configurable menu tree, and per-chat state expires after 15 minutes. | 1.0.6 | stable |
| [`chatwoot-adapter`](./chatwoot-adapter) | Two-way sync between a WhatsApp session and a Chatwoot inbox: relays WhatsApp messages (1:1 and groups, with media) into Chatwoot as an API-channel inbox, sends agent replies back to WhatsApp, and hands a chat over to a human agent — silencing other OpenWA bots — when an agent takes it in Chatwoot. First consumer of the OpenWA Integration SDK v1; runs sandboxed in the plugin worker. | 0.5.4 | beta |
| [`faq-bot`](./faq-bot) | Auto-replies to inbound WhatsApp messages from configurable FAQ keyword/regex rules. | 0.1.7 | stable |
| [`group-translate`](./group-translate) | Auto-translates group messages between participants' languages via a LibreTranslate backend. Configure in-chat with /tr commands. Admin-gated; disabled until enabled. | 1.0.6 | stable |
| [`gsheets-logger`](./gsheets-logger) | Logs WhatsApp message events to a Google Sheet via a service account. | 0.2.3 | stable |
| [`http-action`](./http-action) | Triggers safe REST API requests from WhatsApp commands and renders JSON responses back to chat. | 0.1.0 | beta |
| [`supabase-otp-hook`](./supabase-otp-hook) | Deliver Supabase Auth phone OTPs over WhatsApp. | 0.1.0 | beta |
| [`typebot-connector`](./typebot-connector) | Runs a Typebot flow as the brain of a WhatsApp bot: inbound messages drive a Typebot chat session via the live Chat API, and the bot's replies — text, media, and numbered-choice inputs — are sent back to WhatsApp. Auto-starts every chat, handles file-upload steps, and resets when the flow ends or after an idle timeout. Runs sandboxed in the plugin worker; no public URL or webhook required. | 0.1.0 | beta |
| [`voice-transcription`](./voice-transcription) | Transcribes inbound WhatsApp voice notes to text via an OpenAI-compatible speech-to-text backend (self-hosted Speaches/faster-whisper or hosted Groq/OpenAI) and delivers a `message.transcription` event to your webhook — so bots and AI can read and reply to audio. Off the message-delivery path; disabled until enabled. | 1.0.2 | beta |
<!-- END PLUGIN CATALOG -->

The table above is generated from each plugin's `manifest.json` + `CHANGELOG.md` by `npm run catalog`
(and mirrored in [`plugins.json`](./plugins.json)). See [PLUGIN-STANDARD.md](./PLUGIN-STANDARD.md) for the
metadata standard every plugin follows.

## Per-session config support

OpenWA's `sessionScoped` plugins (the default) may carry per-session config **overrides** set via the
dashboard — so two WhatsApp sessions under one plugin instance can run different settings. A plugin
honors overrides only if it re-reads `ctx.config` inside its hook (not a cached snapshot from enable).
The table below is the status for each plugin in this repo. See each plugin's README **Compatibility →
Per-session config** for details and caveats.

| Plugin | Per-session config | Notes |
| ------ | :----------------: | ----- |
| [`after-hours`](./after-hours) | ✅ Supported | All fields per session; takes effect on next message. |
| [`chat-flow`](./chat-flow) | ✅ Supported | All fields per session; flow state is per `(session, chat)`. |
| [`chatwoot-adapter`](./chatwoot-adapter) | ✅ Supported | All fields per session — first-class multi-tenant shape. |
| [`faq-bot`](./faq-bot) | ✅ Supported | All fields per session (different rule sets per number). |
| [`group-translate`](./group-translate) | ⚠️ Supported, with caveat | Config-signature caching; multi-backend isolation needs one instance per session. |
| [`gsheets-logger`](./gsheets-logger) | ❌ Not supported | Single-buffer single-sink design; use one instance per session. |
| [`http-action`](./http-action) | ✅ Supported | All fields per session (different endpoints/action sets). |
| [`supabase-otp-hook`](./supabase-otp-hook) | ✅ Supported | All fields per session; applies to the instance's bound session. |
| [`typebot-connector`](./typebot-connector) | ✅ Supported | All fields per session; flow state is per `(session, chat)`. |
| [`voice-transcription`](./voice-transcription) | ⚠️ Supported, with caveat | Config-signature caching; multi-backend isolation needs one instance per session. |

**On the roadmap:** an automatic closing-greeting plugin for new leads. Want something else? [Open an issue](https://github.com/rmyndharis/OpenWA-plugins/issues) or [contribute one](#contributing).

## Installing a plugin

Plugins are managed by an **ADMIN** API key, either through the OpenWA dashboard (**Plugins** section) or directly over the REST API. Authenticate with either the `X-API-Key` header or `Authorization: Bearer <key>`.

> Replace `https://your-openwa-host` with your gateway's base URL and `<ADMIN_API_KEY>` with an admin-scoped key.

**1. Build the plugin package** (see [Building from source](#building-from-source)) to get `gsheets-logger.zip`, then upload it:

```bash
curl -X POST "https://your-openwa-host/plugins/install" \
  -H "X-API-Key: <ADMIN_API_KEY>" \
  -F "file=@gsheets-logger.zip"
```

**2. Configure it** (secrets are masked on read and preserved on write):

```bash
curl -X PUT "https://your-openwa-host/plugins/gsheets-logger/config" \
  -H "X-API-Key: <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{ "config": { "spreadsheetId": "1AbC...defG", "serviceAccountJson": "{...}", "sheetTab": "Logs" } }'
```

**3. Enable it** — plugins are installed disabled and never auto-enable, even after a restart:

```bash
curl -X POST "https://your-openwa-host/plugins/gsheets-logger/enable" \
  -H "X-API-Key: <ADMIN_API_KEY>"
```

### Management endpoints

All routes require an ADMIN role.

| Method & path | Purpose |
| ------------- | ------- |
| `GET /plugins` | List installed plugins and their status |
| `GET /plugins/:id` | Inspect one plugin (config secrets redacted) |
| `POST /plugins/install` | Upload and install a `.zip` (multipart field `file`) |
| `POST /plugins/:id/enable` | Run the plugin (`onLoad` → `onEnable`) |
| `POST /plugins/:id/disable` | Stop the plugin and unregister its hooks |
| `PUT /plugins/:id/config` | Update config (`{ "config": { ... } }`); fires `onConfigChange` if enabled |
| `DELETE /plugins/:id` | Uninstall and remove files (built-ins are protected) |
| `GET /plugins/:id/health` | Plugin-reported health check |

## Plugin contract

Everything below is verified against the OpenWA runtime, not the aspirational design docs.

A plugin is a directory containing:

```
my-plugin/
├─ manifest.json     # metadata, declared hooks, permissions, config schema
└─ dist/index.js     # compiled entry; default-exports a class implementing IPlugin
```

### Manifest

```jsonc
{
  "id": "my-plugin",            // /^[a-z0-9][a-z0-9._-]*$/i, unique, not reserved
  "name": "My Plugin",
  "version": "1.0.0",           // semver
  "type": "extension",          // only "extension" is user-installable
  "main": "dist/index.js",      // require()-able file inside the package
  "description": "…",
  "permissions": ["messages:send"],   // enforced gates: messages:send · engine:read · net:fetch · webhook:ingress · conversation:send
  "sessions": ["*"],                   // session-id scope; omit ⇒ all sessions
  "hooks": ["message:received"],       // declared interest (informational)
  "configSchema": {                    // drives the dashboard settings form
    "type": "object",
    "properties": {
      "apiKey": { "type": "string", "secret": true, "required": true }
    }
  }
}
```

**Required fields:** `id`, `name`, `version`, `type`, `main`. **Reserved ids** (cannot be shadowed): `whatsapp-web.js`, `baileys`, `auto-reply`, `translation`.

### Entry class — the `IPlugin` lifecycle

The entry file must **`export default` a class** with a no-argument constructor. Every lifecycle method is optional; the loader instantiates the class and calls `onLoad` then `onEnable` when an admin enables the plugin.

```ts
import type { IPlugin, PluginContext } from "../types/openwa";

export default class MyPlugin implements IPlugin {
  async onEnable(ctx: PluginContext): Promise<void> {
    ctx.registerHook("message:received", async (hook) => {
      ctx.logger.log(`Inbound message on session ${hook.sessionId}`);
      return { continue: true }; // never blocks normal processing
    });
  }

  async onDisable(_ctx: PluginContext): Promise<void> {
    // release timers/connections; hooks are auto-unregistered for you
  }

  async healthCheck() {
    return { healthy: true };
  }
}
```

| Method | When it runs |
| ------ | ------------ |
| `onLoad(ctx)` | At enable, before `onEnable` — one-time setup |
| `onEnable(ctx)` | When enabled — register hooks and start work here |
| `onDisable(ctx)` | When disabled — tear down; hooks auto-unregister |
| `onUnload(ctx)` | Before removal from memory |
| `onConfigChange(ctx, newConfig)` | When config is updated (only while enabled) |
| `healthCheck()` | On `GET /plugins/:id/health` |

### Hooks

React to activity with `ctx.registerHook(event, handler, priority?)`. Handlers are `async (ctx: HookContext<T>) => Promise<HookResult<T>>`, run in **ascending priority** order (lower runs first; default `100`), and receive `{ event, data, sessionId?, timestamp, source }`. Return `{ continue: true }` to pass through, `{ continue: false }` to stop the chain, or `{ continue: true, data }` to transform the payload for downstream handlers.

| Group | Events |
| ----- | ------ |
| **Session** | `session:created` · `session:starting` · `session:ready` · `session:qr` · `session:disconnected` · `session:error` · `session:deleted` |
| **Message** | `message:received` · `message:sending` · `message:sent` · `message:failed` · `message:ack` |
| **Webhook** | `webhook:before` · `webhook:queued` · `webhook:delivered` · `webhook:after` · `webhook:error` |

### Capabilities

The `PluginContext` exposes a deliberately small surface. The two action capabilities are gated by `manifest.permissions` — calling one you didn't declare throws `PluginCapabilityError`.

| Capability | Methods | Permission |
| ---------- | ------- | ---------- |
| `ctx.messages` | `sendText(session, chat, text)` · `reply(session, chat, quotedId, text)` | `messages:send` |
| `ctx.engine` (read-only) | `getGroupInfo` · `getContacts` · `getContactById` · `checkNumberExists` · `getChats` · `getChatHistory` (0.8.5+) · `canonicalChatId` (0.8.7+) | `engine:read` |
| `ctx.net` | `fetch(url, init)` — host-proxied, SSRF-guarded outbound HTTP (0.7+) | `net:fetch` + manifest `net.allow` |
| `ctx.conversations` | `send(envelope)` — normalized outbound (text/image/file/audio/video/voice/location) (v1) | `conversation:send` |
| `ctx.handover` | `set(…, state)` — bot/human/closed handover for a mapped chat (v1) | `conversation:send` |
| `ctx.mappings` | `upsert` · `get` · `getByProvider` — WA-chat ↔ provider-conversation mapping (v1) | `conversation:send` |
| `ctx.registerWebhook` | claim an inbound ingress route (v1) | `webhook:ingress` |
| `ctx.storage` | `get` · `set` · `delete` · `list` (namespaced per plugin) | — |
| `ctx.logger` | `log` · `debug` · `warn` · `error` | — |

Also available: `ctx.config`, `ctx.manifest`, `ctx.pluginId`, `ctx.registerHook`, `ctx.hookManager`.

### Constraints to design around

- **Ship JavaScript, not TypeScript.** The loader `require()`s `main` directly with no transpile step. Author in TS and bundle to a single `dist/index.js`.
- **`type` must be `extension`.** Engine, storage, queue, and auth plugins are first-party built-ins and cannot be installed at runtime.
- **Package limits:** `.zip` ≤ 5 MB compressed, ≤ 200 files, ≤ 20 MB uncompressed. Bundle your dependencies — there is no `npm install` at install time.
- **No published SDK package.** Vendor the OpenWA types (see [`types/openwa.d.ts`](./types/openwa.d.ts)); they are the de-facto contract.
- **Sandboxed worker.** Since OpenWA v0.6.0 each plugin runs in its own worker thread; capabilities and outbound HTTP are host-gated (`ctx.net.fetch` is SSRF-guarded; every capability is checked against the declared `permissions`). The worker still has Node APIs within its thread, so install only plugins you trust.
- **Compatibility is unmanaged.** There is no host-version negotiation yet. Pin the OpenWA version you tested against in your plugin's README.

## Authoring a plugin

1. **Scaffold** a new folder at the repo root (copy [`gsheets-logger`](./gsheets-logger) as a starting point).
2. **Write `manifest.json`** and an `index.ts` whose default export implements `IPlugin`.
3. **Keep host-free logic separate** from host adapters (see the example's split between pure mapping and the I/O client) so it stays unit-testable without OpenWA.
4. **Validate config defensively** inside `onLoad`/`onEnable` — the host does not enforce your `configSchema` types, only redacts `secret` fields.
5. **Build and package**, then install the resulting `.zip` into a local OpenWA instance to verify.

### Building from source

```bash
# Bundle a plugin's TypeScript into a single dist/index.js and produce <plugin>.zip
node package.mjs gsheets-logger
```

The build bundles the entry to a single CommonJS file (exposing `.default`) with [esbuild](https://esbuild.github.io/) — a dev-only dependency — and zips it together with `manifest.json`. The shipped bundle uses only Node built-ins, so the package stays well within the install limits.

## Repository structure

```
OpenWA-plugins/
├─ README.md
├─ LICENSE
├─ types/
│  └─ openwa.d.ts        # vendored OpenWA plugin interfaces (the contract)
├─ package.mjs           # `node package.mjs <plugin>` → bundle + zip
└─ <plugin>/             # one folder per plugin
   ├─ manifest.json
   ├─ index.ts           # default-exports an IPlugin class
   ├─ …                  # supporting modules + tests
   └─ dist/index.js      # built artifact (manifest.main)
```

## Compatibility

Each plugin declares its `minOpenWAVersion` (ranging from 0.6.x to 0.8.x in this repo — see the plugin's README Details). OpenWA does not yet hard-enforce host-version compatibility, so always test a plugin against your specific OpenWA version before enabling it in production.

## Contributing

Contributions are welcome — new plugins, fixes, and documentation.

1. Fork and branch from `main`.
2. Add your plugin in its own folder following the [authoring guide](#authoring-a-plugin), including a per-plugin `README.md` with setup steps and a config reference.
3. Include at least one runnable test for non-trivial logic.
4. Ensure the plugin builds and packages cleanly with `node package.mjs <plugin>`.
5. Open a pull request describing what the plugin does and the OpenWA version you tested against.

Please keep plugins focused, dependency-light, and least-privilege — declare only the permissions and session scope you actually need.

## Security

Plugins run in a **sandboxed worker thread** (since OpenWA v0.6.0): capabilities and outbound HTTP are host-gated (`ctx.net.fetch` is SSRF-guarded; every capability is checked against the declared `permissions`). The worker still has Node APIs within its thread, so treat every plugin as trusted code:

- Only install plugins from sources you trust.
- Review the manifest's `permissions` and `sessions` before enabling.
- Store secrets via the dashboard's `secret`-flagged config fields, never in source.

Found a security issue in a plugin here? Please report it privately via the [OpenWA security policy](https://github.com/rmyndharis/OpenWA/security) rather than opening a public issue.

## License

[MIT](LICENSE) © Yudhi Armyndharis & OpenWA Contributors.

<div align="center">
<sub>Built for <a href="https://github.com/rmyndharis/OpenWA">OpenWA</a> — the free, self-hosted WhatsApp API Gateway.</sub>
</div>
