// Vendored OpenWA plugin contract. There is no published @openwa SDK package; keep this in sync
// with the OpenWA version you target. All imports of this module must be `import type`.
//
// Last aligned against OpenWA core v0.20.0 (tag), verified field-by-field against
// src/core/plugins/plugin.interfaces.ts, src/core/hooks/hook.interfaces.ts, plugin-net.ts,
// sandbox/{worker-bootstrap,worker-capability,worker-hooks,worker-webhooks}.ts and
// src/engine/interfaces/whatsapp-engine.interface.ts. Where this file narrows the host on purpose it
// says so; where the host is stricter than this file, the comment names the runtime consequence.
// The 0.19.0 → 0.20.0 diff over those files is empty; 0.20.0's plugin-facing changes live elsewhere
// (the production #sha256 pin on URL installs in plugin-download.ts, ingress text/plain reflections,
// credential-dir modes) and none of them alter a member this file tracks. The 0.14.5 → 0.19.0 diff
// over those files changes no member this file tracks either: the one behavioral
// addition in that range — the "storage:use" gate on ctx.storage — was already vendored above. That
// alignment also fixed two SILENT OMISSIONS that had survived every earlier pass: `manifest.sdkVersion`
// and the typed `manifest.ingress` route (with IngressSignatureSpec / IngressResponseContract), both
// shipped by the host since 0.7.18. A manifest field this file doesn't type is a field nothing checks —
// which is how a numeric sdkVersion ("1" → 1) reached main and crashed the host's load-time validation.
//
// ⚠️ "verified field-by-field" is a HAND check, and nothing enforces it — this repo ships separately
// and cannot import from core. It has been wrong before: the v0.14.0 alignment silently omitted six
// host fields, four of which predated it by several minor versions, and every one of them was an
// unannounced gap rather than a deliberate narrowing. When re-aligning, diff MEMBER BY MEMBER against
// the six files named above and annotate anything left out, so a future reader can tell an omission
// from a decision.
//
// v0.7 surface: `ctx.net.fetch` (host-proxied, SSRF-guarded outbound HTTP — gated by the
// "net:fetch" permission + manifest `net.allow` host allowlist), and the manifest fields
// `sessionScoped` (per-session activation; ctx.config is the resolved per-session slice), `net`, and
// `configUi` (a sandboxed-iframe config editor). The richer `configSchema` field set (textarea + enum
// select, array/items, object/properties, min/max/pattern — see PluginConfigField) is plain manifest
// JSON — the plugin still reads `ctx.config` as `Record<string, unknown>` and validates defensively.
//
// Host bounds a plugin cannot see from the types (v0.12.0 defaults, all host-side):
//   30 s per lifecycle phase (onLoad/onEnable/onDisable/onUnload) and per capability call, except
//   the send verbs (messages.sendText / messages.reply / conversations.send) which get 120 s;
//   5 s per hook dispatch (overrun → the host fails OPEN with {continue:true} and drops your result);
//   32 concurrent capability calls per plugin (the 33rd throws);
//   16 concurrent net.fetch calls GLOBALLY — shared across ALL plugins and workers, not per plugin;
//   50 MiB total ctx.storage per plugin; 10 MiB net.fetch response body;
//   200 log lines / 10 s, 8 KiB per line.

export type HookEvent =
  | 'session:created' | 'session:starting' | 'session:ready' | 'session:qr'
  | 'session:disconnected' | 'session:error' | 'session:deleted'
  | 'message:received' | 'message:sending' | 'message:sent' | 'message:failed' | 'message:ack' | 'message:persisted'
  // v0.12: emitted when the host deletes a redundant echo row during send reconciliation. The payload
  // is `{ sessionId, message }` where `message` is the host's persisted DB row — NOT an IncomingMessage.
  | 'message:deleted'
  | 'webhook:before' | 'webhook:queued' | 'webhook:delivered' | 'webhook:after' | 'webhook:error'
  | 'ingress:error';

export interface HookContext<T = unknown> {
  event: HookEvent;
  data: T;
  sessionId?: string;
  timestamp: Date;
  source: string;
}

