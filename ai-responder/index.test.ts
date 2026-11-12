import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { HookResult, PluginNetRequestInit, PluginNetResponse } from '../types/openwa';
import AIResponder, { parseConfig } from './index.ts';

const KEY = 'sk-test-SECRET-0123456789';
const BASE: Record<string, unknown> = { apiBaseUrl: 'https://api.openai.com/v1', apiKey: KEY, model: 'gpt-4o-mini' };

type Handler = (hook: unknown) => Promise<HookResult> | HookResult;
type Respond = (url: string, init?: PluginNetRequestInit) => Promise<PluginNetResponse>;

const okBody = (content: string): PluginNetResponse => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: {},
  body: JSON.stringify({ choices: [{ message: { content } }] }),
});

// Enables a fresh plugin against a fake ctx. `config` may be a function of the firing session, which is
// how the host resolves a per-session override: ctx.config is a getter that answers for the session
// whose event is being dispatched. Storage rejects every call, since the plugin declares no storage.
async function enable(config: Record<string, unknown> | ((sessionId?: string) => Record<string, unknown>) = BASE) {
  const fetches: Array<{ url: string; init?: PluginNetRequestInit }> = [];
  const replies: Array<{ sessionId: string; chatId: string; quoted: string; text: string }> = [];
  const logs: string[] = [];
  const hooks: Array<{ event: string; handler: Handler; priority?: number }> = [];
  const state: { firing?: string; respond: Respond; sendFails?: boolean } = { respond: async () => okBody('Hello!') };
  const record = (level: string) => (m: string, a?: unknown) =>
    logs.push(`${level} ${m} ${a instanceof Error ? `${a.message}\n${a.stack}` : JSON.stringify(a ?? null)}`);
  const noStorage = () => Promise.reject(new Error('storage is not used by this plugin'));
  const ctx = {
    pluginId: 'ai-responder',
    get config() {
      return typeof config === 'function' ? config(state.firing) : config;
    },
    logger: { log: record('log'), debug: record('debug'), warn: record('warn'), error: record('error') },
    registerHook: (event: string, handler: Handler, priority?: number) => hooks.push({ event, handler, priority }),
    messages: {
      reply: async (sessionId: string, chatId: string, quoted: string, text: string) => {
        if (state.sendFails) throw new Error('send refused');
        replies.push({ sessionId, chatId, quoted, text });
        return { messageId: 'r', timestamp: 0 };
      },
      sendText: async () => {
        throw new Error('every answer must be a quoted reply');
      },
    },
    net: {
      fetch: (url: string, init?: PluginNetRequestInit) => {
        fetches.push({ url, init });
        return state.respond(url, init);
      },
    },
    storage: { get: noStorage, set: noStorage, delete: noStorage, list: noStorage },
  };
  await new AIResponder().onEnable(ctx as never);
  const fire = async (data: Record<string, unknown>, hook: Record<string, unknown> = {}): Promise<HookResult> => {
    const sessionId = 'sessionId' in hook ? (hook.sessionId as string | undefined) : 's1';
    state.firing = sessionId;
    const out = await hooks[0].handler({ event: 'message:received', source: 'Engine', timestamp: new Date(), ...hook, sessionId, data });
    await settle();
    return out;
  };
  return { fetches, replies, logs, hooks, state, fire };
}

let seq = 0;
const msg = (over: Record<string, unknown> = {}) => ({
  id: `m${++seq}`,
  chatId: '628111000111@c.us',
  from: '628111000111@c.us',
  to: '628999000999@c.us',
  body: 'hello',
  type: 'text',
  fromMe: false,
  isGroup: false,
  timestamp: Math.floor(Date.now() / 1000),
  ...over,
});

// Floated work runs on promise callbacks; one macrotask turn lets all of them drain.
const settle = () => new Promise(r => setImmediate(r));

const CLAIMED = { continue: false };
const PASSED = { continue: true };

test('registers message:received at priority 97, after after-hours', async () => {
  const h = await enable();
  assert.equal(h.hooks.length, 1);
  assert.equal(h.hooks[0].event, 'message:received');
  assert.equal(h.hooks[0].priority, 97);
});

