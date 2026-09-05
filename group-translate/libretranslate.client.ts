import type { Translator, DetectResult, TranslationLogger } from './core/ports';
import type { PluginNetCapability } from '../types/openwa';

export interface LibreTranslateOptions {
  url: string;
  apiKey?: string;
  timeoutMs: number;
  failureThreshold?: number;
  cooldownMs?: number;
  net: PluginNetCapability; // host-proxied, SSRF-guarded fetch (v0.7)
  logger?: TranslationLogger;
}

const NOOP_LOGGER: TranslationLogger = { debug: () => {}, info: () => {}, warn: () => {} };

/**
 * Strip URL userinfo from text that is about to be logged or rethrown.
 *
 * The host quotes the FULL request URL when it refuses a fetch ("Plugin <id> may not fetch <url> ...
 * add its host to net.allow"), and a credentialed `libretranslateUrl` is dropped from the
 * config-derived allowlist, so that refusal fires on every single message. Rethrowing it verbatim put
 * the operator's password in the host log once per message, which is exactly what index.ts refuses to
 * do when it warns about the same field ("Never the value itself: this is the one config field an
 * operator may have put a password in").
 */
export function redactUrlCredentials(text: string): string {
  // The password half deliberately admits `@` and runs greedy to the LAST `@` before the host: a
  // password containing `@` is common and legal, and stopping at the first one republished its tail
  // (`admin:p@ssw0rd@host` redacted to `***:***@ssw0rd@host`). The user half keeps `@` excluded, which
  // is what bounds the match to one URL. Both halves still stop at `/` and whitespace, so a port, an
  // IPv6 host and a `:`/`@` inside a query string or in ordinary prose are all left alone.
  return text.replace(/\/\/[^/@\s]*:[^/\s]*@/g, '//***:***@');
}

export class LibreTranslateClient implements Translator {
  private readonly base: string;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly net: PluginNetCapability;
  private readonly logger: TranslationLogger;
  private consecutiveFailures = 0;
  private openUntil = 0;

  constructor(private readonly opts: LibreTranslateOptions) {
    this.base = opts.url.replace(/\/+$/, '');
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 30000;
    this.net = opts.net;
    this.logger = opts.logger ?? NOOP_LOGGER;
  }

  isHealthy(): boolean {
    return this.consecutiveFailures < this.failureThreshold;
  }

  async detect(text: string): Promise<DetectResult> {
    const data = (await this.post('/detect', { q: text })) as Array<{ language: string; confidence: number }>;
    const top = data[0];
    if (!top) throw new Error('LibreTranslate /detect returned no result');
    return { lang: top.language, confidence: top.confidence };
  }

  async translate(text: string, source: string, target: string): Promise<string> {
    const data = (await this.post('/translate', { q: text, source, target, format: 'text' })) as {
      translatedText?: unknown;
    };
    if (typeof data?.translatedText !== 'string') {
      // A partial/empty body must fail (counted by the circuit breaker, excluded from the reply)
      // rather than become the literal string 'undefined' in the group.
      throw new Error('LibreTranslate /translate returned no translatedText');
    }
    return data.translatedText;
  }

  async languages(): Promise<string[]> {
    const data = (await this.post('/languages', {}, 'GET')) as Array<{ code: string }>;
    return data.map(l => l.code);
  }

  private async post(
    path: string,
    payload: Record<string, unknown>,
    method: 'GET' | 'POST' = 'POST',
  ): Promise<unknown> {
    const now = Date.now();
    if (now < this.openUntil) {
      throw new Error('LibreTranslate circuit open');
    }

    const url = `${this.base}${path}`;
    try {
      // Outbound HTTP goes through the host's SSRF-guarded, allow-listed proxy (ctx.net.fetch). The host
      // enforces the timeout (timeoutMs) and the manifest `net.allow` host allowlist — there is no raw
      // socket here, so the old AbortController/withSafeFetch path is gone.
      const body = method === 'POST' ? JSON.stringify({ ...payload, api_key: this.opts.apiKey }) : undefined;
      const res = await this.net.fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body,
        timeoutMs: this.opts.timeoutMs,
      });
      if (!res.ok) {
        throw new Error(`LibreTranslate ${path} -> HTTP ${res.status}`);
      }
      // The sandbox runtime hands back the body as a string (no res.json() — functions can't cross the
      // worker boundary), so parse it here. A malformed/empty body throws and is counted as a failure.
      const data = JSON.parse(res.body);
      this.consecutiveFailures = 0;
      return data;
    } catch (err) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.openUntil = Date.now() + this.cooldownMs;
        this.logger.warn(`LibreTranslate circuit opened for ${this.cooldownMs}ms`, { action: 'lt_circuit_open' });
      }
      // Redact before it leaves this method, not at each log site: this catch is the single point where
      // a host-produced message (which quotes the full request URL) enters the plugin, and the
      // coordinator logs the rejection reason verbatim on every failed translate and detect.
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(redactUrlCredentials(message));
    }
  }
}
