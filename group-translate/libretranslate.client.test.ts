import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginNetCapability, PluginNetResponse } from '../types/openwa';
import { LibreTranslateClient } from './libretranslate.client.ts';

function res(partial: { ok?: boolean; status?: number; body?: unknown }): PluginNetResponse {
  return {
    ok: partial.ok ?? true,
    status: partial.status ?? 200,
    statusText: '',
    headers: {},
    // The sandbox runtime returns the response body as a string and provides NO .json() (functions
    // can't cross the worker structuredClone boundary). The client must JSON.parse(res.body).
    body: partial.body === undefined ? '{}' : JSON.stringify(partial.body),
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
  const { net, calls } = fakeNet([async () => res({ body: { translatedText: 'hola' } })]);
  const c = new LibreTranslateClient({ url: 'http://lt:7001/', timeoutMs: 4000, net });
  assert.equal(await c.translate('hi', 'en', 'es'), 'hola');
  assert.equal(calls[0], 'http://lt:7001/translate'); // trailing slash trimmed
});

test('translate throws when the response lacks a translatedText string', async () => {
  const { net } = fakeNet([async () => res({ body: {} })]); // partial/empty body
  const c = new LibreTranslateClient({ url: 'http://lt:7001', timeoutMs: 4000, net });
  await assert.rejects(c.translate('hi', 'en', 'es'), /translatedText/);
});

test('detect returns the top result', async () => {
  const { net } = fakeNet([async () => res({ body: [{ language: 'en', confidence: 0.9 }] })]);
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
  const ok = async () => res({ body: { translatedText: 'x' } });
  const { net } = fakeNet([fail, ok]);
  const c = new LibreTranslateClient({ url: 'http://lt:7001', timeoutMs: 4000, net, failureThreshold: 3 });
  await assert.rejects(c.translate('a', 'en', 'es'));
  await c.translate('b', 'en', 'es');
  assert.equal(c.isHealthy(), true);
});

test('a host fetch refusal is rethrown without the URL credentials it quotes', async () => {
  // The host names the full request URL when it refuses a fetch, and a credentialed
  // `libretranslateUrl` is dropped from the config-derived allowlist, so that refusal fires on EVERY
  // message. The coordinator logs the rejection reason verbatim, so an unredacted rethrow wrote the
  // operator's password into the host log once per message.
  const { net } = fakeNet([
    async () => {
      throw new Error(
        'Plugin group-translate may not fetch https://admin:s3cr3t@lt.example.com/translate ' +
          '- add its host to net.allow or net.allowConfigHosts',
      );
    },
  ]);
  const client = new LibreTranslateClient({ url: 'https://admin:s3cr3t@lt.example.com', timeoutMs: 1000, net });
  const err = await client.translate('hi', 'en', 'es').then(
    () => null,
    (e: unknown) => e as Error,
  );
  assert.ok(err, 'the call must still fail');
  assert.ok(!/s3cr3t/.test(err.message), `password leaked: ${err.message}`);
  assert.ok(!/admin:/.test(err.message), `userinfo leaked: ${err.message}`);
  // Still diagnosable: the host, the reason and the remedy survive.
  assert.match(err.message, /lt\.example\.com/);
  assert.match(err.message, /net\.allow/);
});

test('a password containing @ is redacted whole, not just up to its first @', async () => {
  // `@` in a password is common and legal. Stopping the match at the first one republished the tail:
  // `admin:p@ssw0rd@host` came out as `***:***@ssw0rd@host`, still carrying most of the secret.
  const { net } = fakeNet([
    async () => {
      throw new Error('Plugin group-translate may not fetch https://admin:p@ssw0rd@lt.example.com/translate - add its host');
    },
  ]);
  const client = new LibreTranslateClient({ url: 'https://admin:p@ssw0rd@lt.example.com', timeoutMs: 1000, net });
  const err = (await client.translate('hi', 'en', 'es').then(() => null, (e: unknown) => e as Error))!;
  assert.ok(!/ssw0rd/.test(err.message), `password tail leaked: ${err.message}`);
  assert.match(err.message, /\/\/\*\*\*:\*\*\*@lt\.example\.com/);
});