test('claims an in-scope message and answers it as a quoted reply in WhatsApp formatting', async () => {
  const h = await enable();
  h.state.respond = async () => okBody('**Bold** and *italic*, see [docs](https://example.com)');
  const m = msg({ body: 'what are your hours?' });
  assert.deepEqual(await h.fire(m), CLAIMED);
  assert.equal(h.fetches.length, 1);
  assert.equal(h.fetches[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.deepEqual(h.replies, [
    { sessionId: 's1', chatId: m.chatId, quoted: m.id, text: '*Bold* and _italic_, see docs (https://example.com)' },
  ]);
});

test('the hook resolves before the provider answers', async () => {
  const h = await enable();
  let release!: (r: PluginNetResponse) => void;
  h.state.respond = () => new Promise(r => (release = r));
  assert.deepEqual(await h.fire(msg()), CLAIMED, 'claimed while the provider call is still open');
  assert.equal(h.fetches.length, 1);
  assert.equal(h.replies.length, 0, 'nothing sent yet');
  release(okBody('late but fine'));
  await settle();
  assert.equal(h.replies.length, 1);
  assert.equal(h.replies[0].text, 'late but fine');
});

test('events that are not a live inbound message are never claimed or sent to the provider', async () => {
  const h = await enable();
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>?]> = [
    ['not from the engine', msg(), { source: 'Webhook' }],
    ['no session id', msg(), { sessionId: undefined }],
    ['no message id', msg({ id: '' })],
    ['no chat id', msg({ chatId: '' })],
    ['sent by this account', msg({ fromMe: true })],
    ['forwarded message', msg({ isForwarded: true })],
    ['empty body', msg({ body: '' })],
    ['whitespace body', msg({ body: '  \n ' })],
    ['non-string body', msg({ body: 42 })],
  ];
  for (const [label, data, hook] of cases) {
    assert.deepEqual(await h.fire(data, hook), PASSED, label);
  }
  assert.equal(h.fetches.length, 0);
  assert.deepEqual(h.replies, []);
});

test('contact cards, polls, orders, products and locations are not prose and are never answered', async () => {
  const h = await enable();
  for (const type of ['contact', 'poll', 'order', 'product']) {
    assert.deepEqual(await h.fire(msg({ type, body: 'BEGIN:VCARD\nFN:Budi\nEND:VCARD' })), PASSED, type);
  }
  // whatsapp-web.js delivers a shared location with its base64 map thumbnail as the body.
  assert.deepEqual(await h.fire(msg({ type: 'location', body: '/9j/4AAQSkZJRgABAQAAAQABAAD' })), PASSED, 'location');
  assert.equal(h.fetches.length, 0);
  // Guard rails: a button reply ('unknown') and a captioned image are real input.
  assert.deepEqual(await h.fire(msg({ type: 'unknown', body: 'Yes, book it' })), CLAIMED);
  assert.deepEqual(await h.fire(msg({ type: 'image', body: 'is this in stock?', chatId: '628222@c.us' })), CLAIMED);
  assert.equal(h.fetches.length, 2);
});

test('groups are skipped unless respondInGroups is on, and an authorless group message always is', async () => {
  const off = await enable();
  assert.deepEqual(await off.fire(msg({ chatId: '1203@g.us', isGroup: true, author: '628111@c.us' })), PASSED);
  assert.equal(off.fetches.length, 0);

  const on = await enable({ ...BASE, respondInGroups: true });
  assert.deepEqual(await on.fire(msg({ chatId: '1203@g.us', isGroup: true })), PASSED, 'no author');
  assert.equal(on.fetches.length, 0);
  assert.deepEqual(await on.fire(msg({ chatId: '1203@g.us', isGroup: true, author: '628111@c.us' })), CLAIMED);
  assert.equal(on.replies.length, 1);
});

test('channel, broadcast-list and status chats are never answered', async () => {
  const h = await enable();
  for (const chatId of ['120363000000000000@newsletter', '628123-456@broadcast', 'status@broadcast']) {
    assert.deepEqual(await h.fire(msg({ chatId })), PASSED, chatId);
  }
  assert.equal(h.fetches.length, 0);
  // Guard rail: the same fixture in a 1:1 chat is answered, so the gate is what stopped the others.
  assert.deepEqual(await h.fire(msg()), CLAIMED);
});

test('a message delivered more than five minutes after it was sent is not answered', async () => {
  const h = await enable();
  const now = Math.floor(Date.now() / 1000);
  assert.deepEqual(await h.fire(msg({ timestamp: now - 6 * 60 })), PASSED);
  assert.equal(h.fetches.length, 0);
  assert.deepEqual(await h.fire(msg({ timestamp: now - 4 * 60 })), CLAIMED, 'four minutes is live');
  assert.deepEqual(await h.fire(msg({ timestamp: 0, chatId: '628222@c.us' })), CLAIMED, 'no send time counts as now');
  assert.deepEqual(await h.fire(msg({ timestamp: undefined, chatId: '628333@c.us' })), CLAIMED);
  assert.equal(h.fetches.length, 3);
});

test('a redelivered message id is answered once per session', async () => {
  const h = await enable();
  const m = msg();
  assert.deepEqual(await h.fire(m), CLAIMED);
  assert.deepEqual(await h.fire(m), CLAIMED, 'still ours, so still claimed');
  assert.equal(h.fetches.length, 1, 'but not sent to the provider again');
  assert.equal(h.replies.length, 1);
  assert.deepEqual(await h.fire(m, { sessionId: 's2' }), CLAIMED, 'the same id on another session is its own message');
  assert.equal(h.fetches.length, 2);
});

test('the per-chat hourly limit stops claiming and warns once per chat', async () => {
  const h = await enable({ ...BASE, maxRepliesPerChatPerHour: 2 });
  assert.deepEqual(await h.fire(msg()), CLAIMED);
  assert.deepEqual(await h.fire(msg()), CLAIMED);
  assert.deepEqual(await h.fire(msg()), PASSED, 'over the limit, left to the rest of the chain');
  assert.deepEqual(await h.fire(msg()), PASSED);
  assert.equal(h.fetches.length, 2);
  assert.equal(h.logs.filter(l => l.startsWith('warn') && l.includes('limit')).length, 1, 'one warning per chat per window');
  assert.deepEqual(await h.fire(msg({ chatId: '628222@c.us' })), CLAIMED, 'another chat is unaffected');
});

test('the per-session hourly cap stops claiming across chats and leaves other sessions alone', async () => {
  const h = await enable({ ...BASE, maxRepliesPerSessionPerHour: 3 });
  for (const chat of ['a', 'b', 'c']) assert.deepEqual(await h.fire(msg({ chatId: `${chat}@c.us` })), CLAIMED);
  for (const chat of ['d', 'e', 'f']) assert.deepEqual(await h.fire(msg({ chatId: `${chat}@c.us` })), PASSED);
  assert.equal(h.fetches.length, 3);
  assert.equal(h.logs.filter(l => l.startsWith('warn') && l.includes('limit')).length, 1, 'one warning per session, not per chat');
  assert.deepEqual(await h.fire(msg({ chatId: 'd@c.us' }), { sessionId: 's2' }), CLAIMED);
});

test('at most eight provider calls are open at once; the next message is not claimed', async () => {
  const h = await enable();
  const pending: Array<(r: PluginNetResponse) => void> = [];
  h.state.respond = () => new Promise(r => pending.push(r));
  for (let i = 0; i < 8; i++) assert.deepEqual(await h.fire(msg({ chatId: `${i}@c.us` })), CLAIMED);
  assert.deepEqual(await h.fire(msg({ chatId: '9@c.us' })), PASSED, 'over the cap, left to the rest of the chain');
  assert.equal(h.fetches.length, 8);
  assert.equal(h.logs.filter(l => l.startsWith('warn')).length, 1);
  pending[0](okBody('done'));
  await settle();
  assert.deepEqual(await h.fire(msg({ chatId: '9@c.us' })), CLAIMED, 'a finished call frees its slot');
});

test('the hourly limits reset in the next hour', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 24, 10, 0, 0) });
  try {
    const h = await enable({ ...BASE, maxRepliesPerChatPerHour: 1 });
    const at = () => Math.floor(Date.now() / 1000);
    assert.deepEqual(await h.fire(msg({ timestamp: at() })), CLAIMED);
    assert.deepEqual(await h.fire(msg({ timestamp: at() })), PASSED);
    mock.timers.tick(60 * 60_000);
    assert.deepEqual(await h.fire(msg({ timestamp: at() })), CLAIMED);
  } finally {
    mock.timers.reset();
  }
});

