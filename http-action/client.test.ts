import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpActionClient, type FetchLike, type FetchResponse } from './client.ts';
import { readConfig, type HttpAction, type HttpActionConfig } from './config.ts';

interface Captured {
  url?: string;
  init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number };
}

// A recording fake mirroring PluginNetCapability.fetch(url, init). Returns a canned response, captures the call.
function fakeFetch(capture: Captured, res: { ok?: boolean; status?: number; body: string }): FetchLike {
  return async (url: string, init?: Captured['init']): Promise<FetchResponse> => {
    capture.url = url;
    capture.init = init;
    return { ok: res.ok ?? true, status: res.status ?? 200, statusText: 'OK', headers: {}, body: res.body };
  };
}

function cfgWith(over: Record<string, unknown> = {}): { config: HttpActionConfig; action: HttpAction } {
  const config = readConfig({
    baseUrl: 'https://api.example.com',
    actions: JSON.stringify([{
      id: 'check', match: { type: 'prefix', value: 'cek ' },
      request: { method: 'GET', path: '/orders/{{args.0}}', query: { zone: '{{args.1}}' }, headers: { 'X-Trace': '{{message.id}}' } },
      replyTemplate: '{{response.status}}',
    }, {
      id: 'create', match: { type: 'prefix', value: 'buat ' },
      request: { method: 'POST', path: '/tickets', bodyTemplate: '{"desc":"{{args.0}}"}' },
      replyTemplate: '{{response.id}}',
    }]),
    ...over,
  });
  return { config, action: config.actions[0] };
}

test('GET builds the URL from baseUrl + rendered (encoded) path', async () => {
  const { config, action } = cfgWith();
  const cap: Captured = {};
  await new HttpActionClient(fakeFetch(cap, { body: '{}' }), config).run(action, { args: ['INV 001'] });
  assert.equal(cap.url, 'https://api.example.com/orders/INV%20001');
});

test('GET has no body', async () => {
  const { config, action } = cfgWith();
  const cap: Captured = {};
  await new HttpActionClient(fakeFetch(cap, { body: '{}' }), config).run(action, { args: ['X'] });
  assert.equal(cap.init?.body, undefined);
});

test('GET appends an encoded query string from a templated value', async () => {
  const { config, action } = cfgWith();
  const cap: Captured = {};
  await new HttpActionClient(fakeFetch(cap, { body: '{}' }), config).run(action, { args: ['X', 'jakarta barat'] });
  assert.match(cap.url ?? '', /\?zone=jakarta%20barat$/);
});

test('action header values are rendered', async () => {
  const { config, action } = cfgWith();
  const cap: Captured = {};
  await new HttpActionClient(fakeFetch(cap, { body: '{}' }), config).run(action, { args: ['X'], message: { id: 'm1' } });
  assert.equal(cap.init?.headers?.['X-Trace'], 'm1');
});

test('a header value with CR/LF (via an attacker-controlled arg) is rejected, never sent', async () => {
  const { config, action } = cfgWith();
  const cap: Captured = {};
  // action.request.headers = { 'X-Trace': '{{message.id}}' }; send a body whose id carries a newline
  await assert.rejects(
    () => new HttpActionClient(fakeFetch(cap, { body: '{}' }), config).run(action, { args: ['X'], message: { id: 'm1\nInjected: evil' } }),
    /CR\/LF|header/i,
  );
  assert.equal(cap.url, undefined); // fetch was never called
});

test('bearer auth adds Authorization: Bearer <token>', async () => {
  const { config, action } = cfgWith({ authType: 'bearer', authToken: 'tok123' });
  const cap: Captured = {};
  await new HttpActionClient(fakeFetch(cap, { body: '{}' }), config).run(action, { args: ['X'] });
  assert.equal(cap.init?.headers?.['Authorization'], 'Bearer tok123');
});

test('apikey auth adds the configured header name', async () => {
  const { config, action } = cfgWith({ authType: 'apikey', authToken: 'key123', apiKeyHeader: 'X-Api-Key' });
  const cap: Captured = {};
  await new HttpActionClient(fakeFetch(cap, { body: '{}' }), config).run(action, { args: ['X'] });
  assert.equal(cap.init?.headers?.['X-Api-Key'], 'key123');
  assert.equal(cap.init?.headers?.['Authorization'], undefined);
});

test('none auth adds no auth header', async () => {
  const { config, action } = cfgWith();
  const cap: Captured = {};
  await new HttpActionClient(fakeFetch(cap, { body: '{}' }), config).run(action, { args: ['X'] });
  assert.equal(cap.init?.headers?.['Authorization'], undefined);
});

test('POST sends a rendered, re-parsed JSON body with application/json content type', async () => {
  const { config } = cfgWith();
  const action = config.actions[1]; // 'create' POST
  const cap: Captured = {};
  await new HttpActionClient(fakeFetch(cap, { body: '{}' }), config).run(action, { args: ['internet mati'] });
  assert.equal(cap.init?.method, 'POST');
  assert.equal(cap.init?.headers?.['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(cap.init?.body ?? '{}'), { desc: 'internet mati' });
});

test('parses a JSON response body into data', async () => {
  const { config, action } = cfgWith();
  const client = new HttpActionClient(fakeFetch({}, { body: JSON.stringify({ status: 'shipped' }) }), config);
  const out = await client.run(action, { args: ['X'] });
  assert.deepEqual(out.data, { status: 'shipped' });
  assert.equal(out.status, 200);
});

test('a response body over the 256 KiB cap is rejected', async () => {
  const { config, action } = cfgWith();
  const big = 'x'.repeat(256 * 1024 + 1);
  const client = new HttpActionClient(fakeFetch({}, { body: big }), config);
  await assert.rejects(() => client.run(action, { args: ['X'] }), /too large|RESPONSE_TOO_LARGE/i);
});

test('a non-JSON body on a 2xx response throws (UPSTREAM_INVALID_JSON)', async () => {
  const { config, action } = cfgWith();
  const client = new HttpActionClient(fakeFetch({}, { ok: true, status: 200, body: 'not json' }), config);
  await assert.rejects(() => client.run(action, { args: ['X'] }), /invalid json|UPSTREAM_INVALID_JSON/i);
});

test('a non-ok status (404) is returned, not thrown, with the status', async () => {
  const { config, action } = cfgWith();
  const client = new HttpActionClient(fakeFetch({}, { ok: false, status: 404, body: '{"error":"none"}' }), config);
  const out = await client.run(action, { args: ['X'] });
  assert.equal(out.status, 404);
  assert.deepEqual(out.data, { error: 'none' });
});

test('timeoutMs from config is passed to fetch init', async () => {
  const { config, action } = cfgWith({ timeoutMs: 2500 });
  const cap: Captured = {};
  await new HttpActionClient(fakeFetch(cap, { body: '{}' }), config).run(action, { args: ['X'] });
  assert.equal(cap.init?.timeoutMs, 2500);
});
