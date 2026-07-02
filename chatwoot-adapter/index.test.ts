import { test } from 'node:test';
import assert from 'node:assert/strict';
import ChatwootAdapter from './index.ts';
import type { PluginContext } from '../types/openwa';

function fakeCtx(config: Record<string, unknown>) {
  const hooks: string[] = [];
  const routes: string[] = [];
  const ctx = {
    config,
    storage: { get: async () => null, set: async () => {}, delete: async () => {}, list: async () => [] },
    mappings: { upsert: async () => {}, get: async () => null, getByProvider: async () => null },
    net: { fetch: async () => ({ ok: true, status: 200, headers: {}, body: '{}' }) },
    conversations: { send: async () => ({}) },
    handover: { set: async () => ({}) },
    logger: { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    registerHook: (event: string) => void hooks.push(event),
    registerWebhook: (route: string) => void routes.push(route),
  } as unknown as PluginContext;
  return { ctx, hooks, routes };
}

const goodConfig = { baseUrl: 'https://chat.acme.com', apiToken: 'tok', accountId: 3, inboxId: 7 };

test('onEnable registers the message:received hook and the chatwoot ingress route', async () => {
  const { ctx, hooks, routes } = fakeCtx(goodConfig);
  await new ChatwootAdapter().onEnable(ctx);
  assert.deepEqual(hooks, ['message:received']);
  assert.deepEqual(routes, ['chatwoot']);
});

test('onEnable throws on missing / invalid config', async () => {
  const { ctx } = fakeCtx({ baseUrl: 'https://x' }); // missing apiToken, accountId, inboxId
  await assert.rejects(new ChatwootAdapter().onEnable(ctx), /missing\/invalid config/);
});
