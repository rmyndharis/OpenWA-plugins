import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { PluginNetCapability, PluginNetRequestInit, PluginNetResponse } from '../types/openwa';
import { WebhookDelivery, TranscriptionPayload } from './webhook.delivery.ts';

function res(partial: { ok?: boolean; status?: number }): PluginNetResponse {
  return {
    ok: partial.ok ?? true,
    status: partial.status ?? 200,
    statusText: '',
    headers: {},
    body: '',
    text: async () => '',
    json: (async () => ({})) as PluginNetResponse['json'],
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

const payload: TranscriptionPayload = {
  event: 'message.transcription',
  sessionId: 's1',
  messageId: 'm1',
  chatId: 'c1@s.whatsapp.net',
  status: 'completed',
  source: 'speech-to-text',
  untrusted: true,
  transcription: { text: 'hola mundo', language: 'es', provider: 'faster-whisper', model: 'small' },
};

test('POSTs the payload as JSON to the configured url', async () => {
  const { net, calls } = fakeNet(res({}));
  await new WebhookDelivery({ url: 'http://hook.local/in', timeoutMs: 5000, net }).deliver(payload);
  assert.equal(calls[0].url, 'http://hook.local/in');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers!['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body as string), payload);
});

test('signs the body with HMAC-SHA256 in X-OpenWA-Signature when a secret is configured', async () => {
  const { net, calls } = fakeNet(res({}));
  await new WebhookDelivery({ url: 'http://hook.local/in', secret: 'shh', timeoutMs: 5000, net }).deliver(payload);
  const sentBody = calls[0].init.body as string;
  const expected = `sha256=${createHmac('sha256', 'shh').update(sentBody).digest('hex')}`;
  assert.equal(calls[0].init.headers!['X-OpenWA-Signature'], expected);
  assert.equal(calls[0].init.headers!['authorization'], undefined); // bearer replaced by the signature
});

test('omits the signature header when no secret is configured', async () => {
  const { net, calls } = fakeNet(res({}));
  await new WebhookDelivery({ url: 'http://hook.local/in', timeoutMs: 5000, net }).deliver(payload);
  assert.equal(calls[0].init.headers!['X-OpenWA-Signature'], undefined);
});

test('throws on a non-ok status so the caller can log the miss', async () => {
  const { net } = fakeNet(res({ ok: false, status: 502 }));
  await assert.rejects(
    new WebhookDelivery({ url: 'http://hook.local/in', timeoutMs: 5000, net }).deliver(payload),
    /502/,
  );
});