export interface HookResult<T = unknown> {
  /**
   * `false` stops the remaining handler chain — nothing more.
   *
   * On a NOTIFICATION event (`message:received`, `message:sent`, `session:*`, …) that means you claim
   * the event against sibling plugins only: the host still persists the message, still dispatches it
   * to webhooks, and still pushes it over the websocket. Use it for "I answered this, don't let
   * another bot answer too" — never to hide an event.
   *
   * It is a real VETO only on the two pre-action events: `message:sending` (blocks the send; the API
   * caller gets HTTP 400 "Message sending blocked by plugin") and `webhook:before` (cancels that one
   * webhook delivery).
   */
  continue: boolean;
  data?: T; // modified data, threaded to the next handler and applied by the host
  /**
   * In-process (built-in plugin) only — the sandbox wire result carries just `{continue, data}`, so a
   * sandboxed marketplace plugin CANNOT surface a failure this way. Throw instead: the host catches
   * it, keeps the chain running, and records it on the plugin's health surface.
   */
  error?: Error;
}

// Returning a plain (non-promise) result is accepted — the worker awaits either form.
export type HookHandler<T = unknown> = (ctx: HookContext<T>) => Promise<HookResult<T>> | HookResult<T>;

export interface PluginLogger {
  log(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, error?: unknown, meta?: Record<string, unknown>): void;
}

/**
 * Per-plugin key/value storage. Needs the "storage:use" permission — all four verbs assert it, so an
 * undeclared plugin is denied at the first call rather than at load. It was ungated until OpenWA gated
 * it (core `plugin-capability-context.ts` `buildStorageCapability`); declaring it is inert on an older
 * host, which is why a plugin should declare it now rather than when its host is upgraded.
 *
 * One JSON file per key under `<dataDir>/plugins/<pluginId>/`, so key COUNT is a real cost, not just
 * key size:
 *
 * - `set` REJECTS once the plugin's directory would exceed 50 MiB ("storage quota exceeded"), and the
 *   quota is measured by a synchronous readdir + stat of every key on EVERY write. A plugin that
 *   writes one key per message therefore pays O(keys) syscalls per message, on the host's event loop.
 *   Prefer bucketed keys (one key per session per hour holding a map) over one key per message, and
 *   always handle a rejected `set` — dropping it silently turns a full quota into lost data.
 * - `list()` with no prefix returns every key in the directory, which in a layout where package files
 *   and state share a directory can include `manifest`/`package`; pass a prefix (the host filters for
 *   you) or re-filter. On a read error `list` resolves `[]` rather than rejecting.
 */
export interface PluginStorage {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export interface MessageResponseDto {
  messageId: string;
  timestamp: number;
}

export interface PluginMessagingCapability {
  sendText(sessionId: string, chatId: string, text: string): Promise<MessageResponseDto>;
  reply(sessionId: string, chatId: string, quotedMessageId: string, text: string): Promise<MessageResponseDto>;
}

export interface ChatSummary {
  id: string;
  name: string;
  isGroup: boolean;
  /** User-facing chat kind. `isGroup` is retained for back-compat; `kind` is the full discriminator. */
  kind: ChatKind;
  unreadCount: number;
  timestamp: number;
  lastMessage?: string;
}

export interface PluginEngineReadCapability {
  getGroupInfo(sessionId: string, groupId: string): Promise<unknown>;
  getContacts(sessionId: string): Promise<unknown>;
  getContactById(sessionId: string, contactId: string): Promise<unknown>;
  checkNumberExists(sessionId: string, phone: string): Promise<unknown>;
  getChats(sessionId: string): Promise<unknown>;
  /** Recent messages for a chat, both directions (v0.8.5+). The host clamps `limit` (max 100). */
  getChatHistory(sessionId: string, chatId: string, limit?: number, includeMedia?: boolean): Promise<IncomingMessage[]>;
  /**
   * Canonical (neutral) form of a chat id: resolves a `@lid` privacy id to its stable `<phone>@c.us` when
   * the mapping is known, else returns the id unchanged. Lets a plugin key a chat by one identity across
   * WhatsApp's `@lid` migration (best-effort). Available on OpenWA 0.8.7+.
   */
  canonicalChatId(sessionId: string, chatId: string): Promise<string>;
}

// ── v0.7: host-proxied, SSRF-guarded outbound HTTP ──────────────────────────────────────────────
// Gated by the "net:fetch" permission + manifest `net.allow` (host allowlist, port optional; deny by default).
// Use this for ALL outbound HTTP — the raw worker `fetch` is unguarded and discouraged.
export interface PluginNetRequestInit {
  method?: string;
  headers?: Record<string, string>;
  // The sandbox bridges the request to the host via structuredClone, which preserves typed arrays, so
  // a binary body (e.g. an assembled multipart/form-data upload) is sent intact. A string body is
  // UTF-8 encoded by the host fetch, so binary MUST be passed as Uint8Array/Buffer, not a string.
  body?: string | Uint8Array;
  // Host default 15 s, host maximum 30 s; a value <= 0 is clamped to 1 ms (every request then aborts).
  // Note this is the FETCH budget, which races the outer 30 s capability-call budget — keep it lower.
  timeoutMs?: number;
}

/**
 * The whole response object, exactly as it crosses the worker boundary. There are no `text()`/`json()`/
 * `arrayBuffer()` methods — functions cannot survive structuredClone. Parse with `JSON.parse(res.body)`.
 */
export interface PluginNetResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  // The response body, read host-side (capped at 10 MiB) and handed back as a UTF-8 string.
  body: string;
}

