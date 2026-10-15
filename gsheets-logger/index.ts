import type { IPlugin, PluginContext, HookContext, HookEvent } from '../types/openwa';
import { createHash } from 'node:crypto';
import { SheetsClient, type ServiceAccount } from './sheets-client.ts';
import { buildRow } from './row.ts';

const LOGGED_EVENTS: HookEvent[] = ['message:received', 'message:sent', 'message:failed', 'message:ack'];
const BUFFER_KEY = 'buffer';
// Rows that could not be delivered to the spreadsheet they were captured for. Kept out of the live
// buffer so they are never sent to a different target, and out of the way of the quota by sharing the
// same caps as the buffer itself.
const UNDELIVERED_KEY = 'buffer:undelivered';
const MAX_BUFFER = 5000;
// The row cap alone does not bound memory: row.ts allows 50,000 characters per cell across 14 columns,
// so 5,000 rows can reach hundreds of millions of characters against a 256 MB worker heap — and the
// message body a sender controls is one of those cells. ~4M characters is ~8 MB of UTF-16.
const MAX_BUFFER_CHARS = 4_000_000;

// Observer band. Must run before any responder: a responder returning {continue:false} ends the chain,
// and at the default priority of 100 this plugin would simply stop seeing claimed messages.
const HOOK_PRIORITY = 10;

// Baked from manifest.json at build time by package.mjs (esbuild `define`). The sandbox does not pass
// `manifest` into ctx, so this is how the plugin knows its own version at runtime. Falls back to a dev
// marker when run un-bundled (e.g. the test runner).
declare const __PLUGIN_VERSION__: string;
const PLUGIN_VERSION = typeof __PLUGIN_VERSION__ !== 'undefined' ? __PLUGIN_VERSION__ : '0.0.0-dev';

export interface LoggerConfig {
  serviceAccountJson: string;
  spreadsheetId: string;
  sheetTab: string;
  flushIntervalSec: number;
  flushBatchSize: number;
}

export function parseConfig(raw: Record<string, unknown>): { config: LoggerConfig; sa: ServiceAccount } {
  const serviceAccountJson = String(raw.serviceAccountJson ?? '');
  const spreadsheetId = String(raw.spreadsheetId ?? '');
  if (!spreadsheetId) throw new Error('gsheets-logger: spreadsheetId is required');

  let sa: ServiceAccount;
  try {
    sa = JSON.parse(serviceAccountJson) as ServiceAccount;
  } catch {
    throw new Error('gsheets-logger: serviceAccountJson is not valid JSON');
  }
  if (!sa || !sa.client_email || !sa.private_key) {
    throw new Error('gsheets-logger: serviceAccountJson missing client_email/private_key');
  }

  // Clamp to safe positives: a non-numeric interval coerces to NaN, and setInterval(NaN) fires at ~1ms
  // (a flush hot-loop / Sheets-quota burn). A NaN batch size silently disables the size trigger. A finite
  // but sub-second interval (e.g. 0.001) is likewise a hot-loop, so floor it to 1s. The ceiling is the
  // same hot-loop from the other end: setInterval takes a 32-bit millisecond delay, so an interval past
  // 2_147_483s overflows, warns, and silently fires at ~1ms instead. The host never validates
  // configSchema bounds at all, and this manifest declares none on either field, so both ends are
  // entirely the plugin's job.
  const flushIntervalSec = Number(raw.flushIntervalSec ?? 5);
  const flushBatchSize = Number(raw.flushBatchSize ?? 20);
  return {
    config: {
      serviceAccountJson,
      spreadsheetId,
      sheetTab: String(raw.sheetTab ?? 'Logs'),
      flushIntervalSec:
        Number.isFinite(flushIntervalSec) && flushIntervalSec > 0
          ? Math.min(2_147_483, Math.max(1, flushIntervalSec))
          : 5,
      flushBatchSize: Number.isFinite(flushBatchSize) && flushBatchSize >= 1 ? flushBatchSize : 20,
    },
    sa,
  };
}

// Take ownership of the current rows BEFORE awaiting so a concurrent enqueue/cap-drop on `buffer`
// cannot shift the front out from under us. On failure, restore the batch ahead of rows that
// arrived during the append, preserving order (retain-on-failure).
export async function flushBuffer(buffer: string[][], append: (rows: string[][]) => Promise<void>): Promise<void> {
  if (buffer.length === 0) return;
  const batch = buffer.splice(0, buffer.length);
  try {
    await append(batch);
  } catch (err) {
    buffer.unshift(...batch);
    throw err;
  }
}

// Drop oldest-first until both caps hold, returning how many rows went. Rows only pile up this deep
// while Sheets is unreachable, and the oldest are the least useful. The character total is recomputed
// per call rather than tracked incrementally because flushBuffer splices and unshifts this same array
// from outside — a running total would drift out of sync with it on every retained failure.
export function capBuffer(buffer: string[][], maxRows: number, maxChars: number): number {
  const before = buffer.length;
  if (buffer.length > maxRows) buffer.splice(0, buffer.length - maxRows);

  let total = 0;
  for (const row of buffer) for (const cell of row) total += cell.length;
  // Keep the newest row whatever its size: a single row over the cap is still worth more than nothing.
  while (total > maxChars && buffer.length > 1) {
    for (const cell of buffer[0]) total -= cell.length;
    buffer.shift();
  }
  return before - buffer.length;
}

