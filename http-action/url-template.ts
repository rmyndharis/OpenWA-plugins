// Prototype-safe dot-path templating for HTTP Action Bot. Pure (no ctx) → tests without OpenWA.
//
// Security: WhatsApp message text is attacker-controlled and flows into `args.*` (and from there into
// request paths, query, and POST bodies). Three invariants this module enforces:
//   1. prototype keys (__proto__ / constructor / prototype) are rejected anywhere in a path;
//   2. path/query segments are URL-encoded so an arg can never inject a new path segment or origin;
//   3. POST body values are JSON-escaped so an arg can never break out of a JSON string field.
// Bounded (max path depth + max placeholder count) so a template can't DoS the worker.

export interface TemplateContext {
  args: string[];
  response?: unknown;
  sender?: Record<string, unknown>;
  chat?: Record<string, unknown>;
  message?: Record<string, unknown>;
  session?: Record<string, unknown>;
}

const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 12;
const MAX_PLACEHOLDERS = 64;
const PLACEHOLDER_RE = /\{\{(.*?)\}\}/g;

export class TemplateError extends Error {
  constructor(msg: string) {
    super(`http-action: template error — ${msg}`);
    this.name = 'TemplateError';
  }
}

function toStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** Walk a dotted path on `root`, prototype-safe. Returns undefined for a missing path (no throw). */
export function getPath(root: unknown, dotted: string): unknown {
  const segs = dotted.split('.');
  if (segs.length > MAX_DEPTH) throw new TemplateError(`path too deep (>${MAX_DEPTH}): ${dotted}`);
  let cur: unknown = root;
  for (const seg of segs) {
    if (PROTOTYPE_KEYS.has(seg)) throw new TemplateError(`prototype key forbidden in path: ${dotted}`);
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Plain substitution for reply/error/notFound templates. Missing value → ''. */
export function renderText(template: string, ctx: TemplateContext): string {
  return render(template, ctx, toStr);
}

/** Substitute {{...}} into a path template. URL-encodes each value and rejects '..' (same-origin traversal). */
export function renderPath(template: string, ctx: TemplateContext): string {
  return render(template, ctx, (v) => {
    const s = toStr(v);
    if (s.includes('..')) throw new TemplateError('path segment contains ".." (traversal blocked)');
    return encodeURIComponent(s);
  });
}

/** Substitute {{...}} into a header value, rejecting CR/LF/NUL so an attacker-controlled field can't inject headers. */
export function renderHeader(template: string, ctx: TemplateContext): string {
  return render(template, ctx, (v) => {
    const s = toStr(v);
    if (/[\r\n\0]/.test(s)) throw new TemplateError('header value contains CR/LF/NUL');
    return s;
  });
}

/** Substitute {{...}} into a JSON body template with JSON-safe string escaping. */
export function renderJson(template: string, ctx: TemplateContext): string {
  // Stringify the value (which escapes quotes/backslashes) then strip the outer quotes, so it slots
  // into a quoted JSON field safely. The client re-parses the result before sending.
  return render(template, ctx, (v) => JSON.stringify(toStr(v)).slice(1, -1));
}

function render(template: string, ctx: TemplateContext, encode: (v: unknown) => string): string {
  let count = 0;
  return template.replace(PLACEHOLDER_RE, (_m, innerRaw: string) => {
    if (++count > MAX_PLACEHOLDERS) throw new TemplateError(`too many placeholders (>${MAX_PLACEHOLDERS})`);
    const inner = String(innerRaw).trim();
    if (!inner) return '';
    return encode(getPath(ctx, inner));
  });
}
