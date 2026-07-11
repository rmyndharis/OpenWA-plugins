// Config parsing + validation for HTTP Action Bot. Pure (no ctx) so it tests without OpenWA.
//
// Security-critical: WhatsApp message text is attacker-controlled, so every value the plugin later
// interpolates into an outbound request is bounded HERE — fixed https origin (an allowConfigHosts key,
// so no code-side default: the net gate resolves the allowed host from RAW ctx.config), relative-only
// path (no protocol-relative //, no absolute URL, no fragment, no control chars), and a header blocklist
// (hop-by-hop + forwarding headers + CRLF). See roadmap §4.5 + §1.2 #3.

export type AuthType = 'none' | 'bearer' | 'apikey';
export type MatchType = 'exact' | 'prefix';
export type Method = 'GET' | 'POST';

export interface ActionMatch {
  type: MatchType;
  value: string;
  caseSensitive: boolean;
}

export interface ActionRequest {
  method: Method;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  bodyTemplate?: string;
}

export interface HttpAction {
  id: string;
  match: ActionMatch;
  request: ActionRequest;
  replyTemplate: string;
  notFoundTemplate?: string;
  errorTemplate?: string;
}

export interface HttpActionConfig {
  baseUrl: string;          // https origin, no trailing slash, no credentials, no fragment
  authType: AuthType;
  authToken?: string;       // bearer token or apikey value (configSchema secret)
  apiKeyHeader: string;     // header name for authType=apikey
  respondInGroups: boolean;
  timeoutMs: number;
  cooldownSeconds: number;
  actions: HttpAction[];
}

const MAX_ACTIONS = 25;

// Reserved/semantics-bearing headers config must not set (host smuggling, hop-by-hop, forwarding chain).
const DANGEROUS_HEADERS = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'te', 'trailer',
  'upgrade', 'proxy-authorization', 'proxy-authenticate', 'expect',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
  'x-forwarded-port', 'x-forwarded-server', 'x-real-ip',
]);

// Action ids become log labels — constrain to a safe charset so they can't break structured logs.
const ACTION_ID_RE = /^[A-Za-z0-9_-]+$/;

function fail(field: string, why: string): never {
  throw new Error(`http-action: invalid config — ${field}: ${why}`);
}

export function isDangerousHeader(name: string): boolean {
  return DANGEROUS_HEADERS.has(name.toLowerCase().trim());
}

export function isAllowedMethod(m: unknown): m is Method {
  return m === 'GET' || m === 'POST';
}

// path must be server-relative only: leading single /, not protocol-relative (//), not an absolute URL
// (no leading /), no fragment, no control/null chars.
export function validatePath(path: unknown, field: string): string {
  if (typeof path !== 'string' || path.length === 0) fail(field, 'path is required');
  if (!path.startsWith('/')) fail(field, 'path must be relative and start with /');
  if (path.startsWith('//')) fail(field, 'path must not be protocol-relative (//)');
  if (path.includes('#')) fail(field, 'path must not contain a fragment (#)');
  if (/[\r\n\t\0]/.test(path)) fail(field, 'path must not contain control/null characters');
  return path;
}

function validateStringMap(v: unknown, field: string, isHeaders: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  if (v === undefined || v === null) return out;
  if (typeof v !== 'object') fail(field, 'must be an object');
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const ks = String(k);
    const vs = String(val);
    if (/[\r\n]/.test(ks) || /[\r\n]/.test(vs)) fail(field, 'entry contains CR/LF (header injection)');
    if (isHeaders && isDangerousHeader(ks)) fail(`${field}.${ks}`, 'reserved/dangerous header is not allowed');
    out[ks] = vs;
  }
  return out;
}

