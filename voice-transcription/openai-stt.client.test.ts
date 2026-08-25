import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginNetCapability, PluginNetRequestInit, PluginNetResponse } from '../types/openwa';
import { OpenAiSttClient, isHostBackpressure, sanitizeContentType } from './openai-stt.client.ts';

test('sanitizeContentType keeps a valid mimetype (codec-stripped) but rejects CRLF / garbage', () => {
  assert.equal(sanitizeContentType('audio/ogg; codecs=opus'), 'audio/ogg'); // real PTT — codec stripped, kept
  assert.equal(sanitizeContentType('audio/mpeg'), 'audio/mpeg');
  assert.equal(sanitizeContentType('audio/x-wav'), 'audio/x-wav');
  assert.equal(sanitizeContentType('audio/vnd.wave'), 'audio/vnd.wave');
  // A CRLF-bearing mimetype must not reach the multipart part headers verbatim.
  assert.equal(sanitizeContentType('audio/ogg\r\nContent-Disposition: form-data; name="prompt"'), 'audio/ogg');
  assert.equal(sanitizeContentType(''), 'audio/ogg');
  assert.equal(sanitizeContentType('not a mime type'), 'audio/ogg');
});

function res(partial: { ok?: boolean; status?: number; body?: string }): PluginNetResponse {
  return {
    ok: partial.ok ?? true,
    status: partial.status ?? 200,
    statusText: '',
    headers: {},
    body: partial.body ?? '{}',
  };
}

function fakeNet(response: PluginNetResponse) {
  const calls: Array<{ url: string; init: PluginNetRequestInit }> = [];
  const net: PluginNetCapability = {
    fetch: async (url: string, init?: PluginNetRequestInit) => {
      calls.push({ url, init: init ?? {} });
      return response;
    },
  };
  return { net, calls };
}

const body = (init: PluginNetRequestInit) => init.body as Buffer;

test('posts to /v1/audio/transcriptions and returns the transcribed text', async () => {
  const { net, calls } = fakeNet(res({ body: JSON.stringify({ text: 'hello there' }) }));
  const c = new OpenAiSttClient({ baseUrl: 'http://stt:8000/', model: 'small', timeoutMs: 20000, net });
  const out = await c.transcribe(Uint8Array.from([1, 2, 3]), 'audio/ogg; codecs=opus');
  assert.equal(out.text, 'hello there');
  assert.equal(calls[0].url, 'http://stt:8000/v1/audio/transcriptions'); // trailing slash trimmed
  assert.equal(calls[0].init.method, 'POST');
});

test('uploads audio as a binary multipart Buffer with model + voice.ogg part, codecs stripped', async () => {
  const { net, calls } = fakeNet(res({ body: '{"text":"x"}' }));
  const c = new OpenAiSttClient({ baseUrl: 'http://stt:8000', model: 'base', timeoutMs: 1000, net });
  await c.transcribe(Uint8Array.from([0x80, 0xff, 0x4f]), 'audio/ogg; codecs=opus');
  const b = body(calls[0].init);
  assert.ok(Buffer.isBuffer(b), 'body must be a binary Buffer, not a string');
  assert.ok(b.includes(Buffer.from(Uint8Array.from([0x80, 0xff, 0x4f]))), 'raw audio bytes intact');
  const text = b.toString('latin1');
  assert.ok(text.includes('name="model"') && text.includes('base'));
  assert.ok(text.includes('filename="voice.ogg"'));
  assert.ok(text.includes('Content-Type: audio/ogg') && !text.includes('codecs=opus'));
  assert.match(calls[0].init.headers!['content-type'], /^multipart\/form-data; boundary=/);
});

test('includes the language field only when configured', async () => {
  const withLang = fakeNet(res({ body: '{"text":"x"}' }));
  await new OpenAiSttClient({ baseUrl: 'http://stt', model: 's', language: 'es', timeoutMs: 1000, net: withLang.net })
    .transcribe(Uint8Array.from([1]), 'audio/ogg');
  assert.ok(body(withLang.calls[0].init).toString('latin1').includes('name="language"'));

  const noLang = fakeNet(res({ body: '{"text":"x"}' }));
  await new OpenAiSttClient({ baseUrl: 'http://stt', model: 's', timeoutMs: 1000, net: noLang.net })
    .transcribe(Uint8Array.from([1]), 'audio/ogg');
  assert.ok(!body(noLang.calls[0].init).toString('latin1').includes('name="language"'));
});

test('sets Authorization Bearer when an apiKey is configured, omits it otherwise', async () => {
  const withKey = fakeNet(res({ body: '{"text":"x"}' }));
  await new OpenAiSttClient({ baseUrl: 'http://stt', model: 's', apiKey: 'sk-1', timeoutMs: 1000, net: withKey.net })
    .transcribe(Uint8Array.from([1]), 'audio/ogg');
  assert.equal(withKey.calls[0].init.headers!['authorization'], 'Bearer sk-1');

  const noKey = fakeNet(res({ body: '{"text":"x"}' }));
  await new OpenAiSttClient({ baseUrl: 'http://stt', model: 's', timeoutMs: 1000, net: noKey.net })
    .transcribe(Uint8Array.from([1]), 'audio/ogg');
  assert.equal(noKey.calls[0].init.headers!['authorization'], undefined);
});