test('config is resolved per event, so a per-session override applies', async () => {
  const h = await enable(sessionId =>
    sessionId === 's2'
      ? { ...BASE, model: 'llama-3.1-8b', systemPrompt: 'Answer in Spanish.', respondInGroups: true }
      : BASE,
  );
  await h.fire(msg({ chatId: '1203@g.us', isGroup: true, author: 'x@c.us' }));
  assert.equal(h.fetches.length, 0, 'the base config keeps groups off');
  await h.fire(msg({ chatId: '1203@g.us', isGroup: true, author: 'x@c.us' }), { sessionId: 's2' });
  assert.equal(h.fetches.length, 1);
  const body = JSON.parse(h.fetches[0].init?.body as string);
  assert.equal(body.model, 'llama-3.1-8b');
  assert.deepEqual(body.messages[0], { role: 'system', content: 'Answer in Spanish.' });
});

test('an invalid per-session config skips the message without claiming it', async () => {
  const h = await enable(sessionId => (sessionId === 's2' ? { ...BASE, apiBaseUrl: 'http://example.com/v1' } : BASE));
  assert.deepEqual(await h.fire(msg(), { sessionId: 's2' }), PASSED);
  assert.equal(h.fetches.length, 0);
  assert.ok(h.logs.some(l => l.startsWith('warn') && l.includes('apiBaseUrl')));
});