function validateAction(a: unknown, idx: number): HttpAction {
  const field = `actions[${idx}]`;
  if (typeof a !== 'object' || a === null) fail(field, 'action must be an object');
  const o = a as Record<string, unknown>;

  const id = String(o.id ?? '').trim();
  if (!id) fail(`${field}.id`, 'id is required');
  if (!ACTION_ID_RE.test(id)) fail(`${field}.id`, 'id may only contain A-Z a-z 0-9 _ -');

  const m = o.match;
  if (typeof m !== 'object' || m === null) fail(`${field}.match`, 'match is required');
  const mm = m as Record<string, unknown>;
  if (mm.type !== 'exact' && mm.type !== 'prefix') fail(`${field}.match.type`, "type must be 'exact' or 'prefix'");
  const matchValue = typeof mm.value === 'string' ? mm.value : '';
  if (matchValue.length === 0) fail(`${field}.match.value`, 'value is required and must be non-empty');

  const r = o.request;
  if (typeof r !== 'object' || r === null) fail(`${field}.request`, 'request is required');
  const rr = r as Record<string, unknown>;
  if (!isAllowedMethod(rr.method)) fail(`${field}.request.method`, "method must be 'GET' or 'POST'");
  const path = validatePath(rr.path, `${field}.request.path`);
  const headers = validateStringMap(rr.headers, `${field}.request.headers`, true);
  const query = validateStringMap(rr.query, `${field}.request.query`, false);
  if (rr.bodyTemplate !== undefined && typeof rr.bodyTemplate !== 'string') {
    fail(`${field}.request.bodyTemplate`, 'must be a string (a JSON template)');
  }
  const bodyTemplate = typeof rr.bodyTemplate === 'string' ? rr.bodyTemplate : undefined;

  const replyTemplate = typeof o.replyTemplate === 'string' ? o.replyTemplate : '';
  if (replyTemplate.length === 0) fail(`${field}.replyTemplate`, 'replyTemplate is required');

  return {
    id,
    match: { type: mm.type, value: matchValue, caseSensitive: mm.caseSensitive === true },
    request: {
      method: rr.method,
      path,
      query: Object.keys(query).length ? query : undefined,
      headers: Object.keys(headers).length ? headers : undefined,
      bodyTemplate,
    },
    replyTemplate,
    notFoundTemplate: typeof o.notFoundTemplate === 'string' && o.notFoundTemplate ? o.notFoundTemplate : undefined,
    errorTemplate: typeof o.errorTemplate === 'string' && o.errorTemplate ? o.errorTemplate : undefined,
  };
}

export function readConfig(raw: Record<string, unknown>): HttpActionConfig {
  // baseUrl is an allowConfigHosts key: the host net gate resolves the allowed host from RAW ctx.config,
  // so a code-side default is invisible to the gate and every fetch silently no-ops. Require it.
  const baseUrlRaw = String(raw.baseUrl ?? '').trim();
  if (!baseUrlRaw) fail('baseUrl', 'is required (allowConfigHosts key — no code default)');
  let origin: URL;
  try {
    origin = new URL(baseUrlRaw);
  } catch {
    fail('baseUrl', 'must be a valid URL');
  }
  if (origin.protocol !== 'https:') fail('baseUrl', 'must be https');
  if (origin.username || origin.password) fail('baseUrl', 'must not contain embedded credentials');
  if (origin.hash) fail('baseUrl', 'must not contain a fragment');
  if (origin.search) fail('baseUrl', 'must not contain a query string (origin/path only)');
  const baseUrl = baseUrlRaw.replace(/\/+$/, '');

  const authType: AuthType = raw.authType === 'bearer' || raw.authType === 'apikey' ? raw.authType : 'none';
  const authToken = raw.authToken ? String(raw.authToken) : undefined;
  if (authType !== 'none' && !authToken) fail('authToken', `is required when authType='${authType}'`);

  const apiKeyHeader = String(raw.apiKeyHeader ?? 'X-API-Key').trim() || 'X-API-Key';
  if (/[\r\n]/.test(apiKeyHeader)) fail('apiKeyHeader', 'must not contain CR/LF');
  if (isDangerousHeader(apiKeyHeader)) fail('apiKeyHeader', 'must not be a reserved/dangerous header (host/connection/x-forwarded-*/…)');

  const timeoutNum = Number(raw.timeoutMs);
  const timeoutMs = Number.isFinite(timeoutNum) && timeoutNum >= 500 ? timeoutNum : 3000;
  const cooldownNum = Number(raw.cooldownSeconds);
  const cooldownSeconds = Number.isFinite(cooldownNum) && cooldownNum >= 0 ? cooldownNum : 3;

  // actions arrives as a JSON string (configSchema type:textarea) or a pre-parsed array.
  let actionsRaw: unknown = raw.actions;
  if (typeof actionsRaw === 'string') {
    const trimmed = actionsRaw.trim();
    if (!trimmed) fail('actions', 'is required (a JSON array)');
    try {
      actionsRaw = JSON.parse(trimmed);
    } catch (e) {
      fail('actions', `JSON parse failed: ${(e as Error).message}`);
    }
  }
  if (!Array.isArray(actionsRaw)) fail('actions', 'must be a JSON array');
  if (actionsRaw.length < 1) fail('actions', 'must contain at least one action');
  if (actionsRaw.length > MAX_ACTIONS) fail('actions', `must contain at most ${MAX_ACTIONS} actions`);
  const actions = actionsRaw.map((a, i) => validateAction(a, i));

  return {
    baseUrl,
    authType,
    authToken,
    apiKeyHeader,
    respondInGroups: raw.respondInGroups === true,
    timeoutMs,
    cooldownSeconds,
    actions,
  };
}
