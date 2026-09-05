import { test } from 'node:test';
import assert from 'node:assert/strict';
import HttpAction, { handleMessage, type HandleDeps } from './index.ts';
import { readConfig } from './config.ts';
import { hasSeen, type StorageLike } from './reliability.ts';
import type { IncomingMessage, HookHandler } from '../types/openwa';

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
    get: async <T>(k: string): Promise<T | null> => (m.has(k) ? (m.get(k) as T) : null),
    set: async (k: string, v: unknown) => { m.set(k, v); },
    delete: async (k: string) => { m.delete(k); },
    list: async (prefix?: string) => [...m.keys()].filter((k) => (prefix ? k.startsWith(prefix) : true)),
  };
}

const msg = (body: string, id = 'm1', type = 'text'): IncomingMessage => ({
  id, from: '62@s.whatsapp.net', to: 'bot', chatId: 'c1',
  body, type, timestamp: 0, fromMe: false, isGroup: false,
}) as IncomingMessage;

// Minimal PluginContext-shaped ctx for the priority/claim tests below — the file's other tests exercise
// handleMessage directly via HandleDeps, so this is the only place onEnable itself needs to run.
function makeCtx(overrides: {
  config?: Record<string, unknown>;
  registerHook?: (event: string, handler: HookHandler, priority?: number) => void;
} = {}) {
  return {
    config: overrides.config ?? {
      baseUrl: 'https://api.example.com',
      actions: JSON.stringify([{
        id: 'stock', match: { type: 'prefix', value: '/stock' },
        request: { method: 'GET', path: '/stock/{{args.0}}' },
        replyTemplate: 'Stock: {{response.status}}',
      }]),
    },
    logger: { log() {}, debug() {}, warn() {}, error() {} },
    storage: fakeStore(),
    net: { fetch: async () => ({ ok: true, status: 200, statusText: 'OK', headers: {}, body: '{}' }) },
    conversations: { send: async () => {} },
    registerHook: overrides.registerHook ?? (() => {}),
  };
}

// Enables a fresh HttpAction (one '/stock' action) and fires one message:received with `body`, returning
// the synchronous {continue} result. The floated handleMessage call is out of scope — never awaited here.
async function runHook(body: string, type = 'text') {
  let handler: HookHandler | undefined;
  const ctx = makeCtx({ registerHook: (_e, h) => { handler = h; } });
  await new HttpAction().onEnable(ctx as never);
  return handler!({
    event: 'message:received', source: 'Engine', sessionId: 's1', timestamp: new Date(),
    data: msg(body, 'm1', type),
  });
}

// From host 0.23.2 a poll arrives with its question as the body and a contact card with its vCard, so a
// non-empty body no longer means someone typed a command. This plugin performs real writes against the
// operator's backend, which makes an accidental trigger the most expensive one in the catalog.
test('a poll or a contact card never triggers an action', async () => {
  assert.equal((await runHook('/stock ABC')).continue, false,
    'guard rail: typed as text this body DOES trigger the action and claim the message');
  assert.equal((await runHook('/stock ABC', 'poll')).continue, true,
    'a poll titled with a configured prefix must not fire a request');
  assert.equal((await runHook('/stock ABC', 'contact')).continue, true,
    'nor may a contact card');
  assert.equal((await runHook('/stock ABC', 'unknown')).continue, false,
    'a tapped business button is a legitimate way to invoke an action');
});

test('a channel or broadcast post never triggers an action', async () => {
  // A WhatsApp Channel post arrives with isGroup false, so the only chat-scope gate this plugin had
  // read it as an ordinary 1:1 chat. This plugin performs real writes against the operator's backend,
  // so a followed channel whose post happens to start with a configured prefix fired an irreversible
  // request on behalf of a sender the operator has no relationship with.
  let handler: HookHandler | undefined;
  const ctx = makeCtx({ registerHook: (_e, h) => { handler = h; } });
  await new HttpAction().onEnable(ctx as never);
  const fire = (chatId: string) =>
    handler!({
      event: 'message:received', source: 'Engine', sessionId: 's1', timestamp: new Date(),
      data: { ...msg('/stock ABC', 'm1', 'text'), chatId, from: chatId },
    });

  for (const chatId of ['120363000000000000@newsletter', '628123-456@broadcast', 'status@broadcast']) {
    assert.equal((await fire(chatId)).continue, true, `${chatId} must not be claimed or acted on`);
  }
  // Guard rail: the same body in a real chat still triggers, so the test above proves the gate and
  // not a broken fixture.
  assert.equal((await fire('628123456789@c.us')).continue, false);
});

test('a whitespace-only body is ignored', async () => {
  assert.equal((await runHook('   ')).continue, true);
});

// ── Co-installation: claim + priority (PLUGIN-STANDARD.md) ─────────────────────────────────────────

