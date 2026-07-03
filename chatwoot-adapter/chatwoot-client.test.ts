import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatwootClient } from './chatwoot-client.ts';

function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: { method?: string; headers?: Record<string, string>; body?: unknown } }> = [];
  const fn = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array }) => {
    calls.push({ url, init });
    const r = routes[`${init?.method ?? 'GET'} ${new URL(url).pathname}`] ?? { body: {} };
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, body: JSON.stringify(r.body) };
  };
  return { fn, calls };
}
const cfg = { baseUrl: 'https://chat.acme.com', apiToken: 'tok', accountId: 3, inboxId: 7 };

test('searchContact matches on identifier (WA JID) and returns the inbox source_id', async () => {
  const { fn } = fakeFetch({
    'GET /api/v1/accounts/3/contacts/search': {
      body: {
        payload: [
          { id: 11, identifier: '621@c.us', contact_inboxes: [{ inbox: { id: 7 }, source_id: 'src-11' }] },
          { id: 12, identifier: 'other@c.us' },
        ],
      },
    },
  });
  const c = new ChatwootClient(fn, cfg);
  assert.deepEqual(await c.searchContact('621@c.us'), { id: 11, sourceId: 'src-11' });
  assert.equal(await c.searchContact('missing@c.us'), null);
});

test('createContact on 422 re-searches and returns the existing contact (find-existing)', async () => {
  const { fn } = fakeFetch({
    'POST /api/v1/accounts/3/contacts': { status: 422, body: { message: 'already exists' } },
    'GET /api/v1/accounts/3/contacts/search': {
      body: { payload: [{ id: 11, identifier: '621@c.us', contact_inboxes: [{ inbox: { id: 7 }, source_id: 'src-11' }] }] },
    },
  });
  const c = new ChatwootClient(fn, cfg);
  assert.deepEqual(await c.createContact('621@c.us', 'Budi'), { id: 11, sourceId: 'src-11' });
});

test('postText posts an incoming message with the api token header', async () => {
  const { fn, calls } = fakeFetch({ 'POST /api/v1/accounts/3/conversations/55/messages': { body: { id: 999 } } });
  const res = await new ChatwootClient(fn, cfg).postText(55, 'hello');
  assert.equal(res.id, 999);
  const last = calls.at(-1)!;
  assert.deepEqual(JSON.parse(last.init!.body as string), { content: 'hello', message_type: 'incoming', private: false });
  assert.equal(last.init!.headers!['api_access_token'], 'tok');
});

test('updateContact PUTs the new name to the contact', async () => {
  const { fn, calls } = fakeFetch({ 'PUT /api/v1/accounts/3/contacts/9': { body: { id: 9 } } });
  await new ChatwootClient(fn, cfg).updateContact(9, 'Budi');
  const last = calls.at(-1)!;
  assert.equal(last.init!.method, 'PUT');
  assert.deepEqual(JSON.parse(last.init!.body as string), { name: 'Budi' });
});

test('postText forwards source_id and the in_reply_to_external_id thread pointer when given', async () => {
  const { fn, calls } = fakeFetch({ 'POST /api/v1/accounts/3/conversations/55/messages': { body: { id: 1 } } });
  await new ChatwootClient(fn, cfg).postText(55, '..', { sourceId: 'wa1', inReplyToExternalId: 'wa0' });
  const body = JSON.parse(calls.at(-1)!.init!.body as string);
  assert.equal(body.source_id, 'wa1');
  assert.deepEqual(body.content_attributes, { in_reply_to_external_id: 'wa0' });
});

test('postMedia marks a voice note and threads it (is_voice_message + source_id in the multipart body)', async () => {
  const { fn, calls } = fakeFetch({ 'POST /api/v1/accounts/3/conversations/55/messages': { body: { id: 2 } } });
  await new ChatwootClient(fn, cfg).postMedia(
    55,
    '',
    { filename: 'voice.ogg', contentType: 'audio/ogg', data: new Uint8Array([1, 2, 3]) },
    { sourceId: 'wa5', isVoiceMessage: true },
  );
  const raw = Buffer.from(calls.at(-1)!.init!.body as Uint8Array).toString('latin1');
  assert.match(raw, /name="is_voice_message"\r\n\r\ntrue/);
  assert.match(raw, /name="source_id"\r\n\r\nwa5/);
  assert.match(raw, /filename="voice.ogg"/);
});
