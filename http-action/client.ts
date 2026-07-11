// Fixed-origin HTTP client for HTTP Action Bot. Takes the host `ctx.net.fetch` (injected, so this tests
// without OpenWA) and a validated config; builds a safe request per action + template context and parses
// the JSON response. Pure modulo the injected fetch.
//
// The injected fetch matches the real PluginNetCapability.fetch(url, init) — URL is the first positional
// arg, init carries method/headers/body/timeoutMs (NOT a `url` field). Security: origin is fixed to
// cfg.baseUrl (config-validated https, allowConfigHosts); the path is rendered via renderPath (URL-encodes
// each arg segment so an arg can't add a segment or change origin); query values are encodeURIComponent'd;
// the POST body is JSON-escaped by renderJson and re-parsed before send. Response capped at 256 KiB.

import type { HttpAction, HttpActionConfig } from './config.ts';
import { renderPath, renderText, renderJson, renderHeader, type TemplateContext } from './url-template.ts';

const MAX_RESPONSE_BYTES = 256 * 1024;

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface FetchResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  headers: Record<string, string>;
  body: string;
}

/** Mirrors PluginNetCapability.fetch(url, init) so ctx.net.fetch.bind(ctx.net) drops straight in. */
export type FetchLike = (url: string, init?: FetchInit) => Promise<FetchResponse>;

export interface ActionResult {
  status: number;
  data: unknown; // parsed JSON, or undefined when a non-ok body wasn't JSON
}

export class HttpActionClient {
  constructor(private readonly fetch: FetchLike, private readonly cfg: HttpActionConfig) {}

  async run(action: HttpAction, ctx: TemplateContext): Promise<ActionResult> {
    const { url, init } = this.buildRequest(action, ctx);
    const res = await this.fetch(url, init);
    if (res.body.length > MAX_RESPONSE_BYTES) {
      throw new Error('http-action: upstream response too large (RESPONSE_TOO_LARGE)');
    }
    let data: unknown;
    try {
      data = res.body.length ? JSON.parse(res.body) : undefined;
    } catch {
      if (res.ok) throw new Error('http-action: upstream returned invalid JSON (UPSTREAM_INVALID_JSON)');
      data = undefined; // non-ok body may be a plaintext error; the handler maps via status template
    }
    return { status: res.status, data };
  }

  private buildRequest(action: HttpAction, ctx: TemplateContext): { url: string; init: FetchInit } {
    const path = renderPath(action.request.path, ctx);
    let url = this.cfg.baseUrl + path;

    if (action.request.query) {
      const qs = Object.entries(action.request.query)
        .map(([k, v]) => [k, renderText(v, ctx)] as const)
        .filter(([, val]) => val !== '') // omit params whose value renders empty (e.g. a missing arg)
        .map(([k, val]) => `${encodeURIComponent(k)}=${encodeURIComponent(val)}`)
        .join('&');
      if (qs) url += `?${qs}`;
    }

    const headers: Record<string, string> = {};
    if (action.request.headers) {
      for (const [k, v] of Object.entries(action.request.headers)) headers[k] = renderHeader(v, ctx);
    }

    // Auth — authToken is a configSchema secret; never logged by the caller.
    if (this.cfg.authType === 'bearer') headers['Authorization'] = `Bearer ${this.cfg.authToken}`;
    else if (this.cfg.authType === 'apikey') headers[this.cfg.apiKeyHeader] = this.cfg.authToken ?? '';

    const init: FetchInit = { method: action.request.method, headers, timeoutMs: this.cfg.timeoutMs };

    if (action.request.method === 'POST') {
      headers['Content-Type'] = 'application/json';
      if (action.request.bodyTemplate) {
        const rendered = renderJson(action.request.bodyTemplate, ctx);
        try {
          JSON.parse(rendered); // validate before send (anti JSON injection via an arg)
        } catch {
          throw new Error('http-action: rendered request body is not valid JSON');
        }
        init.body = rendered;
      }
    }

    return { url, init };
  }
}
