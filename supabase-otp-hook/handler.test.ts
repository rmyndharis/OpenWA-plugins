import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import type { WebhookRequest } from '../types/openwa';
import { handleSendSms, readConfig, phoneToChatId, composeMessage } from './handler.ts';

const keyBytes = randomBytes(32);
const keyB64 = keyBytes.toString('base64');
const secret = `v1,whsec_${keyB64}`;

const TS = 1_700_000_000;
const now = () => TS * 1000;
const ID = 'msg_abc';

function sign(t: number, body: string): string {
  return 'v1,' + createHmac('sha256', keyBytes).update(`${ID}.${t}.${body}`).digest('base64');
}

interface SentCall {
  sessionId: string;
  chatId: string;
  text: string;
}

interface LogEntry {
  message: string;
  meta?: Record<string, unknown>;
}

interface MakeDepsOptions {
  fallbackSessionId?: string;
  messageTemplate?: string;
  appName?: string;
  debug?: boolean;
}

function makeDeps(over: MakeDepsOptions = {}) {
  const sent: SentCall[] = [];
  const logs: LogEntry[] = [];
  const messages = {
    sendText: async (sessionId: string, chatId: string, text: string) => {
      sent.push({ sessionId, chatId, text });
      return { messageId: 'm1', timestamp: TS };
    },
  };
  const engine = {
    canonicalChatId: async (sessionId: string, chatId: string) => chatId,
  };
  const config = readConfig({
    webhookSecret: secret,
    appName: over.appName ?? 'Acme',
    messageTemplate: over.messageTemplate,
    fallbackSessionId: over.fallbackSessionId,
    debug: over.debug,
  });
  return {
    sent,
    logs,
    deps: {
      config,
      messages,
      engine,
      log: (message: string, meta?: Record<string, unknown>) => logs.push({ message, meta }),
      now,
    },
  };
}

interface ReqOptions {
  sessionId?: string;
  headers?: Record<string, string>;
  timestamp?: number;
  rawBody?: string;
}

function makeReq(body: unknown, opts: ReqOptions = {}): WebhookRequest {
  const rawBody = opts.rawBody ?? (typeof body === 'string' ? body : JSON.stringify(body));
  const t = opts.timestamp ?? TS;
  const sig = opts.headers?.['webhook-signature'] ?? sign(t, rawBody);
  return {
    instanceId: 'inst',
    sessionId: opts.sessionId,
    method: 'POST',
    headers: {
      'webhook-id': ID,
      'webhook-timestamp': String(t),
      'webhook-signature': sig,
      ...opts.headers,
    },
    query: {},
    body: rawBody,
    rawBody,
    verified: true,
    deliveryId: 'd1',
  };
}

// ── success paths ────────────────────────────────────────────────────────────

test('happy path: sends the OTP to the bound session and returns 200 application/json', async () => {
  const { sent, deps } = makeDeps();
  const r = await handleSendSms(deps, makeReq({ user: { phone: '+15551234567' }, sms: { otp: '123456' } }, { sessionId: 'sess-1' }));
  assert.equal(r.status, 200);
  assert.equal(r.headers?.['content-type'], 'application/json');
  assert.equal(r.body, '{"ok":true}');
  assert.deepEqual(sent, [{ sessionId: 'sess-1', chatId: '15551234567@c.us', text: 'Acme | Your verification code is 123456' }]);
});

test('falls back to fallbackSessionId when the instance is not bound', async () => {
  const { sent, deps } = makeDeps({ fallbackSessionId: 'fallback-sess' });
  const r = await handleSendSms(deps, makeReq({ user: { phone: '+447911123456' }, sms: { otp: '998877' } }));
  assert.equal(r.status, 200);
  assert.equal(r.headers?.['content-type'], 'application/json');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, 'fallback-sess');
  assert.equal(sent[0].chatId, '447911123456@c.us');
});