// Identity of the delivery destination: the spreadsheet, and the credentials that reach it.
//
// `sheetTab` is deliberately excluded, because a tab rename is the same spreadsheet under the same
// service account and rows captured before it still belong there. The credentials are compared by
// their PARSED identity (account + key), not by the raw JSON text: an operator who re-pastes the same
// key reformatted, or with different whitespace or key order, has not rotated anything, and treating
// that as a new destination would park the backlog exactly as the bug this guard fixes did. The NUL
// join keeps two different splits of the same characters from colliding.
function targetOf(config: LoggerConfig, sa: ServiceAccount): string {
  return createHash('sha256').update([config.spreadsheetId, sa.client_email, sa.private_key].join('\u0000')).digest('hex');
}

export default class GSheetsLogger implements IPlugin {
  private buffer: string[][] = [];
  private client: SheetsClient | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushingPromise: Promise<void> | null = null;
  private ctx: PluginContext | null = null;
  private batchSize = 20;
  // Last flush failure, surfaced on healthCheck. Green while every append fails is the one state an
  // operator must not see: the rows are piling up and nothing says so.
  private lastFlushError: string | null = null;
  // The destination the buffered rows were captured for: spreadsheet + credentials, nothing else. Only
  // a change to THIS may park the buffer (see onConfigChange). A tab rename is the same spreadsheet
  // under the same credentials, so it must not.
  private target = '';
  private configChanges: Promise<void> = Promise.resolve();
  private changingConfig = false;

  async onEnable(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;
    const { config, sa } = parseConfig(ctx.config);
    this.batchSize = config.flushBatchSize;
    this.target = targetOf(config, sa);

    // The only place untrusted data enters the buffer. Everything downstream assumes rows of strings —
    // the size accounting reads each cell's length, and appendRows sends them verbatim — so filter here
    // rather than defending in both. Cap on load too: a buffer persisted before the cap existed, or by
    // an older version, would otherwise stay oversized until the next message arrived.
    const restored = await ctx.storage.get<string[][] | { target: string; rows: unknown[] }>(BUFFER_KEY);
    // Legacy arrays belong to the configured target; newer buffers carry a credential-free fingerprint.
    const rows = Array.isArray(restored) ? restored : restored?.rows;
    if (Array.isArray(rows)) {
      this.buffer = rows.filter((row): row is string[] => Array.isArray(row) && row.every((cell) => typeof cell === 'string'));
      const malformed = rows.length - this.buffer.length;
      const capped = capBuffer(this.buffer, MAX_BUFFER, MAX_BUFFER_CHARS);
      // Once, on enable, and only when something was actually lost. This plugin exists to produce a
      // complete audit trail, so a hole in the sheet the operator never hears about is the worst
      // shape the loss can take.
      if (malformed > 0 || capped > 0) {
        ctx.logger.warn(`gsheets-logger: restored buffer dropped ${malformed} malformed and ${capped} oldest rows`);
      }
      if (Array.isArray(restored)) {
        // Checkpoint the legacy destination before any config update or abrupt restart can change it.
        await ctx.storage.set(BUFFER_KEY, { target: this.target, rows: this.buffer });
      }
      if (!Array.isArray(restored) && restored?.target !== this.target) {
        const nextTarget = this.target;
        this.target = typeof restored?.target === 'string' ? restored.target : '';
        await this.parkBuffer(ctx);
        this.target = nextTarget;
        await ctx.storage.set(BUFFER_KEY, { target: this.target, rows: this.buffer });
      }
    }

    this.client = new SheetsClient(ctx.net.fetch.bind(ctx.net), sa, config.spreadsheetId, config.sheetTab);

    for (const event of LOGGED_EVENTS) {
      ctx.registerHook(
        event,
        async (hook: HookContext) => {
          this.enqueue(hook);
          return { continue: true }; // observer: never claims, see PLUGIN-STANDARD.md
        },
        HOOK_PRIORITY,
      );
    }
    this.startTimer(config.flushIntervalSec);
    ctx.logger.log(`gsheets-logger v${PLUGIN_VERSION} enabled → sheet ${config.spreadsheetId} (tab "${config.sheetTab}")`);
  }

  async onConfigChange(ctx: PluginContext, newConfig: Record<string, unknown>): Promise<void> {
    // Resolve the new config BEFORE touching the buffer. Two reasons: the park below has to know
    // whether the destination actually moved, and a config that fails validation (a blanked
    // spreadsheetId) must throw with the old client and timer still live, so the rows keep flushing to
    // the target that is still valid instead of being parked on the way out.
    const { config, sa } = parseConfig(newConfig);
    const change = this.configChanges.then(() => this.applyConfig(ctx, config, sa));
    this.configChanges = change.catch(() => {});
    return change;
  }

