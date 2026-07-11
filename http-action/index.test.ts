import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMessage, type HandleDeps } from './index.ts';
import { readConfig } from './config.ts';
import type { IncomingMessage } from '../types/openwa';

function cfgWith(over: Record<string, unknown> = {}) {
  return readConfig({
    baseUrl: 'https://api.example.com',
    actions: JSON.stringify([{
      id: 'check', match: { type: 'prefix', value: 'cek ' },
      request: { method: 'GET', path: '/orders/{{args.0}}' },
      replyTemplate: 'Status: {{response.status}}',
      notFoundTemplate: 'NF',
      errorTemplate: 'ERR',
    }]),
    ...over,
  });
}

const msg = (body: string): IncomingMessage => ({
  id: 'm1', from: '62@s.whatsapp.net', to: 'bot', chatId: 'c1',
  body, type: 'text', timestamp: 0, fromMe: false, isGroup: false,
}) as IncomingMessage;

function deps(opts: { body?: string; status?: number; ok?: boolean; reject?: boolean }, sendCalls: { env: unknown }[], warns: string[]) {
  const d: HandleDeps = {
    cfg: cfgWith(),
    fetch: async () => {
      if (opts.reject) throw new Error('network');
      return { ok: opts.ok ?? true, status: opts.status ?? 200, statusText: 'OK', headers: {}, body: opts.body ?? '{}' };
    },
    conversations: { send: async (env: unknown) => { sendCalls.push({ env }); } },
    logger: { log() {}, warn: (m: string) => warns.push(m), error() {} },
  };
  return d;
}

test('2xx: renders the reply template from the JSON response and sends it quoting the inbound', async () => {
  const sendCalls: { env: unknown }[] = [];
  await handleMessage(deps({ body: JSON.stringify({ status: 'shipped' }) }, sendCalls, []), 's1', msg('cek INV-001'));
  assert.equal(sendCalls.length, 1);
  assert.deepEqual(sendCalls[0].env, {
    sessionId: 's1', chatId: 'c1', type: 'text', text: 'Status: shipped', replyTo: 'm1',
  });
});

test('404: sends the notFoundTemplate', async () => {
  const sendCalls: { env: unknown }[] = [];
  await handleMessage(deps({ ok: false, status: 404, body: '{}' }, sendCalls, []), 's1', msg('cek X'));
  assert.equal((sendCalls[0].env as { text: string }).text, 'NF');
});

test('500: sends the errorTemplate', async () => {
  const sendCalls: { env: unknown }[] = [];
  await handleMessage(deps({ ok: false, status: 500, body: '{}' }, sendCalls, []), 's1', msg('cek X'));
  assert.equal((sendCalls[0].env as { text: string }).text, 'ERR');
});

test('fetch failure: sends the errorTemplate and logs a warning', async () => {
  const sendCalls: { env: unknown }[] = [];
  const warns: string[] = [];
  await handleMessage(deps({ reject: true }, sendCalls, warns), 's1', msg('cek X'));
  assert.equal((sendCalls[0].env as { text: string }).text, 'ERR');
  assert.ok(warns.length >= 1);
});

test('no trigger match: nothing is sent (silent)', async () => {
  const sendCalls: { env: unknown }[] = [];
  await handleMessage(deps({ body: '{}' }, sendCalls, []), 's1', msg('hello world'));
  assert.equal(sendCalls.length, 0);
});

test('a reply over the cap is truncated', async () => {
  const cfg = readConfig({
    baseUrl: 'https://api.example.com',
    actions: JSON.stringify([{
      id: 'check', match: { type: 'prefix', value: 'cek ' },
      request: { method: 'GET', path: '/x' }, replyTemplate: '{{response}}',
    }]),
  });
  const longBody = JSON.stringify('x'.repeat(6000));
  const sendCalls: { env: unknown }[] = [];
  await handleMessage({
    cfg, fetch: async () => ({ ok: true, status: 200, statusText: 'OK', headers: {}, body: longBody }),
    conversations: { send: async (env: unknown) => { sendCalls.push({ env }); } },
    logger: { log() {}, warn() {}, error() {} },
  }, 's1', msg('cek X'));
  const text = (sendCalls[0].env as { text: string }).text;
  assert.ok(text.length <= 4000, `expected <= 4000, got ${text.length}`);
  assert.ok(text.endsWith('…'));
});

test('missing notFoundTemplate falls back to a generic default', async () => {
  const cfg = readConfig({
    baseUrl: 'https://api.example.com',
    actions: JSON.stringify([{
      id: 'check', match: { type: 'prefix', value: 'cek ' },
      request: { method: 'GET', path: '/x' }, replyTemplate: 'ok {{response.status}}',
    }]),
  });
  const sendCalls: { env: unknown }[] = [];
  await handleMessage({
    cfg, fetch: async () => ({ ok: false, status: 404, statusText: 'NF', headers: {}, body: '{}' }),
    conversations: { send: async (env: unknown) => { sendCalls.push({ env }); } },
    logger: { log() {}, warn() {}, error() {} },
  }, 's1', msg('cek X'));
  const text = (sendCalls[0].env as { text: string }).text;
  assert.ok(!text.includes('{{'), 'default notFound should have no unresolved placeholder');
  assert.ok(text.length > 0);
});