test('prefers req.sessionId over fallbackSessionId', async () => {
  const { sent, deps } = makeDeps({ fallbackSessionId: 'fallback-sess' });
  const r = await handleSendSms(deps, makeReq({ user: { phone: '+15559876543' }, sms: { otp: '000000' } }, { sessionId: 'bound-sess' }));
  assert.equal(r.status, 200);
  assert.equal(r.headers?.['content-type'], 'application/json');
  assert.equal(sent[0].sessionId, 'bound-sess');
  assert.equal(sent[0].chatId, '15559876543@c.us');
});

// ── validation / error paths ─────────────────────────────────────────────────

test('returns 500 when no session is available', async () => {
  const { deps } = makeDeps();
  const r = await handleSendSms(deps, makeReq({ user: { phone: '+15551234567' }, sms: { otp: '123456' } }));
  assert.equal(r.status, 500);
  assert.equal(r.headers?.['content-type'], 'application/json');
  assert.equal(JSON.parse(r.body ?? '{}').error, 'no session to send from');
});

test('returns 401 on a forged signature', async () => {
  const { sent, deps } = makeDeps({ fallbackSessionId: 's' });
  const r = makeReq({ user: { phone: '+15551234567' }, sms: { otp: '123456' } }, { headers: { 'webhook-signature': 'v1,Zm9vYmFy' } });
  const result = await handleSendSms(deps, r);
  assert.equal(result.status, 401);
  assert.equal(result.headers?.['content-type'], 'application/json');
  assert.equal(JSON.parse(result.body ?? '{}').ok, false);
  assert.equal(sent.length, 0);
});

test('returns 401 on a stale timestamp', async () => {
  const { sent, deps } = makeDeps({ fallbackSessionId: 's' });
  const stale = TS - 3600;
  const r = makeReq({ user: { phone: '+15551234567' }, sms: { otp: '123456' } }, { sessionId: 's', timestamp: stale });
  const result = await handleSendSms(deps, r);
  assert.equal(result.status, 401);
  assert.equal(result.headers?.['content-type'], 'application/json');
  assert.match(JSON.parse(result.body ?? '{}').error, /tolerance/);
  assert.equal(sent.length, 0);
});

test('returns 400 and does not send when phone is missing', async () => {
  const { sent, deps } = makeDeps({ fallbackSessionId: 's' });
  const r = await handleSendSms(deps, makeReq({ user: {}, sms: { otp: '123456' } }));
  assert.equal(r.status, 400);
  assert.equal(r.headers?.['content-type'], 'application/json');
  assert.equal(JSON.parse(r.body ?? '{}').error, 'missing phone or otp');
  assert.equal(sent.length, 0);
});

test('returns 400 and does not send when otp is missing', async () => {
  const { sent, deps } = makeDeps({ fallbackSessionId: 's' });
  const r = await handleSendSms(deps, makeReq({ user: { phone: '+15551234567' }, sms: {} }));
  assert.equal(r.status, 400);
  assert.equal(r.headers?.['content-type'], 'application/json');
  assert.equal(JSON.parse(r.body ?? '{}').error, 'missing phone or otp');
  assert.equal(sent.length, 0);
});

test('returns 400 on malformed JSON body', async () => {
  const { sent, deps } = makeDeps({ fallbackSessionId: 's' });
  const r = await handleSendSms(deps, makeReq('not json{', { rawBody: 'not json{' }));
  assert.equal(r.status, 400);
  assert.equal(r.headers?.['content-type'], 'application/json');
  assert.equal(JSON.parse(r.body ?? '{}').error, 'malformed JSON body');
  assert.equal(sent.length, 0);
});

test('backgrounds the sendText failure (returns 200; logs the error)', async () => {
  const { logs, deps } = makeDeps({ fallbackSessionId: 's' });
  const messages = { sendText: async () => { throw new Error('session down'); } };
  const r = await handleSendSms({ ...deps, messages }, makeReq({ user: { phone: '+15551234567' }, sms: { otp: '123456' } }));
  assert.equal(r.status, 200);
  // Flush the background .then rejection (microtask) before asserting on logs.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(logs.some(l => l.message.includes('sendText failed (background)') && /session down/.test(String(l.meta?.error))));
});