export interface PluginNetCapability {
  fetch(url: string, init?: PluginNetRequestInit): Promise<PluginNetResponse>;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  type: string;
  main: string;
  permissions?: string[];
  sessions?: string[];
  hooks?: HookEvent[];
  /** Integration SDK major.minor the plugin was authored against (e.g. '1' or '1.2'). STRING — the
   *  host's ingress validation calls sdkVersion.split('.'), so a JSON number (1, not "1") throws at
   *  load and the whole plugin comes up ERROR. Only the major is enforced; absent = treated as '1'. */
  sdkVersion?: string;
  /** Inbound webhook routes this plugin claims (needs the "webhook:ingress" permission). Validated by
   *  the host at load: SDK-major match, the permission, unique non-empty routes, toleranceSec > 0, and
   *  no scheme:'none' route unless the operator opted in (ALLOW_UNSIGNED_INGRESS). */
  ingress?: PluginIngressRoute[];
  /** v0.7: per-session activation (default true). The platform owns which sessions a plugin runs for. */
  sessionScoped?: boolean;
  /** v0.7: outbound HTTP host allowlist for ctx.net.fetch — "host" or "host:port"; deny by default.
   *  The catalogue uses both forms: a bare host matches any port, which is what most entries rely on.
   *  v1: `allowConfigHosts` additionally admits the host of each named config key (e.g. "baseUrl"). */
  net?: { allow: string[]; allowConfigHosts?: string[] };
  /** v0.7: a sandboxed-iframe config editor served by the host. */
  configUi?: { entry: string; height?: number };
  /** Declarative config schema (rendered by the host into an authenticated form). */
  configSchema?: PluginConfigSchema;
  /** Localization strings for the dashboard Catalog tab, keyed by BCP-47 locale tag. */
  i18n?: PluginI18n;
  [key: string]: unknown;
}

/**
 * v0.7 declarative config schema — the host renders it into an authenticated form. Recursive: an
 * `object` field nests `properties`; an `array` field describes its element via `items` (an
 * array-of-rows when `items.type === 'object'`). The plugin still reads `ctx.config` as
 * `Record<string, unknown>` and validates defensively — the schema only drives the host's form.
 */
export interface PluginConfigField {
  /** 'textarea' is a multi-line string; a field with `enum` renders as a <select>. */
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'textarea';
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  required?: boolean;
  /** Sensitive value (API key, token): masked on read, preserved on an unchanged write — at any depth. */
  secret?: boolean;
  /** Validation hints surfaced as HTML input attributes (advisory; not hard-enforced by the host). */
  min?: number; // number: value bound; string/textarea: minLength; array: min rows
  max?: number; // number: value bound; string/textarea: maxLength; array: max rows
  pattern?: string; // string/textarea: HTML validation regex
  items?: PluginConfigField; // array element schema; array-of-rows when items.type === 'object'
  properties?: Record<string, PluginConfigField>; // nested-object fields (type: 'object')
}

export interface PluginConfigSchema {
  type: 'object';
  properties: Record<string, PluginConfigField>;
}

/** Localized display text for a plugin or one of its config fields. */
export interface PluginI18nText {
  title?: string;
  description?: string;
}

/** Translations for a single BCP-47 locale (e.g. "es", "zh-CN"). */
export interface PluginI18nLocale {
  name?: string;
  description?: string;
  config?: Record<string, PluginI18nText>;
}

/** Map of BCP-47 locale tag → locale translations. Set as `manifest.i18n`. */
export type PluginI18n = Record<string, PluginI18nLocale>;

