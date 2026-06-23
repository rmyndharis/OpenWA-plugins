import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginNetCapability, PluginNetResponse } from '../types/openwa';
import { LibreTranslateClient } from './libretranslate.client.ts';

function res(partial: { ok?: boolean; status?: number; json?: () => Promise<unknown> }): PluginNetResponse {
  return {
    ok: partial.ok ?? true,
    status: partial.status ?? 200,
    headers: {},
    text: async () => '',
    // PluginNetResponse.json is generic (<T>() => Promise<T>); a concrete fake needs the cast.
    json: (partial.json ?? (async () => ({}))) as PluginNetResponse['json'],
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

/** A programmable fake of ctx.net: each call shifts the next queued handler. */
function fakeNet(handlers: Array<(url: string) => Promise<PluginNetResponse>>) {
  const calls: string[] = [];
  const net: PluginNetCapability = {
    fetch: async (url: string) => {
      calls.push(url);
      const h = handlers.shift();
      if (!h) throw new Error('no more handlers');
      return h(url);
    },
  };
  return { net, calls };
}

test('translate posts and returns translatedText on success', async () => {
  const { net, calls } = fakeNet([async () => res({ json: async () => ({ translatedText: 'hola' }) })]);
  const c = new LibreTranslateClient({ url: 'http://lt:7001/', timeoutMs: 4000, net });
  assert.equal(await c.translate('hi', 'en', 'es'), 'hola');
  assert.equal(calls[0], 'http://lt:7001/translate'); // trailing slash trimmed
});

test('detect returns the top result', async () => {
  const { net } = fakeNet([async () => res({ json: async () => [{ language: 'en', confidence: 0.9 }] })]);
  const c = new LibreTranslateClient({ url: 'http://lt:7001', timeoutMs: 4000, net });
  assert.deepEqual(await c.detect('hello'), { lang: 'en', confidence: 0.9 });
});

test('a non-ok status throws with the HTTP status', async () => {
  const { net } = fakeNet([async () => res({ ok: false, status: 502 })]);
  const c = new LibreTranslateClient({ url: 'http://lt:7001', timeoutMs: 4000, net });
  await assert.rejects(c.translate('hi', 'en', 'es'), /HTTP 502/);
});

test('opens the circuit after the failure threshold and short-circuits the next call', async () => {
  const fail = async () => { throw new Error('boom'); };
  const { net, calls } = fakeNet([fail, fail]);
  const c = new LibreTranslateClient({ url: 'http://lt:7001', timeoutMs: 4000, net, failureThreshold: 2 });
  await assert.rejects(c.translate('a', 'en', 'es'), /boom/);
  await assert.rejects(c.translate('b', 'en', 'es'), /boom/);
  assert.equal(c.isHealthy(), false);
  // circuit now open → next call throws WITHOUT hitting the network
  await assert.rejects(c.translate('c', 'en', 'es'), /circuit open/);
  assert.equal(calls.length, 2); // the 3rd call never reached fetch
});

test('a success resets the consecutive-failure counter', async () => {
  const fail = async () => { throw new Error('boom'); };
  const ok = async () => res({ json: async () => ({ translatedText: 'x' }) });
  const { net } = fakeNet([fail, ok]);
  const c = new LibreTranslateClient({ url: 'http://lt:7001', timeoutMs: 4000, net, failureThreshold: 3 });
  await assert.rejects(c.translate('a', 'en', 'es'));
  await c.translate('b', 'en', 'es');
  assert.equal(c.isHealthy(), true);
});
