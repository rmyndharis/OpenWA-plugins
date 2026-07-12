import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebhookRequest } from '../types/openwa';
import { handleSendSms, readConfig, phoneToChatId, composeMessage } from './handler.ts';

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
      return { messageId: 'm1', timestamp: 1_700_000_000 };
    },
  };
  const config = readConfig({
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
      log: (message: string, meta?: Record<string, unknown>) => logs.push({ message, meta }),
    },
  };
}

interface ReqOptions {
  sessionId?: string;
}

function makeReq(body: unknown, opts: ReqOptions = {}): WebhookRequest {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    instanceId: 'inst',
    sessionId: opts.sessionId,
    method: 'POST',
    headers: {},
    query: {},
    body: rawBody,
    rawBody,
    verified: true,
    deliveryId: 'd1',
  };
}

// ── success paths ────────────────────────────────────────────────────────────

test('happy path: sends the OTP to the bound session', async () => {
  const { sent, deps } = makeDeps();
  await handleSendSms(deps, makeReq({ user: { phone: '+15551234567' }, sms: { otp: '123456' } }, { sessionId: 'sess-1' }));
  assert.deepEqual(sent, [{ sessionId: 'sess-1', chatId: '15551234567@c.us', text: 'Acme | Your verification code is 123456' }]);
});

test('falls back to fallbackSessionId when the instance is not bound', async () => {
  const { sent, deps } = makeDeps({ fallbackSessionId: 'fallback-sess' });
  await handleSendSms(deps, makeReq({ user: { phone: '+447911123456' }, sms: { otp: '998877' } }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, 'fallback-sess');
  assert.equal(sent[0].chatId, '447911123456@c.us');
});

test('prefers req.sessionId over fallbackSessionId', async () => {
  const { sent, deps } = makeDeps({ fallbackSessionId: 'fallback-sess' });
  await handleSendSms(deps, makeReq({ user: { phone: '+15559876543' }, sms: { otp: '000000' } }, { sessionId: 'bound-sess' }));
  assert.equal(sent[0].sessionId, 'bound-sess');
  assert.equal(sent[0].chatId, '15559876543@c.us');
});

// ── validation / no-send paths (return → no retry) ───────────────────────────
// Signature verification and the session-liveness check are host-side; these cover the payload-level
// permanent failures the handler itself rejects (by returning, so the host does not retry/DLQ them).

test('does not send when phone is missing', async () => {
  const { sent, deps } = makeDeps({ fallbackSessionId: 's' });
  await handleSendSms(deps, makeReq({ user: {}, sms: { otp: '123456' } }));
  assert.equal(sent.length, 0);
});

test('does not send when otp is missing', async () => {
  const { sent, deps } = makeDeps({ fallbackSessionId: 's' });
  await handleSendSms(deps, makeReq({ user: { phone: '+15551234567' }, sms: {} }));
  assert.equal(sent.length, 0);
});

test('does not send on a malformed JSON body', async () => {
  const { sent, deps } = makeDeps({ fallbackSessionId: 's' });
  await handleSendSms(deps, makeReq('not json{'));
  assert.equal(sent.length, 0);
});

test('does not send when no session is available', async () => {
  const { sent, deps } = makeDeps();
  await handleSendSms(deps, makeReq({ user: { phone: '+15551234567' }, sms: { otp: '123456' } }));
  assert.equal(sent.length, 0);
});

// ── send behavior ────────────────────────────────────────────────────────────

test('backgrounds the sendText failure (logs the error, does not throw)', async () => {
  const { logs, deps } = makeDeps({ fallbackSessionId: 's' });
  const messages = { sendText: async () => { throw new Error('session down'); } };
  await handleSendSms({ ...deps, messages }, makeReq({ user: { phone: '+15551234567' }, sms: { otp: '123456' } }));
  // Flush the background .then rejection (microtask) before asserting on logs.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(logs.some(l => l.message.includes('sendText failed (background)') && /session down/.test(String(l.meta?.error))));
});

// ── debug logging ────────────────────────────────────────────────────────────

test('debug mode logs the inbound delivery and send details without skipping the send', async () => {
  const { sent, logs, deps } = makeDeps({ fallbackSessionId: 's', debug: true });
  await handleSendSms(deps, makeReq({ user: { phone: '+15551234567' }, sms: { otp: '123456' } }, { sessionId: 'bound-sess' }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, 'bound-sess');
  assert.ok(logs.some(l => l.message.includes('inbound delivery')));
  assert.ok(logs.some(l => l.message.includes('sending OTP')));
});

// ── pure helpers ────────────────────────────────────────────────────────────

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

test('readConfig validates appName, applies defaults, and reads booleans/strings', () => {
  assert.throws(() => readConfig({}), /appName is required/);

  const defaults = readConfig({ appName: 'Acme' });
  assert.equal(defaults.messageTemplate, '{appName} | Your verification code is {otp}');
  assert.equal(defaults.debug, false);
  assert.equal(defaults.fallbackSessionId, undefined);

  const full = readConfig({ appName: 'Acme', debug: true, fallbackSessionId: 'f-sess' });
  assert.equal(full.debug, true);
  assert.equal(full.fallbackSessionId, 'f-sess');
  assert.equal(readConfig({ appName: 'Acme', debug: 'true' }).debug, true);
  assert.equal(readConfig({ appName: 'Acme', debug: false }).debug, false);
});