// ── Integration SDK v1: inbound webhook ingress (manifest side) ────────────────────────────────
export interface IngressSignatureSpec {
  /**
   * - `hmac-sha256`: HMAC over `contentTemplate` (tokens `{rawBody}`/`{timestamp}`/`{id}`).
   * - `shared-secret`: constant-time compare of a header value against `instance.secret`.
   * - `standard-webhooks`: host-side Standard Webhooks verify (headers `webhook-id`/`webhook-timestamp`/
   *   `webhook-signature`, signed content `${webhook-id}.${webhook-timestamp}.${rawBody}`, base64
   *   HMAC-SHA256 with the base64-decoded Svix key, `v1,` prefix). The wire format is fixed by the
   *   spec, so `header`/`contentTemplate`/`encoding`/`prefix`/`timestampHeader` are IGNORED — only
   *   `toleranceSec` and `dedupHeader` apply. The operator pastes the Svix secret as `instance.secret`.
   * - `none`: fully unauthenticated public endpoint — rejected at load unless the operator set
   *   ALLOW_UNSIGNED_INGRESS=true.
   */
  scheme: 'hmac-sha256' | 'shared-secret' | 'standard-webhooks' | 'none';
  header?: string;
  contentTemplate?: string;
  encoding?: 'hex' | 'base64';
  prefix?: string;
  timestampHeader?: string;
  /** Replay window for timestampHeader; must be > 0 when present (host default 300 applies when absent). */
  toleranceSec?: number;
  dedupHeader?: string;
}

export interface IngressResponseContract {
  /** Host-side preflight gates run before the delivery is accepted. */
  preflight?: Array<{ type: 'session-alive' }>;
  /** The synchronous reply the host sends instead of default-202. `body` may template
   *  `{rawBody}`/`{timestamp}`/`{id}`. A WebhookResponse returned from the handler is ignored —
   *  this ack is the only synchronous reply. */
  ack?: { status?: number; body?: string; headers?: Record<string, string> };
  deadlineMs?: number; // documented provider ack budget (advisory; not enforced)
}

export interface PluginIngressRoute {
  route: string; // host prefixes it; the plugin never binds a port
  /** 'sync-reply' is inert dead code — the pipeline is always async + fast-ack; declare synchronous
   *  behavior via `response` instead. Kept in the union for SDK v1 additive-only compatibility. */
  mode: 'async' | 'sync-reply';
  signature: IngressSignatureSpec;
  challenge?: { method: 'GET'; tokenParam: string; echoParam: string };
  /** Authenticity is verified by the host per `signature`; the worker does no extra 'self' pass. */
  verify: 'core' | 'self';
  maxBodyBytes: number;
  /** Where the provider's conversation id lives, so the host can compute a per-conversation ordering
   *  key. Absent ⇒ per-instance serialization. */
  conversationId?: { header?: string; jsonPointer?: string };
  response?: IngressResponseContract;
}

/**
 * What a SANDBOXED plugin receives. There is no `manifest` and no `hookManager` on the sandbox context
 * (see core `sandbox/worker-bootstrap.ts`) — reading `ctx.manifest.version` would typecheck against an
 * older copy of this file and throw at runtime, so both are omitted here.
 *
 * One member is deliberately NOT vendored: `registerSearchProvider`, which the host does provide. No
 * plugin here is a search backend, and typing it would mean hand-copying the host's SearchQuery /
 * SearchResults shapes with nothing to keep them honest. Adding it needs the `search:provide`
 * permission in the manifest (required since core 0.12.2 — the host denies the registration outright
 * without it), and under the default SEARCH_PROVIDER=auto a plugin that registers becomes the
 * gateway's ACTIVE search backend, superseding builtin-fts — worth knowing before adding it.
 */
export interface PluginContext {
  pluginId: string;
  /** The RESOLVED config for `sessionId` (the per-session slice merged over the "*" defaults). */
  config: Record<string, unknown>;
  logger: PluginLogger;
  /** Per-plugin key/value store (needs the "storage:use" permission — see PluginStorage). */
  storage: PluginStorage;
  registerHook(event: HookEvent, handler: HookHandler, priority?: number): void;
  messages: PluginMessagingCapability;
  engine: PluginEngineReadCapability;
  /** v0.7: host-proxied, SSRF-guarded outbound HTTP (needs the "net:fetch" permission + manifest net.allow). */
  net: PluginNetCapability;
  /** v1: claim an inbound ingress webhook route (needs the "webhook:ingress" permission). */
  registerWebhook(route: string, handler: WebhookHandler): void;
  /** v1: normalized outbound send, translated host-side to MessageService (needs "conversation:send"). */
  conversations: PluginConversationsCapability;
  /** v1: flip a mapped conversation's bot/human/closed handover state (needs "conversation:send"). */
  handover: PluginHandoverCapability;
  /** v1: create/read the WA-chat <-> provider-conversation mapping (needs "conversation:send"). */
  mappings: PluginMappingsCapability;
}

