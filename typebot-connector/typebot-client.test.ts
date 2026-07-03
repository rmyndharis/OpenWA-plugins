import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginNetRequestInit, PluginNetResponse } from '../types/openwa';
import type { TypebotConfig } from './typebot-types.ts';
import { TypebotClient, TypebotHttpError } from './typebot-client.ts';

const cfg: TypebotConfig = { apiHost: 'https://typebot.io', publicId: 'my-bot', respondInGroups: true, sessionTimeoutMinutes: 30, passContactVariables: true };
const ok = (body: unknown): PluginNetResponse => ({ ok: true, status: 200, headers: {}, body: JSON.stringify(body) } as PluginNetResponse);

function recorder(responses: PluginNetResponse[]) {
  const calls: { url: string; init?: PluginNetRequestInit }[] = [];
  let i = 0;
  const fetchFn = async (url: string, init?: PluginNetRequestInit) => {
    calls.push({ url, init });
    return responses[i++];
  };
  return { fetchFn, calls };
}

test('startChat: correct path/body, normalizes a text bubble + choice input', async () => {
  const raw = {
    sessionId: 'SESS',
    messages: [{ id: 'm1', type: 'text', content: { type: 'markdown', markdown: 'Hi' } }],
    input: { id: 'blk', type: 'choice input', items: [{ id: 'i1', content: 'A' }], options: { isMultipleChoice: false } },
  };
  const { fetchFn, calls } = recorder([ok(raw)]);
  const client = new TypebotClient(fetchFn, cfg);
  const resp = await client.startChat({ prefilledVariables: { waName: 'Al' } });

  assert.equal(calls[0].url, 'https://typebot.io/api/v1/typebots/my-bot/startChat');
  const body = JSON.parse(calls[0].init!.body as string);
  assert.equal(body.isStreamEnabled, false);
  assert.equal(body.textBubbleContentFormat, 'markdown');
  assert.deepEqual(body.prefilledVariables, { waName: 'Al' });
  assert.equal(resp.sessionId, 'SESS');
  assert.deepEqual(resp.bubbles, [{ kind: 'text', markdown: 'Hi' }]);
  assert.deepEqual(resp.input, { kind: 'choice', blockId: 'blk', items: [{ id: 'i1', content: 'A' }], multiple: false });
});

test('continueChat: sessionId in the PATH; flow-end when input absent', async () => {
  const { fetchFn, calls } = recorder([ok({ messages: [{ id: 'm', type: 'text', content: { type: 'markdown', markdown: 'Bye' } }] })]);
  const client = new TypebotClient(fetchFn, cfg);
  const resp = await client.continueChat('SESS', 'hello');
  assert.equal(calls[0].url, 'https://typebot.io/api/v1/sessions/SESS/continueChat');
  assert.equal(JSON.parse(calls[0].init!.body as string).message, 'hello');
  assert.equal(resp.input, undefined); // flow ended
});

test('non-ok response throws TypebotHttpError with the status', async () => {
  const { fetchFn } = recorder([{ ok: false, status: 404, headers: {}, body: '{"message":"not found"}' } as PluginNetResponse]);
  const client = new TypebotClient(fetchFn, cfg);
  await assert.rejects(client.continueChat('S', 'x'), (e: unknown) => e instanceof TypebotHttpError && e.status === 404);
});

test('uploadFile: empty formData → PUT raw bytes, returns fileUrl', async () => {
  const { fetchFn, calls } = recorder([
    ok({ presignedUrl: 'https://typebot.io/api/uploads/tok', formData: {}, fileUrl: 'https://cdn/x.png' }),
    { ok: true, status: 200, headers: {}, body: '' } as PluginNetResponse,
  ]);
  const client = new TypebotClient(fetchFn, cfg);
  const url = await client.uploadFile('SESS', 'blk', { mime: 'image/png', filename: 'p.png', data: Buffer.from([1, 2, 3]).toString('base64') });
  assert.equal(url, 'https://cdn/x.png');
  assert.equal(calls[0].url, 'https://typebot.io/api/v3/generate-upload-url');
  assert.equal(calls[1].url, 'https://typebot.io/api/uploads/tok');
  assert.equal(calls[1].init!.method, 'PUT');
  assert.ok(calls[1].init!.body instanceof Uint8Array);
});

test('uploadFile: non-empty formData → multipart POST', async () => {
  const { fetchFn, calls } = recorder([
    ok({ presignedUrl: 'https://s3.example/bucket', formData: { key: 'abc', policy: 'p' }, fileUrl: 'https://cdn/y.png' }),
    { ok: true, status: 204, headers: {}, body: '' } as PluginNetResponse,
  ]);
  const client = new TypebotClient(fetchFn, cfg);
  const url = await client.uploadFile('SESS', 'blk', { mime: 'image/png', filename: 'p.png', data: Buffer.from([1]).toString('base64') });
  assert.equal(url, 'https://cdn/y.png');
  assert.equal(calls[1].init!.method, 'POST');
  assert.match(calls[1].init!.headers!['Content-Type'], /^multipart\/form-data; boundary=/);
});