test('apiBaseUrl must be https, or http on a loopback host, without credentials', async () => {
  for (const ok of [
    'https://api.openai.com/v1',
    'https://api.groq.com/openai/v1',
    'http://localhost:11434/v1',
    'http://127.0.0.1:8000/v1',
    'http://[::1]:8080/v1',
  ]) {
    assert.doesNotThrow(() => parseConfig({ ...BASE, apiBaseUrl: ok }), ok);
  }
  for (const bad of [
    '',
    'not a url',
    'http://api.openai.com/v1',
    'http://192.168.1.10:11434/v1',
    'ftp://api.openai.com/v1',
    'https://user:pass@api.openai.com/v1',
    'http://user@localhost:11434/v1',
    'https://api.openai.com/v1?x=1',
    'https://api.openai.com/v1#frag',
  ]) {
    assert.throws(() => parseConfig({ ...BASE, apiBaseUrl: bad }), /apiBaseUrl/, JSON.stringify(bad));
  }
  assert.throws(() => parseConfig({ ...BASE, apiBaseUrl: undefined }), /apiBaseUrl/, 'no code-side default');
  assert.throws(() => parseConfig({ ...BASE, apiKey: '' }), /apiKey/);
  await assert.rejects(enable({ ...BASE, apiBaseUrl: 'http://example.com/v1' }), /apiBaseUrl/, 'a bad config fails enable');
});

test('the input is truncated and the output bounded by max_tokens', async () => {
  const h = await enable({ ...BASE, maxInputChars: 10, maxOutputTokens: 64 });
  await h.fire(msg({ body: '  0123456789abcdef  ' }));
  const body = JSON.parse(h.fetches[0].init?.body as string);
  assert.equal(body.messages.at(-1).content, '0123456789');
  assert.equal(body.max_tokens, 64);

  const d = await enable();
  await d.fire(msg({ body: 'x'.repeat(5000) }));
  const def = JSON.parse(d.fetches[0].init?.body as string);
  assert.equal(def.messages.at(-1).content.length, 2000, 'default maxInputChars');
  assert.equal(def.max_tokens, 500, 'default maxOutputTokens');
  assert.equal(d.fetches[0].init?.timeoutMs, 15000, 'default timeout');
});

test('truncation never leaves half of a surrogate pair', async () => {
  const h = await enable({ ...BASE, maxInputChars: 3 });
  await h.fire(msg({ body: 'ab😀c' }));
  assert.equal(JSON.parse(h.fetches[0].init?.body as string).messages.at(-1).content, 'ab');
});

test('the fetch timeout is clamped below the host capability ceiling', async () => {
  const hi = await enable({ ...BASE, timeoutMs: 60000 });
  await hi.fire(msg());
  assert.equal(hi.fetches[0].init?.timeoutMs, 25000);
  const lo = await enable({ ...BASE, timeoutMs: 500 });
  await lo.fire(msg());
  assert.equal(lo.fetches[0].init?.timeoutMs, 1000);
  // The config API stores a cleared field as "", which must not read as 0 and clamp to one second.
  const blank = await enable({ ...BASE, timeoutMs: '' });
  await blank.fire(msg());
  assert.equal(blank.fetches[0].init?.timeoutMs, 15000);
});

test('a provider error is logged with its status and a short body, never the API key', async () => {
  const h = await enable();
  h.state.respond = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    headers: {},
    body: `{"error":"Incorrect API key provided: ${KEY}"}${'x'.repeat(5000)}`,
  });
  assert.deepEqual(await h.fire(msg()), CLAIMED, 'claimed before the outcome was known');
  assert.deepEqual(h.replies, [], 'a failure is silence, not a second bot');
  const errors = h.logs.filter(l => l.startsWith('error'));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /401/);
  assert.ok(!h.logs.some(l => l.includes(KEY)), 'the key never reaches a log line');
  assert.ok(errors[0].includes('x'.repeat(100)), 'guard rail: the body is in the log');
  assert.ok(!errors[0].includes('x'.repeat(300)), 'but only a short slice of it');
});

test('a failed send is logged', async () => {
  const h = await enable();
  h.state.sendFails = true;
  assert.deepEqual(await h.fire(msg()), CLAIMED);
  const errors = h.logs.filter(l => l.startsWith('error'));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /send refused/);
});

test('strips multiple trailing slashes from apiBaseUrl and rejects replies that become empty after formatting', async () => {
  const h = await enable({ ...BASE, apiBaseUrl: 'https://api.openai.com/v1///' });
  h.state.respond = async () => okBody('`   `');
  assert.deepEqual(await h.fire(msg()), CLAIMED);
  assert.equal(h.fetches[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.deepEqual(h.replies, []);
  const errors = h.logs.filter(l => l.startsWith('error'));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /empty reply after formatting/);
});
