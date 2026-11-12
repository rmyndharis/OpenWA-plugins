import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RocketClient } from './client.ts';
import { readConfig } from './config.ts';
const config = readConfig({ baseUrl: 'https://rocket.example', sessionId: 's1' });

test('request errors cannot expose a visitor token or provider response body', async () => {
  const client = new RocketClient(
    async () => ({ ok: false, status: 400, statusText: 'bad', headers: {}, body: 'secret-token' }),
    config,
  );
  await assert.rejects(client.room('secret-token'), (error) => {
    assert.equal((error as Error).message, 'Rocket.Chat request failed (HTTP 400)');
    return true;
  });
});

test('uses serialized capability responses and validates successful provider bodies', async () => {
  for (const body of ['not JSON', 'null', '[]', '{"success":false}']) {
    const client = new RocketClient(
      async () => ({ ok: true, status: 200, statusText: 'OK', headers: {}, body }),
      config,
    );
    await assert.rejects(client.visitor('token', 'name'));
  }
});

test('visitor registration includes an explicitly supplied phone', async () => {
  let payload = '';
  const client = new RocketClient(async (_url, init) => {
    payload = String(init?.body);
    return { ok: true, status: 200, statusText: 'OK', headers: {}, body: '{"success":true}' };
  }, config);
  await client.visitor('token', 'Visitor', '+15550001111');
  assert.equal(JSON.parse(payload).visitor.phone, '+15550001111');
});
