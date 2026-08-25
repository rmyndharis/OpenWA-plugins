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

// ── chat id derivation ───────────────────────────────────────────────────────
// There is no canonicalChatId round-trip any more. It could never change anything: phoneToChatId always
// produces `<digits>@c.us`, and the host's resolver returns a user-kind jid unchanged — the old tests
// only "passed" because their fake returned a `@lid` id the real host would never return for that input.

test('the OTP is addressed to the phone-derived JID, with no engine round-trip', async () => {
  const { sent, deps } = makeDeps();
  await handleSendSms(
    deps,
    makeReq({ user: { phone: '+15551234567' }, sms: { otp: '123456' } }, { sessionId: 'sess-1' }),
  );
  assert.equal(sent[0].chatId, '15551234567@c.us');
  assert.equal(sent[0].sessionId, 'sess-1');
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

test('a send that fails immediately fails the delivery, so the host retries it', async () => {
  // Supabase was acked 200 before this handler ran and never retries such a delivery itself, so
  // backgrounding an instant rejection lost the OTP outright with one warn line to show for it. The
  // capability layer rejects instantly when the plugin is not activated for the session, when the
  // session has no live engine, and at the concurrent-capability limit. Throwing hands the delivery
  // back to the host, which retries it with backoff and dead-letters it for redrive.
  const { logs, deps } = makeDeps({ fallbackSessionId: 's' });
  const messages = { sendText: async () => { throw new Error('session down'); } };
  const reported: (string | null)[] = [];
  await assert.rejects(
    handleSendSms(
      { ...deps, messages, onSendResult: e => void reported.push(e) },
      makeReq({ user: { phone: '+15551234567' }, sms: { otp: '123456' } }),
    ),
    /WhatsApp send failed: session down/,
  );
  assert.ok(logs.some(l => l.message.includes('sendText failed') && /session down/.test(String(l.meta?.error))));
  assert.deepEqual(reported, ['session down'], 'the outcome is reported for healthCheck');
});

test('a send that is merely slow is left running and does not fail the delivery', async () => {
  // The opposite failure mode, and the reason the send is not simply awaited: the worker dispatch is
  // bounded to 5 s, and an overrun reaches the host as a failed delivery, which retries the job and
  // sends the contact a DUPLICATE OTP.
  const { deps } = makeDeps({ fallbackSessionId: 's' });
  let settle: (() => void) | undefined;
  const messages = { sendText: () => new Promise<never>((_res, _rej) => { settle = () => _rej(new Error('late failure')); }) as never };
  const reported: (string | null)[] = [];
  // failFastMs shortened so the test does not wait the real window.
  await handleSendSms(
    { ...deps, messages, failFastMs: 5, onSendResult: e => void reported.push(e) },
    makeReq({ user: { phone: '+15551234567' }, sms: { otp: '123456' } }),
  );
  assert.deepEqual(reported, [], 'nothing is known yet when the handler returns');

  // The send outliving the handler still reports, which is what healthCheck surfaces.
  settle?.();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(reported, ['late failure']);
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

test('debug mode never writes the OTP or the destination number into a log', async () => {
  // Debug is switched on precisely when a delivery is misbehaving, so its output is what gets pasted
  // into a support thread or shipped to a log collector. A verification code is a live credential and
  // the number beside it names its owner; neither belongs in a line written for diagnostics.
  const { logs, deps } = makeDeps({ fallbackSessionId: 's', debug: true });
  await handleSendSms(deps, makeReq({ user: { phone: '+15551234567' }, sms: { otp: '481932' } }, { sessionId: 'sess' }));

  const written = JSON.stringify(logs);
  assert.ok(!written.includes('481932'), `the OTP reached a log: ${written}`);
  assert.ok(!written.includes('15551234567'), `the phone number reached a log: ${written}`);
  // The diagnostic value has to survive: an operator still needs to see that a send was attempted.
  assert.ok(logs.some((l) => l.message.includes('sending OTP')));
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