  private async applyConfig(ctx: PluginContext, config: LoggerConfig, sa: ServiceAccount): Promise<void> {
    const nextTarget = targetOf(config, sa);
    this.changingConfig = true;
    try {
      await this.flush(true);
      // Failed appends retain rows for the old destination. Park only on an actual destination change.
      if (nextTarget !== this.target) await this.parkBuffer(ctx);
      this.ctx = ctx;
      this.client = new SheetsClient(ctx.net.fetch.bind(ctx.net), sa, config.spreadsheetId, config.sheetTab);
      this.batchSize = config.flushBatchSize;
      this.target = nextTarget;
      this.startTimer(config.flushIntervalSec);
    } finally {
      this.changingConfig = false;
    }
  }

  private async parkBuffer(ctx: PluginContext): Promise<void> {
    // Include rows arriving during storage I/O before switching the live destination.
    while (this.buffer.length > 0) {
      const undeliveredCount = this.buffer.length;
      try {
        await flushBuffer(this.buffer, async undelivered => {
          const existing = await ctx.storage.get<string[][]>(UNDELIVERED_KEY);
          const kept = [...(Array.isArray(existing) ? existing : []), ...undelivered];
          const evicted = capBuffer(kept, MAX_BUFFER, MAX_BUFFER_CHARS);
          await ctx.storage.set(UNDELIVERED_KEY, kept);
          ctx.logger.warn(
            `gsheets-logger: ${undelivered.length} row(s) were still undelivered at a spreadsheet or ` +
              `credential change; parked under "${UNDELIVERED_KEY}" rather than sent to the new sheet` +
              (evicted > 0 ? `, dropping the ${evicted} oldest to stay inside the buffer cap` : ''),
          );
        });
      } catch (err) {
        ctx.logger.error(`gsheets-logger: ${undeliveredCount} undelivered row(s) could not be parked`, err);
        throw err;
      }
    }
  }

  async onDisable(): Promise<void> {
    await this.configChanges;
    this.stopTimer();
    await this.flush();
    try {
      await this.ctx?.storage.set(BUFFER_KEY, { target: this.target, rows: this.buffer });
    } catch (err) {
      // `set` rejects once the plugin directory would exceed its 50 MiB quota. Nothing here can rescue
      // the rows, but an unhandled rejection would both lose them silently and escape onDisable itself.
      this.ctx?.logger.error(`gsheets-logger: could not persist ${this.buffer.length} buffered rows`, err);
    }
  }

  async onUnload(): Promise<void> {
    await this.configChanges;
    this.stopTimer();
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    const parts = [`v${PLUGIN_VERSION}`, `${this.buffer.length} rows buffered`];
    if (this.lastFlushError) parts.push(`last flush failed: ${this.lastFlushError.slice(0, 200)}`);
    // Unhealthy while a flush is failing: the plugin is running, but nothing it was installed to do is
    // reaching the sheet, and a green tile is what let that go unnoticed.
    return { healthy: this.client !== null && this.lastFlushError === null, message: parts.join(' — ') };
  }

  private startTimer(intervalSec: number): void {
    this.stopTimer();
    this.timer = setInterval(() => void this.flush(), intervalSec * 1000);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private enqueue(hook: HookContext): void {
    this.buffer.push(buildRow(hook));
    const dropped = capBuffer(this.buffer, MAX_BUFFER, MAX_BUFFER_CHARS);
    if (dropped > 0) {
      this.ctx?.logger.warn(`gsheets-logger: buffer cap exceeded, dropped ${dropped} oldest rows`);
    }
    // Only while flushes are landing. A failed flush restores the whole batch, so the buffer sits at or
    // above batchSize and every later message started another append: 30 messages made 28 attempts
    // against the 403 the setup guide tells operators to expect, walking straight into Google's
    // per-minute write quota. Until one succeeds and clears the error, the timer is the only retry
    // path, which is the cadence the README documents.
    if (this.buffer.length >= this.batchSize && this.lastFlushError === null) void this.flush();
  }

  // Returns the in-flight flush when one is running, so onDisable can `await this.flush()` and wait
  // for it before persisting. The guard must be a Promise, not a boolean: with a boolean, a disable
  // racing a failing in-flight flush would persist the post-splice (empty) buffer at the same moment
  // flushBuffer restores the rows in memory — losing them. Awaiting the real promise closes that race.
  private flush(drainForConfig = false): Promise<void> {
    if (this.flushingPromise) return this.flushingPromise;
    if (this.changingConfig && !drainForConfig) return Promise.resolve();
    if (!this.client || this.buffer.length === 0) return Promise.resolve();
    const client = this.client;
    this.flushingPromise = (async () => {
      try {
        await flushBuffer(this.buffer, (rows) => client.appendRows(rows));
        this.lastFlushError = null;
        await this.ctx?.storage.set(BUFFER_KEY, { target: this.target, rows: this.buffer });
      } catch (err) {
        this.lastFlushError = err instanceof Error ? err.message : String(err);
        this.ctx?.logger.error('gsheets-logger: flush failed, will retry next tick', err);
      } finally {
        this.flushingPromise = null;
      }
    })();
    return this.flushingPromise;
  }
}
