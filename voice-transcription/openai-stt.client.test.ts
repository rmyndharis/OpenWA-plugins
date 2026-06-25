import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginNetCapability, PluginNetRequestInit, PluginNetResponse } from '../types/openwa';
import { OpenAiSttClient } from './openai-stt.client.ts';

function res(partial: { ok?: boolean; status?: number; body?: string }): PluginNetResponse {
  return {
    ok: partial.ok ?? true,
    status: partial.status ?? 200,
    statusText: '',
    headers: {},
    body: partial.body ?? '{}',
    text: async () => partial.body ?? '{}',
    json: (async () => JSON.parse(partial.body ?? '{}')) as PluginNetResponse['json'],
    arrayBuffer: async () => new ArrayBuffer(0),
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
