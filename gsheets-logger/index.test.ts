import { test } from 'node:test';
import assert from 'node:assert/strict';
import GSheetsLogger, { parseConfig, flushBuffer } from './index.ts';

const validSa = JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com', private_key: 'KEY' });

test('parseConfig requires spreadsheetId', () => {
  assert.throws(() => parseConfig({ serviceAccountJson: validSa }), /spreadsheetId is required/);
});

test('parseConfig rejects invalid service-account JSON', () => {
  assert.throws(() => parseConfig({ spreadsheetId: 'sid', serviceAccountJson: 'not json' }), /not valid JSON/);
});

test('parseConfig rejects a service account missing client_email/private_key', () => {
  assert.throws(() => parseConfig({ spreadsheetId: 'sid', serviceAccountJson: '{}' }), /missing client_email/);
});

test('parseConfig applies defaults', () => {
  const { config } = parseConfig({ spreadsheetId: 'sid', serviceAccountJson: validSa });
  assert.equal(config.sheetTab, 'Logs');
  assert.equal(config.flushIntervalSec, 5);
  assert.equal(config.flushBatchSize, 20);
});

test('parseConfig clamps non-numeric/non-positive flush interval and batch size to safe defaults', () => {
  const base = { spreadsheetId: 'sid', serviceAccountJson: validSa };
  // Non-numeric / zero / negative interval must not coerce to NaN (which makes setInterval hot-loop at ~1ms).
  assert.equal(parseConfig({ ...base, flushIntervalSec: 'abc' }).config.flushIntervalSec, 5);
  assert.equal(parseConfig({ ...base, flushIntervalSec: 0 }).config.flushIntervalSec, 5);
  assert.equal(parseConfig({ ...base, flushIntervalSec: -3 }).config.flushIntervalSec, 5);
  assert.equal(parseConfig({ ...base, flushBatchSize: 'xyz' }).config.flushBatchSize, 20);
  assert.equal(parseConfig({ ...base, flushBatchSize: 0 }).config.flushBatchSize, 20);
  // Valid values pass through unchanged.
  assert.equal(parseConfig({ ...base, flushIntervalSec: 10 }).config.flushIntervalSec, 10);
  assert.equal(parseConfig({ ...base, flushBatchSize: 50 }).config.flushBatchSize, 50);
});

test('parseConfig floors a sub-second flush interval to >=1s (setInterval hot-loop guard)', () => {
  const base = { spreadsheetId: 'sid', serviceAccountJson: validSa };
  assert.equal(parseConfig({ ...base, flushIntervalSec: 0.001 }).config.flushIntervalSec, 1);
  assert.equal(parseConfig({ ...base, flushIntervalSec: 0.5 }).config.flushIntervalSec, 1);
  assert.equal(parseConfig({ ...base, flushIntervalSec: 10 }).config.flushIntervalSec, 10); // sane values unchanged
});

test('flushBuffer clears the buffer on success', async () => {
  const buffer = [['a'], ['b']];
  await flushBuffer(buffer, async () => {});
  assert.equal(buffer.length, 0);
});

test('flushBuffer retains rows when append fails', async () => {
  const buffer = [['a'], ['b']];
  await assert.rejects(flushBuffer(buffer, async () => { throw new Error('sheets down'); }));
  assert.equal(buffer.length, 2);
});

test('flushBuffer keeps rows that arrive during the append', async () => {
  const buffer = [['a'], ['b']];
  await flushBuffer(buffer, async () => { buffer.push(['c']); }); // a row enqueued mid-flush
  assert.deepEqual(buffer, [['c']]);                              // a,b flushed; c retained
});

test('flushBuffer restores the batch ahead of newer rows on failure', async () => {
  const buffer = [['a'], ['b']];
  await assert.rejects(flushBuffer(buffer, async () => { buffer.push(['c']); throw new Error('down'); }));
  assert.deepEqual(buffer, [['a'], ['b'], ['c']]);               // batch restored to front, newer row after
});

// Regression: onDisable must await an in-flight flush so a failing flush's restored rows are the ones
// persisted — not the empty post-splice buffer. With the old `flushing` boolean this lost the rows.
test('onDisable awaits an in-flight failing flush and persists the restored rows', async () => {
  const logger = new GSheetsLogger();
  const setCalls: string[][][] = [];
  let releaseAppend = (): void => {};
  const appendGate = new Promise<void>((resolve) => { releaseAppend = resolve; });

  // Inject internals directly (private fields) to drive the flush/onDisable interleaving deterministically.
  const harness = logger as unknown as {
    client: unknown; ctx: unknown; buffer: string[][]; flush(): Promise<void>;
  };
  harness.client = { appendRows: async (): Promise<void> => { await appendGate; throw new Error('sheets 500'); } };
  harness.ctx = {
    storage: { set: async (_key: string, value: string[][]): Promise<void> => { setCalls.push(value.map((r) => [...r])); } },
    logger: { error: (): void => {}, warn: (): void => {} },
  };
  harness.buffer = [['a'], ['b']];

  const flushPromise = harness.flush();   // starts flush; appendRows blocks on the gate
  const disablePromise = logger.onDisable(); // must await the in-flight flush, not persist [] early
  releaseAppend();                         // let appendRows reject -> flushBuffer restores [a,b]
  await Promise.allSettled([flushPromise, disablePromise]);

  // The persisted buffer must be the restored rows, never an empty array.
  assert.deepEqual(setCalls.at(-1), [['a'], ['b']]);
  assert.ok(!setCalls.some((c) => c.length === 0), 'must never persist an empty buffer while rows are unsent');
});

// onConfigChange now fires for sandboxed plugins (OpenWA #430), so rows buffered before a
// spreadsheet/credential rotation must drain to the OLD client before the swap, not the new sheet.
test('onConfigChange drains the buffer to the old client before swapping', async () => {
  const logger = new GSheetsLogger();
  const sentToOld: string[][] = [];
  const harness = logger as unknown as { client: unknown; ctx: unknown; buffer: string[][] };
  harness.client = { appendRows: async (rows: string[][]): Promise<void> => { sentToOld.push(...rows); } };
  harness.ctx = { storage: { set: async (): Promise<void> => {} }, logger: { error: (): void => {}, warn: (): void => {} } };
  harness.buffer = [['old-row']];

  const newConfig = {
    serviceAccountJson: JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com', private_key: 'KEY' }),
    spreadsheetId: 'NEW_SHEET',
  };
  await logger.onConfigChange({ config: newConfig } as unknown as never, newConfig);
  await logger.onUnload(); // stop the interval started by onConfigChange

  assert.deepEqual(sentToOld, [['old-row']]); // buffered row went to the OLD client
  assert.equal(harness.buffer.length, 0);     // buffer drained before the swap
});