test('throws on a non-ok HTTP status', async () => {
  const { net } = fakeNet(res({ ok: false, status: 500, body: 'boom' }));
  const c = new OpenAiSttClient({ baseUrl: 'http://stt', model: 's', timeoutMs: 1000, net });
  await assert.rejects(c.transcribe(Uint8Array.from([1]), 'audio/ogg'), /500/);
});

test('throws when the response body has no text string', async () => {
  const { net } = fakeNet(res({ body: '{"foo":1}' }));
  const c = new OpenAiSttClient({ baseUrl: 'http://stt', model: 's', timeoutMs: 1000, net });
  await assert.rejects(c.transcribe(Uint8Array.from([1]), 'audio/ogg'), /text/);
});

function throwingNet() {
  let n = 0;
  const net: PluginNetCapability = {
    fetch: async () => {
      n++;
      throw new Error('econnrefused');
    },
  };
  return { net, calls: () => n };
}

const a = Uint8Array.from([1]);

test('opens the circuit after failureThreshold failures and short-circuits without hitting the network', async () => {
  const { net, calls } = throwingNet();
  const c = new OpenAiSttClient({ baseUrl: 'http://stt', model: 's', timeoutMs: 1000, net, failureThreshold: 2 });
  await assert.rejects(c.transcribe(a, 'audio/ogg'), /econnrefused/);
  await assert.rejects(c.transcribe(a, 'audio/ogg'), /econnrefused/);
  await assert.rejects(c.transcribe(a, 'audio/ogg'), /circuit open/); // open → no network
  assert.equal(calls(), 2);
});

test('a success resets the consecutive-failure counter (circuit stays closed)', async () => {
  let mode: 'fail' | 'ok' = 'fail';
  const net: PluginNetCapability = {
    fetch: async () => {
      if (mode === 'fail') throw new Error('boom');
      return res({ body: '{"text":"x"}' });
    },
  };
  const c = new OpenAiSttClient({ baseUrl: 'http://stt', model: 's', timeoutMs: 1000, net, failureThreshold: 2 });
  await assert.rejects(c.transcribe(a, 'audio/ogg')); // failure 1
  mode = 'ok';
  await c.transcribe(a, 'audio/ogg'); // success → reset
  mode = 'fail';
  await assert.rejects(c.transcribe(a, 'audio/ogg')); // failure 1 again, below threshold
  assert.equal(c.isHealthy(), true);
});

test('the circuit re-closes after the cooldown elapses', async () => {
  let t = 1000;
  const { net, calls } = throwingNet();
  const c = new OpenAiSttClient({
    baseUrl: 'http://stt', model: 's', timeoutMs: 1000, net, failureThreshold: 1, cooldownMs: 5000, now: () => t,
  });
  await assert.rejects(c.transcribe(a, 'audio/ogg'), /econnrefused/); // opens (threshold 1)
  await assert.rejects(c.transcribe(a, 'audio/ogg'), /circuit open/); // open
  assert.equal(calls(), 1);
  t = 6001; // past cooldown
  await assert.rejects(c.transcribe(a, 'audio/ogg'), /econnrefused/); // closed → hits net again
  assert.equal(calls(), 2);
});

test('host backpressure does not open the circuit breaker', async () => {
  // The host rejects a fetch past its GLOBAL 16-slot limit, and a capability call past the per-plugin
  // in-flight limit, both instantly and both shared with every other plugin on the gateway. Counting
  // them as backend failures opened the breaker on a healthy backend: a busy line saturates the pool,
  // the rejections are immediate and therefore consecutive, and five in a row stopped transcription for
  // the whole cooldown.
  assert.equal(isHostBackpressure(new Error('too many concurrent plugin net.fetch calls (max 16); retry shortly')), true);
  assert.equal(isHostBackpressure(new Error('capability call rejected: too many concurrent capability calls (limit 32)')), true);
  assert.equal(isHostBackpressure(new Error('ECONNREFUSED 127.0.0.1:7000')), false);
  assert.equal(isHostBackpressure(new Error('STT 500 Internal Server Error')), false);

  let now = 0;
  const client = new OpenAiSttClient({
    baseUrl: 'http://localhost:7000',
    model: 'small',
    timeoutMs: 1000,
    net: { fetch: async () => { throw new Error('too many concurrent plugin net.fetch calls (max 16); retry shortly'); } } as never,
    now: () => now,
  } as never);

  for (let i = 0; i < 8; i++) {
    await assert.rejects(client.transcribe(new Uint8Array([1]), 'audio/ogg'));
  }
  assert.equal(client.isHealthy(), true, 'a saturated host must not be reported as a failing backend');
});

test('real backend failures still open the circuit breaker', async () => {
  // The guard rail for the test above: the breaker must still do its job.
  let now = 0;
  const client = new OpenAiSttClient({
    baseUrl: 'http://localhost:7000',
    model: 'small',
    timeoutMs: 1000,
    net: { fetch: async () => { throw new Error('ECONNREFUSED 127.0.0.1:7000'); } } as never,
    now: () => now,
  } as never);

  for (let i = 0; i < 8; i++) {
    await assert.rejects(client.transcribe(new Uint8Array([1]), 'audio/ogg'));
  }
  assert.equal(client.isHealthy(), false, 'a dead backend still opens the breaker');
});
