// Vendored OpenWA plugin contract. There is no published @openwa SDK package; keep this in sync
// with the OpenWA version you target. All imports of this module must be `import type`.
//
// v0.7 surface (added below): `ctx.net.fetch` (host-proxied, SSRF-guarded outbound HTTP — gated by the
// "net:fetch" permission + manifest `net.allow` host allowlist), and the manifest fields
// `sessionScoped` (per-session activation; ctx.config is the resolved per-session slice), `net`, and
// `configUi` (a sandboxed-iframe config editor). The richer `configSchema` field set (textarea + enum
// select, array/items, object/properties, min/max/pattern — see PluginConfigField) is plain manifest
// JSON — the plugin still reads `ctx.config` as `Record<string, unknown>` and validates defensively.

export type HookEvent =
  | 'session:created' | 'session:starting' | 'session:ready' | 'session:qr'
  | 'session:disconnected' | 'session:error' | 'session:deleted'
  | 'message:received' | 'message:sending' | 'message:sent' | 'message:failed' | 'message:ack'
  | 'webhook:before' | 'webhook:queued' | 'webhook:delivered' | 'webhook:after' | 'webhook:error';

export interface HookContext<T = unknown> {
  event: HookEvent;
  data: T;
  sessionId?: string;
  timestamp: Date;
  source: string;
}

export interface HookResult<T = unknown> {
  continue: boolean;
  data?: T;
  error?: Error;
}

export type HookHandler<T = unknown> = (ctx: HookContext<T>) => Promise<HookResult<T>>;

export interface PluginLogger {
  log(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, error?: unknown, meta?: Record<string, unknown>): void;
}

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
}

// ── v0.7: host-proxied, SSRF-guarded outbound HTTP ──────────────────────────────────────────────
// Gated by the "net:fetch" permission + manifest `net.allow` (host:port allowlist; deny by default).
// Use this for ALL outbound HTTP — the raw worker `fetch` is unguarded and discouraged.
export interface PluginNetRequestInit {
  method?: string;
  headers?: Record<string, string>;
  // The sandbox bridges the request to the host via structuredClone, which preserves typed arrays —
  // so a binary body (e.g. an assembled multipart/form-data upload) is sent intact. A string body is
  // UTF-8 encoded by the host fetch, so binary MUST be passed as Uint8Array/Buffer, not a string.
  body?: string | Uint8Array;
  timeoutMs?: number;
}

export interface PluginNetResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  headers: Record<string, string>;
  // The actual field the sandbox runtime returns: the response body, read host-side (capped at 10 MiB)
  // and handed back as a UTF-8 string. Parse JSON with `JSON.parse(res.body)`.
  body: string;
  // NOTE: these method forms are NOT provided by the sandbox runtime (functions cannot cross the
  // worker structuredClone boundary). Use `body` above; the methods are retained only so older
  // plugins still type-check. Calling them at runtime throws.
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  arrayBuffer(): Promise<ArrayBuffer>;
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
  /** v0.7: per-session activation (default true). The platform owns which sessions a plugin runs for. */
  sessionScoped?: boolean;
  /** v0.7: outbound HTTP host allowlist for ctx.net.fetch — "host:port" entries; deny by default.
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

export interface PluginContext {
  pluginId: string;
  manifest: PluginManifest;
  /** The RESOLVED config for `sessionId` (the per-session slice merged over the "*" defaults). */
  config: Record<string, unknown>;
  hookManager: unknown;
  logger: PluginLogger;
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
export type WebhookResponse = { status?: number; headers?: Record<string, string>; body?: string };
export type WebhookHandler = (req: WebhookRequest) => Promise<WebhookResponse | void> | WebhookResponse | void;

export type HandoverState = 'bot' | 'human' | 'closed';

export interface ConversationSendEnvelope {
  sessionId?: string;
  instanceId?: string;
  chatId?: string;
  type: 'text' | 'image' | 'file' | 'audio' | 'video' | 'voice' | 'location';
  text?: string;
  mediaUrl?: string;
  replyTo?: string;
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

export interface IncomingMessage {
  id: string;
  from: string;
  to: string;
  chatId: string;
  body: string;
  type: string;
  timestamp: number;
  fromMe: boolean;
  isGroup: boolean;
  author?: string;
  senderPhone?: string | null;
  mentionedIds?: string[];
  contact?: { name?: string; pushName?: string };
  // Inbound media, materialized by the adapter before the hook fires (both engines). `data` is base64
  // and ABSENT when `omitted` is true (the payload exceeded the inbound size cap; `sizeBytes` is still
  // set). For a voice note `type` is `'voice'` and `mimetype` is typically `'audio/ogg; codecs=opus'`.
  media?: {
    mimetype: string;
    filename?: string;
    data?: string;
    omitted?: boolean;
    sizeBytes?: number;
  };
  // The message this one replies to (swipe-to-reply / quote), when present. `id` is the quoted WhatsApp
  // message id; `body` is its text. Carried on the inbound hook payload for reply-threading relays.
  quotedMessage?: { id: string; body: string };
  // Shared location (`type: 'location'`), when present.
  location?: { latitude: number; longitude: number; description?: string; address?: string; url?: string };
}
