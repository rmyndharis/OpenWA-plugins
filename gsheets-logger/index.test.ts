import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, flushBuffer } from './index.ts';

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