test('registers first among responders', async () => {
  let priority: number | undefined;
  const ctx = makeCtx({ registerHook: (_e, _h, p) => { priority = p; } });
  await new HttpAction().onEnable(ctx as never);
  assert.equal(priority, 70);
});

test('claims a message that matches a configured command, passes anything else on', async () => {
  const matched = await runHook('/stock ABC');
  assert.equal(matched.continue, false, 'the command is addressed to this plugin');

  const other = await runHook('good morning');
  assert.equal(other.continue, true, 'no command matched — let another bot answer');
});

interface Opts { body?: string; status?: number; ok?: boolean; reject?: boolean; now?: () => number }

function makeDeps(o: Opts = {}) {
  const sendCalls: { env: unknown }[] = [];
  const errors: unknown[] = [];
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
    logger: { log() {}, warn: (m: string) => void warns.push(m), error: (m: string, e?: unknown) => errors.push([m, e]) },
  };
  return { d, sendCalls, errors, warns };
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

test('fetch failure: sends the errorTemplate and logs an error', async () => {
  const { d, sendCalls, errors } = makeDeps({ reject: true });
  await handleMessage(d, 's1', msg('cek X'));
  assert.equal((sendCalls[0].env as { text: string }).text, 'ERR');
  assert.ok(errors.length >= 1); // routed through logger.error (not warn) so the Error context is kept
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

test('send failure leaves the message un-marked: a redelivery after the cooldown window retries', async () => {
  let now = 1000;
  let sendAttempts = 0;
  const sendCalls: { env: unknown }[] = [];
  const send = async (env: unknown): Promise<void> => {
    sendAttempts++;
    if (sendAttempts === 1) throw new Error('transient WA failure');
    sendCalls.push({ env });
  };
  const storage = fakeStore();
  const d: HandleDeps = {
    cfg: cfgWith(), storage, cooldown: new Map(), now: () => now,
    fetch: async () => ({ ok: true, status: 200, statusText: 'OK', headers: {}, body: JSON.stringify({ status: 'ok' }) }),
    conversations: { send }, logger: { log() {}, warn() {}, error() {} },
  };
  await handleMessage(d, 's1', msg('cek X', 'm1')).catch(() => {}); // send rejects → no mark
  assert.equal(sendCalls.length, 0); // first send failed → no reply
  assert.equal(await hasSeen(storage, 's1', 'm1'), false); // un-marked → redelivery can retry
  now += cfgWith().cooldownSeconds * 1000 + 1; // past the cooldown window
  await handleMessage(d, 's1', msg('cek X', 'm1')); // redelivery retries
  assert.equal(sendCalls.length, 1); // retried send succeeded
  assert.equal(await hasSeen(storage, 's1', 'm1'), true); // marked only after the successful send
});

// ---- sentinel (DoD §7): the auth token is used in the header but never reaches logs or the reply ----
test('sentinel: the auth token is sent in the header yet never appears in logs or the reply', async () => {
  const SECRET = 'SENTINEL-do-not-leak-9f3k2';
  const logged: unknown[] = [];
  const sendCalls: { env: unknown }[] = [];
  let capturedHeaders: Record<string, string> | undefined;
  const cfg = cfgWith({ authType: 'bearer', authToken: SECRET });
  const d: HandleDeps = {
    cfg, storage: fakeStore(), cooldown: new Map(), now: () => 1000,
    fetch: async (_u, init) => { capturedHeaders = init?.headers; throw new Error('upstream failure'); },
    conversations: { send: async (env: unknown) => { sendCalls.push({ env }); } },
    logger: {
      log: (m: string) => logged.push(m),
      warn: (m: string, e?: unknown) => logged.push([m, e]),
      error: (m: string, e?: unknown) => logged.push([m, e]),
    },
  };
  await handleMessage(d, 's1', msg('cek X'));
  assert.ok(capturedHeaders?.Authorization?.includes(SECRET), 'sanity: secret is in the request header (used, not absent)');
  const haystack = `${JSON.stringify(logged)}${JSON.stringify(sendCalls)}`;
  assert.ok(!haystack.includes(SECRET), 'auth token must never appear in logs or the reply');
});

// ── Sender resolution (0.1.2) ───────────────────────────────────────────────────────────────────────

test('{{sender.phone}} resolves from the JID — the host never sets senderPhone before the hook runs', async () => {
  const { d, sendCalls } = makeDeps({ body: JSON.stringify({ status: 'ok' }) });
  d.cfg = cfgWith({
    actions: JSON.stringify([{
      id: 'me', match: { type: 'prefix', value: 'me' },
      request: { method: 'GET', path: '/c/{{sender.phone}}' },
      replyTemplate: 'phone={{sender.phone}} id={{sender.id}}',
    }]),
  });
  await handleMessage(d, 's1', { ...msg('me'), from: '6281234567890@c.us' } as IncomingMessage);
  assert.equal((sendCalls[0].env as { text: string }).text, 'phone=6281234567890 id=6281234567890@c.us');
});

test('in a group, sender.id is the AUTHOR — not the group everyone shares', async () => {
  const { d, sendCalls } = makeDeps({ body: JSON.stringify({ status: 'ok' }) });
  d.cfg = cfgWith({
    respondInGroups: true,
    actions: JSON.stringify([{
      id: 'me', match: { type: 'prefix', value: 'me' },
      request: { method: 'GET', path: '/c/{{sender.id}}' },
      replyTemplate: 'id={{sender.id}} phone={{sender.phone}}',
    }]),
  });
  const grp = { ...msg('me'), isGroup: true, from: '120363@g.us', chatId: '120363@g.us', author: '6281234567890@c.us' };
  await handleMessage(d, 's1', grp as IncomingMessage);
  assert.equal((sendCalls[0].env as { text: string }).text, 'id=6281234567890@c.us phone=6281234567890');
});

test('a @lid sender yields no phone — a LID user part is not a real number', async () => {
  const { d, sendCalls } = makeDeps({ body: JSON.stringify({ status: 'ok' }) });
  d.cfg = cfgWith({
    actions: JSON.stringify([{
      id: 'me', match: { type: 'prefix', value: 'me' },
      request: { method: 'GET', path: '/c/x' },
      replyTemplate: 'phone=[{{sender.phone}}]',
    }]),
  });
  await handleMessage(d, 's1', { ...msg('me'), from: '118367890123478@lid' } as IncomingMessage);
  assert.equal((sendCalls[0].env as { text: string }).text, 'phone=[]');
});

// ── Silent-drop and empty-reply guards (0.1.2) ──────────────────────────────────────────────────────

test('a dedup read failure is logged instead of dropping the command without a trace', async () => {
  const { d, sendCalls, warns } = makeDeps({});
  d.storage = { ...d.storage, get: async () => { throw new Error('quota'); } };
  await handleMessage(d, 's1', msg('cek INV-001'));
  assert.equal(sendCalls.length, 0, 'still fail-closed — no reply');
  assert.ok(warns.some((w) => w.includes('dedup read failed')), `expected a warning, got ${JSON.stringify(warns)}`);
});

test('a template referencing a missing field sends the error template, never an empty bubble', async () => {
  const { d, sendCalls, warns } = makeDeps({ body: JSON.stringify({ other: 1 }) });
  d.cfg = cfgWith({
    actions: JSON.stringify([{
      id: 'gone', match: { type: 'prefix', value: 'cek ' },
      request: { method: 'GET', path: '/o/{{args.0}}' },
      replyTemplate: '{{response.missing}}', // renders to ''
      errorTemplate: 'Sorry, could not read that.',
    }]),
  });
  await handleMessage(d, 's1', msg('cek INV-001'));
  assert.equal((sendCalls[0].env as { text: string }).text, 'Sorry, could not read that.');
  assert.ok(warns.some((w) => w.includes('empty reply')));
});

test('an empty reply with an empty error template still sends something', async () => {
  const { d, sendCalls } = makeDeps({ body: JSON.stringify({ other: 1 }) });
  d.cfg = cfgWith({
    actions: JSON.stringify([{
      id: 'gone', match: { type: 'prefix', value: 'cek ' },
      request: { method: 'GET', path: '/o/{{args.0}}' },
      replyTemplate: '{{response.missing}}',
      errorTemplate: '{{response.alsoMissing}}',
    }]),
  });
  await handleMessage(d, 's1', msg('cek INV-001'));
  assert.ok((sendCalls[0].env as { text: string }).text.trim().length > 0);
});

// Regression: phoneFromJid originally denylisted only '@lid'. A group, channel or broadcast JID also
// has a numeric local part, so those were emitted as if they were phone numbers — the exact failure the
// helper exists to prevent, and worse than before the helper existed (the field used to be empty).
test('a non-user JID never yields a phone number', async () => {
  const cases: Array<[string, string]> = [
    ['6281234567890@c.us', '6281234567890'],
    ['6281234567890@s.whatsapp.net', '6281234567890'],
    ['628123:12@s.whatsapp.net', '628123'],          // multi-device suffix stripped
    ['118367890123478@lid', ''],                      // privacy id
    ['120363144038483540@g.us', ''],                  // group
    ['120363144038483540@newsletter', ''],            // channel
    ['status@broadcast', ''],
    ['nonsense', ''],
  ];
  for (const [from, want] of cases) {
    const { d, sendCalls } = makeDeps({ body: JSON.stringify({ ok: 1 }) });
    d.cfg = cfgWith({
      actions: JSON.stringify([{
        id: 'me', match: { type: 'prefix', value: 'me' },
        request: { method: 'GET', path: '/c/x' }, replyTemplate: 'p=[{{sender.phone}}]',
      }]),
    });
    await handleMessage(d, 's1', { ...msg('me'), from, author: undefined } as IncomingMessage);
    assert.equal((sendCalls[0].env as { text: string }).text, `p=[${want}]`, `for ${from}`);
  }
});