// ── Integration SDK v1: inbound webhook ingress, normalized send, handover, conversation mapping ────
export interface WebhookRequest {
  instanceId: string;
  method: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body: string;
  rawBody: string;
  verified: boolean;
  deliveryId: string;
  sessionId?: string;
}
/**
 * IGNORED by the host: the ingress pipeline reads only whether your handler resolved or threw. The
 * provider's synchronous reply is computed host-side from `manifest.ingress[].response.ack` (default
 * 202). Kept on the signature so existing handlers still typecheck — do not design against it.
 */
export type WebhookResponse = { status?: number; headers?: Record<string, string>; body?: string };
export type WebhookHandler = (req: WebhookRequest) => Promise<WebhookResponse | void> | WebhookResponse | void;

export type HandoverState = 'bot' | 'human' | 'closed';

/**
 * Per-type behavior of the host facade — the type union alone does not tell you which combinations
 * throw. `PluginCapabilityError` is thrown (not swallowed) for each rejection below.
 *
 * - `text`: sent as text; with `replyTo` it becomes a quote-reply.
 * - media (`image`/`file`/`audio`/`video`/`voice`) WITH `mediaUrl`: native media, `text` is the
 *   caption. Setting `replyTo` on a media part THROWS — the engine media path cannot quote.
 * - media WITHOUT `mediaUrl`: silently falls through to a text send, so an unset `text` delivers an
 *   EMPTY message. Put the URL in `text` if that is your fallback.
 * - `location`: needs `latitude`/`longitude`, else it THROWS (it no longer degrades to a text link).
 *   `replyTo` on a location also THROWS. `text` doubles as the location description.
 */
export interface ConversationSendEnvelope {
  sessionId?: string;
  instanceId?: string;
  chatId?: string;
  type: 'text' | 'image' | 'file' | 'audio' | 'video' | 'voice' | 'location';
  text?: string;
  mediaUrl?: string;
  replyTo?: string;
  /**
   * Ask the engine for a link preview on a plain text send. Baileys generates one only when this is
   * `true`, so a plugin relaying a URL gets a bare link without it; whatsapp-web.js previews by
   * default and takes `false` to suppress. Ignored on media, location and quoted sends, which route
   * through engine paths that take no preview option.
   */
  linkPreview?: boolean;
  /** WGS84, required for `type: 'location'` (-90..90 / -180..180), ignored otherwise. */
  latitude?: number;
  longitude?: number;
  source?: { provider: string; externalConversationId: string };
}
export interface PluginConversationsCapability {
  send(env: ConversationSendEnvelope): Promise<unknown>;
}
export interface PluginHandoverCapability {
  set(key: { sessionId: string; chatId: string; instanceId: string }, state: HandoverState): Promise<unknown>;
}
export interface PluginMappingsCapability {
  upsert(key: { sessionId: string; chatId: string; instanceId: string }, providerConversationId: string): Promise<unknown>;
  get(
    key: { sessionId: string; chatId: string; instanceId: string },
  ): Promise<{ providerConversationId: string; handoverState: HandoverState } | null>;
  getByProvider(
    instanceId: string,
    providerConversationId: string,
  ): Promise<{ sessionId: string; chatId: string; handoverState: HandoverState } | null>;
}

export interface IPlugin {
  onLoad?(context: PluginContext): Promise<void>;
  onEnable?(context: PluginContext): Promise<void>;
  onDisable?(context: PluginContext): Promise<void>;
  onUnload?(context: PluginContext): Promise<void>;
  onConfigChange?(context: PluginContext, newConfig: Record<string, unknown>): Promise<void>;
  healthCheck?(): Promise<{ healthy: boolean; message?: string }>;
}

/** User-facing chat kind, derived from `chatId` host-side. `@lid` folds into 'individual'. */
export type ChatKind = 'individual' | 'group' | 'channel' | 'status' | 'broadcast' | 'unknown';

