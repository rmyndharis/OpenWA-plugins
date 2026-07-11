import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMessage, type HandleDeps } from './index.ts';
import { readConfig } from './config.ts';
import type { StorageLike } from './reliability.ts';
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

function fakeStore(): StorageLike & { m: Map<string, unknown> } {
  const m = new Map<string, unknown>();
  return {
    m,
    get: async (k: string) => (m.has(k) ? m.get(k) : null),
    set: async (k: string, v: unknown) => { m.set(k, v); },
    delete: async (k: string) => { m.delete(k); },
    list: async (prefix?: string) => [...m.keys()].filter((k) => (prefix ? k.startsWith(prefix) : true)),
  };
}

const msg = (body: string, id = 'm1'): IncomingMessage => ({
  id, from: '62@s.whatsapp.net', to: 'bot', chatId: 'c1',
  body, type: 'text', timestamp: 0, fromMe: false, isGroup: false,
}) as IncomingMessage;

interface Opts { body?: string; status?: number; ok?: boolean; reject?: boolean; now?: () => number }

function makeDeps(o: Opts = {}) {
  const sendCalls: { env: unknown }[] = [];
  const warns: string[] = [];
  const d: HandleDeps = {
    cfg: cfgWith(),
    storage: fakeStore(),
    cooldown: new Map<string, number>(),
    now: o.now ?? (() => 1000),
    fetch: async () => {
      if (o.reject) throw new Error('network');
      return { ok: o.ok ?? true, status: o.status ?? 200, statusText: 'OK', headers: {}, body: o.body ?? '{}' };
    },
    conversations: { send: async (env: unknown) => { sendCalls.push({ env }); } },
    logger: { log() {}, warn: (m: string) => warns.push(m), error() {} },
  };
  return { d, sendCalls, warns };
}

test('2xx: renders the reply template from the JSON response and sends it quoting the inbound', async () => {
  const { d, sendCalls } = makeDeps({ body: JSON.stringify({ status: 'shipped' }) });
  await handleMessage(d, 's1', msg('cek INV-001'));
  assert.equal(sendCalls.length, 1);
  assert.deepEqual(sendCalls[0].env, {
    sessionId: 's1', chatId: 'c1', type: 'text', text: 'Status: shipped', replyTo: 'm1',
  });
});

test('404: sends the notFoundTemplate', async () => {
  const { d, sendCalls } = makeDeps({ ok: false, status: 404, body: '{}' });
  await handleMessage(d, 's1', msg('cek X'));
  assert.equal((sendCalls[0].env as { text: string }).text, 'NF');
});

test('500: sends the errorTemplate', async () => {
  const { d, sendCalls } = makeDeps({ ok: false, status: 500, body: '{}' });
  await handleMessage(d, 's1', msg('cek X'));
  assert.equal((sendCalls[0].env as { text: string }).text, 'ERR');
});

test('fetch failure: sends the errorTemplate and logs a warning', async () => {
  const { d, sendCalls, warns } = makeDeps({ reject: true });
  await handleMessage(d, 's1', msg('cek X'));
  assert.equal((sendCalls[0].env as { text: string }).text, 'ERR');
  assert.ok(warns.length >= 1);
});

test('no trigger match: nothing is sent (silent)', async () => {
  const { d, sendCalls } = makeDeps({ body: '{}' });
  await handleMessage(d, 's1', msg('hello world'));
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
  const sendCalls: { env: unknown }[] = [];
  await handleMessage({
    cfg, storage: fakeStore(), cooldown: new Map(), now: () => 1000,
    fetch: async () => ({ ok: true, status: 200, statusText: 'OK', headers: {}, body: JSON.stringify('x'.repeat(6000)) }),
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
    cfg, storage: fakeStore(), cooldown: new Map(), now: () => 1000,
    fetch: async () => ({ ok: false, status: 404, statusText: 'NF', headers: {}, body: '{}' }),
    conversations: { send: async (env: unknown) => { sendCalls.push({ env }); } },
    logger: { log() {}, warn() {}, error() {} },
  }, 's1', msg('cek X'));
  const text = (sendCalls[0].env as { text: string }).text;
  assert.ok(!text.includes('{{'), 'default notFound should have no unresolved placeholder');
  assert.ok(text.length > 0);
});

// ---- #8 reliability gates ----

test('dedup: a redelivered message id is not processed twice', async () => {
  const { d, sendCalls } = makeDeps({ body: JSON.stringify({ status: 'shipped' }) });
  await handleMessage(d, 's1', msg('cek X', 'm1'));
  await handleMessage(d, 's1', msg('cek X', 'm1')); // same id → redelivery
  assert.equal(sendCalls.length, 1);
});

test('cooldown: a second message from the same chat within the window is dropped', async () => {
  const { d, sendCalls } = makeDeps({ body: '{}' });
  await handleMessage(d, 's1', msg('cek X', 'm1')); // different id below, same chat
  await handleMessage(d, 's1', msg('cek X', 'm2'));
  assert.equal(sendCalls.length, 1); // dedup passes (distinct ids), cooldown blocks
});

test('cooldown: a message after the window is allowed', async () => {
  let now = 1000;
  const { d, sendCalls } = makeDeps({ body: '{}', now: () => now });
  await handleMessage(d, 's1', msg('cek X', 'm1'));
  now += cfgWith().cooldownSeconds * 1000 + 1; // past the 3s window
  await handleMessage(d, 's1', msg('cek X', 'm2'));
  assert.equal(sendCalls.length, 2);
});

test('dedup fail-closed: a storage error drops the message (no reply, no double-fire risk)', async () => {
  const sendCalls: { env: unknown }[] = [];
  const broken = {
    get: async () => { throw new Error('storage down'); },
    set: async () => {}, delete: async () => {}, list: async () => [] as string[],
  };
  await handleMessage({
    cfg: cfgWith(), storage: broken, cooldown: new Map(), now: () => 1000,
    fetch: async () => ({ ok: true, status: 200, statusText: 'OK', headers: {}, body: '{}' }),
    conversations: { send: async (env: unknown) => { sendCalls.push({ env }); } },
    logger: { log() {}, warn() {}, error() {} },
  }, 's1', msg('cek X', 'm1'));
  assert.equal(sendCalls.length, 0); // dropped, not processed
});