test('returns 503 and does not send when the session is not live (canonicalChatId probe fails)', async () => {
  const { sent, logs, deps } = makeDeps({ fallbackSessionId: 'dead-sess' });
  const engine = { canonicalChatId: async () => { throw new Error('Session dead-sess has no active engine (unknown or not started)'); } };
  const r = await handleSendSms({ ...deps, engine }, makeReq({ user: { phone: '+15551234567' }, sms: { otp: '123456' } }));
  assert.equal(r.status, 503);
  assert.equal(r.headers?.['content-type'], 'application/json');
  assert.equal(JSON.parse(r.body ?? '{}').error, 'session not live');
  assert.equal(sent.length, 0);
  assert.ok(logs.some(l => l.message.includes('session not live') && /no active engine/.test(String(l.meta?.error))));
});

// ── debug logging ────────────────────────────────────────────────────────────

test('debug mode logs inbound delivery and send details without skipping the send', async () => {
  const { sent, logs, deps } = makeDeps({ fallbackSessionId: 's', debug: true });
  const r = await handleSendSms(deps, makeReq({ user: { phone: '+15551234567' }, sms: { otp: '123456' } }, { sessionId: 'bound-sess' }));
  assert.equal(r.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, 'bound-sess');
  assert.ok(logs.some(l => l.message.includes('inbound delivery')));
  assert.ok(logs.some(l => l.message.includes('sending OTP')));
});

test('debug mode returns 401 on a bad signature before any send', async () => {
  const { sent, logs, deps } = makeDeps({ fallbackSessionId: 's', debug: true });
  const r = makeReq({ user: { phone: '+15551234567' }, sms: { otp: '123456' } }, { headers: { 'webhook-signature': 'v1,Zm9vYmFy' } });
  const result = await handleSendSms(deps, r);
  assert.equal(result.status, 401);
  assert.equal(sent.length, 0);
  assert.ok(logs.some(l => l.message.includes('inbound delivery')));
});

// ── pure helpers ───────────────────────────────────────────────────────────────

test('phoneToChatId strips non-digits and appends @c.us', () => {
  assert.equal(phoneToChatId('+1 (*************'), '1@c.us');
  assert.equal(phoneToChatId('+15551234567'), '15551234567@c.us');
  assert.equal(phoneToChatId('+447911123456'), '447911123456@c.us');
  assert.equal(phoneToChatId('no digits'), undefined);
  assert.equal(phoneToChatId(123 as unknown as string), undefined);
});

test('composeMessage substitutes {appName} and {otp}', () => {
  assert.equal(composeMessage('{appName} | Your code is {otp}', '123456', 'Acme'), 'Acme | Your code is 123456');
  assert.equal(composeMessage('no placeholder', '123456', 'Acme'), 'no placeholder');
});

// ── config parsing ───────────────────────────────────────────────────────────

test('readConfig validates required fields, applies defaults, and reads booleans/strings', () => {
  assert.throws(() => readConfig({ appName: 'Acme' }), /webhookSecret is required/);
  assert.throws(() => readConfig({ webhookSecret: secret }), /appName is required/);
  assert.throws(() => readConfig({ appName: 'Acme', webhookSecret: 'short' }), /at least 16 characters/);

  const defaults = readConfig({ webhookSecret: secret, appName: 'Acme' });
  assert.equal(defaults.messageTemplate, '{appName} | Your verification code is {otp}');
  assert.equal(defaults.debug, false);
  assert.equal(defaults.fallbackSessionId, undefined);

  const full = readConfig({ webhookSecret: secret, appName: 'Acme', debug: true, fallbackSessionId: 'f-sess' });
  assert.equal(full.debug, true);
  assert.equal(full.fallbackSessionId, 'f-sess');
  assert.equal(readConfig({ webhookSecret: secret, appName: 'Acme', debug: 'true' }).debug, true);
  assert.equal(readConfig({ webhookSecret: secret, appName: 'Acme', debug: false }).debug, false);
});