export interface IncomingMessage {
  id: string;
  from: string;
  to: string;
  chatId: string;
  /** Empty string for every non-text type (sticker, voice, image without caption, …) — guard on
   *  `!body.trim()`, not just on `typeof body`, before treating it as a command or menu key. */
  body: string;
  /** Host `MessageType`: text|image|video|audio|voice|document|sticker|location|contact|poll|call|
   *  revoked|masked|unknown. Kept as `string` here so a new host type never breaks a typecheck. */
  type: string;
  timestamp: number;
  fromMe: boolean;
  isGroup: boolean;
  /** Required on the host payload; optional here because plugins only ever read it. */
  kind?: ChatKind;
  /** In a GROUP, `from` is the group JID — `author` is the only real sender. */
  author?: string;
  /** The sender is identified by a privacy id (`@lid`) rather than a phone number. */
  isLidSender?: boolean;
  /** A status/story broadcast rather than a real conversation. */
  isStatusBroadcast?: boolean;
  /**
   * Best-effort sender MSISDN, and only for `@lid` senders with RESOLVE_LID_TO_PHONE enabled. The host
   * assigns it AFTER the `message:received` hook chain has run, so a hook handler always observes
   * `undefined`.
   *
   * To get digits at hook time, take the local part of the sender JID — but ONLY when the JID is a real
   * user, on an ALLOWLIST, never a denylist: `@lid` (privacy id), `@g.us` (group), `@newsletter`
   * (channel) and `@broadcast` all have numeric local parts too, and passing one of those on as a phone
   * number is worse than passing nothing (it silently keys a CRM lookup or an authorization check to a
   * number belonging to nobody). Also strip the multi-device suffix Baileys can append:
   *
   *   const jid = msg.author ?? msg.from;                    // in a group, `from` is the GROUP
   *   const at = jid.lastIndexOf('@');
   *   const dom = at < 0 ? '' : jid.slice(at + 1).toLowerCase();
   *   const user = at < 0 ? '' : jid.slice(0, at).split(':')[0];   // 628123:12@s.whatsapp.net
   *   const phone = (dom === 'c.us' || dom === 's.whatsapp.net') && /^\d+$/.test(user) ? user : '';
   */
  senderPhone?: string | null;
  mentionedIds?: string[];
  contact?: MessageContact;
  // Inbound media, materialized by the adapter before the hook fires (both engines). `data` is base64
  // and ABSENT when `omitted` is true (`sizeBytes` is still set). For a voice note `type` is `'voice'`
  // and `mimetype` is typically `'audio/ogg; codecs=opus'`.
  media?: {
    mimetype: string;
    filename?: string;
    data?: string;
    /** True when the blob was dropped for ANY of: the inbound size cap, a download timeout, or
     *  download-concurrency saturation. Do NOT tell the user "that file was too large" — it may
     *  simply have failed to download and be worth retrying. */
    omitted?: boolean;
    sizeBytes?: number;
  };
  // The message this one replies to (swipe-to-reply / quote), when present. `id` is the quoted WhatsApp
  // message id; `body` is its text. Carried on the inbound hook payload for reply-threading relays.
  quotedMessage?: { id: string; body: string };
  // Shared location (`type: 'location'`), when present.
  location?: { latitude: number; longitude: number; description?: string; address?: string; url?: string };
  /** WhatsApp disappearing-messages timer in seconds, per chat, on every message. 0 or absent = no
   *  timer. Known values: 86400 (24h), 604800 (7d), 7776000 (90d). */
  ephemeralDuration?: number;
  /** Set for `call` (call_log) messages: video vs voice, and whether an incoming call went
   *  unanswered. */
  call?: { video: boolean; missed: boolean };
  /** Styling of a text status/story: background as `#RRGGBB`. Only set by engines that expose it. */
  backgroundColor?: string;
  /** Styling of a text status/story: the WhatsApp font index. Only set by engines that expose it. */
  font?: number;
}

/**
 * Sender contact info on `IncomingMessage.contact` — synchronous cache fields only (the host omits the
 * async getters that would hit WhatsApp per message). Every field is optional and in practice both
 * engines populate little more than `pushName`, so treat anything else as absent unless proven.
 */
export interface MessageContact {
  /** Sender JID (`…@c.us` or a `…@lid` privacy id). */
  id?: string;
  /** Phone digits, best-effort. For `@lid` senders `IncomingMessage.senderPhone` is authoritative. */
  number?: string;
  name?: string;
  pushName?: string;
  shortName?: string;
  type?: string;
  isMyContact?: boolean;
  isWAContact?: boolean;
  isBusiness?: boolean;
  isEnterprise?: boolean;
  verifiedName?: string;
  verifiedLevel?: number;
  isBlocked?: boolean;
  /** Label IDs (CRM). Names are not resolved — that would need a network call. */
  labels?: string[];
}
