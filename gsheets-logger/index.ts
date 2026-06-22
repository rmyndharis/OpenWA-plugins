import type { IPlugin, PluginContext, HookContext, HookEvent } from '../types/openwa';
import { SheetsClient, type ServiceAccount } from './sheets-client.ts';
import { buildRow } from './row.ts';

const LOGGED_EVENTS: HookEvent[] = ['message:received', 'message:sent', 'message:failed', 'message:ack'];
const BUFFER_KEY = 'buffer';
const MAX_BUFFER = 5000;

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

  return {
    config: {
      serviceAccountJson,
      spreadsheetId,
      sheetTab: String(raw.sheetTab ?? 'Logs'),
      flushIntervalSec: Number(raw.flushIntervalSec ?? 5),
      flushBatchSize: Number(raw.flushBatchSize ?? 20),
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
  private flushing = false;
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
  }

  async onConfigChange(ctx: PluginContext, _newConfig: Record<string, unknown>): Promise<void> {
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
    return { healthy: this.client !== null, message: `${this.buffer.length} rows buffered` };
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

  private async flush(): Promise<void> {
    if (this.flushing || !this.client || this.buffer.length === 0) return;
    this.flushing = true;
    try {
      const client = this.client;
      await flushBuffer(this.buffer, (rows) => client.appendRows(rows));
      await this.ctx?.storage.set(BUFFER_KEY, this.buffer);
    } catch (err) {
      this.ctx?.logger.error('gsheets-logger: flush failed, will retry next tick', err);
    } finally {
      this.flushing = false;
    }
  }
}
