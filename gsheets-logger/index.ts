import type { IPlugin, PluginContext, HookContext, HookEvent } from '../types/openwa';
import { SheetsClient, type ServiceAccount } from './sheets-client.ts';
import { buildRow } from './row.ts';

const LOGGED_EVENTS: HookEvent[] = ['message:received', 'message:sent', 'message:failed', 'message:ack'];
const BUFFER_KEY = 'buffer';
const MAX_BUFFER = 5000;

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
  // (a flush hot-loop / Sheets-quota burn). A NaN batch size silently disables the size trigger.
  const flushIntervalSec = Number(raw.flushIntervalSec ?? 5);
  const flushBatchSize = Number(raw.flushBatchSize ?? 20);
  return {
    config: {
      serviceAccountJson,
      spreadsheetId,
      sheetTab: String(raw.sheetTab ?? 'Logs'),
      flushIntervalSec: Number.isFinite(flushIntervalSec) && flushIntervalSec > 0 ? flushIntervalSec : 5,
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

export default class GSheetsLogger implements IPlugin {
  private buffer: string[][] = [];
  private client: SheetsClient | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushingPromise: Promise<void> | null = null;
  private ctx: PluginContext | null = null;
  private batchSize = 20;

  async onEnable(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;
    const { config, sa } = parseConfig(ctx.config);
    this.client = new SheetsClient(sa, config.spreadsheetId, config.sheetTab);
    this.batchSize = config.flushBatchSize;

    const restored = await ctx.storage.get<string[][]>(BUFFER_KEY);
    if (Array.isArray(restored)) this.buffer = restored;

    for (const event of LOGGED_EVENTS) {
      ctx.registerHook(event, async (hook: HookContext) => {
        this.enqueue(hook);
        return { continue: true };
      });
    }
    this.startTimer(config.flushIntervalSec);
    ctx.logger.log(`gsheets-logger v${PLUGIN_VERSION} enabled → sheet ${config.spreadsheetId} (tab "${config.sheetTab}")`);
  }

  async onConfigChange(ctx: PluginContext, _newConfig: Record<string, unknown>): Promise<void> {
    // Drain to the current (old) client before swapping, so rows buffered before a spreadsheet/credential
    // rotation land in the sheet they belong to — not the new one. flush() is guarded and a no-op when empty.
    await this.flush();
    this.ctx = ctx;
    const { config, sa } = parseConfig(ctx.config);
    this.client = new SheetsClient(sa, config.spreadsheetId, config.sheetTab);
    this.batchSize = config.flushBatchSize;
    this.startTimer(config.flushIntervalSec);
  }

  async onDisable(): Promise<void> {
    this.stopTimer();
    await this.flush();
    await this.ctx?.storage.set(BUFFER_KEY, this.buffer);
  }

  async onUnload(): Promise<void> {
    this.stopTimer();
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    return { healthy: this.client !== null, message: `v${PLUGIN_VERSION} — ${this.buffer.length} rows buffered` };
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
    if (this.buffer.length > MAX_BUFFER) {
      const dropped = this.buffer.length - MAX_BUFFER;
      this.buffer.splice(0, dropped);
      this.ctx?.logger.warn(`gsheets-logger: buffer cap ${MAX_BUFFER} exceeded, dropped ${dropped} oldest rows`);
    }
    if (this.buffer.length >= this.batchSize) void this.flush();
  }

  // Returns the in-flight flush when one is running, so onDisable can `await this.flush()` and wait
  // for it before persisting. The guard must be a Promise, not a boolean: with a boolean, a disable
  // racing a failing in-flight flush would persist the post-splice (empty) buffer at the same moment
  // flushBuffer restores the rows in memory — losing them. Awaiting the real promise closes that race.
  private flush(): Promise<void> {
    if (this.flushingPromise) return this.flushingPromise;
    if (!this.client || this.buffer.length === 0) return Promise.resolve();
    const client = this.client;
    this.flushingPromise = (async () => {
      try {
        await flushBuffer(this.buffer, (rows) => client.appendRows(rows));
        await this.ctx?.storage.set(BUFFER_KEY, this.buffer);
      } catch (err) {
        this.ctx?.logger.error('gsheets-logger: flush failed, will retry next tick', err);
      } finally {
        this.flushingPromise = null;
      }
    })();
    return this.flushingPromise;
  }
}
