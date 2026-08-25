import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginContext, WebhookRequest } from '../types/openwa';
import SupabaseSmsHook from './index.ts';

const TS = 1_700_000_000;

test('onEnable reads config, registers the send-sms webhook, and delivers the OTP', async () => {
  const registered: Array<{ route: string; handler: (req: WebhookRequest) => unknown }> = [];
  const sent: Array<{ sessionId: string; chatId: string; text: string }> = [];
  const logs: string[] = [];

  const rawBody = JSON.stringify({ user: { phone: '+15551234567' }, sms: { otp: '654321' } });

  const ctx = {
    pluginId: 'supabase-otp-hook',
    // The Standard Webhooks secret is NOT plugin config — it is `instance.secret`, which the host uses
    // to verify the signature before this handler runs. Here the handler only needs appName + fallback.
    config: { appName: 'Acme', fallbackSessionId: 'fallback-sess' },
    logger: {
      log: (m: string) => { logs.push(m); },
      debug: () => {},
      warn: () => {},
      error: () => {},
    },
    storage: {} as PluginContext['storage'],
    registerHook: () => {},
    messages: {
      sendText: async (sessionId: string, chatId: string, text: string) => {
        sent.push({ sessionId, chatId, text });
        return { messageId: 'm1', timestamp: TS };
      },
      reply: async () => ({ messageId: 'm1', timestamp: TS }),
    },
    engine: {} as PluginContext['engine'],
    net: {} as PluginContext['net'],
    registerWebhook: (route: string, handler: (req: WebhookRequest) => unknown) => {
      registered.push({ route, handler });
    },
    conversations: {} as PluginContext['conversations'],
    handover: {} as PluginContext['handover'],
    mappings: {} as PluginContext['mappings'],
  } satisfies PluginContext;

  const plugin = new SupabaseSmsHook();
  await plugin.onEnable(ctx);

  assert.equal(registered.length, 1);
  assert.equal(registered[0].route, 'send-sms');
  assert.ok(logs.some(l => l.includes('supabase-otp-hook enabled')));

  const req: WebhookRequest = {
    instanceId: 'inst',
    sessionId: 'fallback-sess',
    method: 'POST',
    headers: {},
    query: {},
    body: rawBody,
    rawBody,
    verified: true,
    deliveryId: 'd1',
  };

  await registered[0].handler(req);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, 'fallback-sess');
  assert.equal(sent[0].chatId, '15551234567@c.us');
  assert.equal(sent[0].text, 'Acme | Your verification code is 654321');
});

test('onEnable throws when appName is missing', async () => {
  const ctx = {
    pluginId: 'supabase-otp-hook',
    config: {}, // missing appName
    logger: { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    storage: {} as PluginContext['storage'],
    registerHook: () => {},
    messages: { sendText: async () => ({ messageId: 'm1', timestamp: TS }), reply: async () => ({ messageId: 'm1', timestamp: TS }) },
    engine: {} as PluginContext['engine'],
    net: {} as PluginContext['net'],
    registerWebhook: () => {},
    conversations: {} as PluginContext['conversations'],
    handover: {} as PluginContext['handover'],
    mappings: {} as PluginContext['mappings'],
  } satisfies PluginContext;

  const plugin = new SupabaseSmsHook();
  await assert.rejects(plugin.onEnable(ctx), /appName is required/);
});

test('healthCheck reports a dropped OTP that reaches no retry and no dead-letter row', async () => {
  // A send that fails AFTER the handler's fail-fast window has closed reaches nobody else: Supabase was
  // already acked 200 and the ingress job completed, so there is no retry and no dead-letter row. The
  // host reports a plugin with no health check as healthy, so this was the only surface left.
  let handler: ((req: WebhookRequest) => unknown) | undefined;
  let sendFails = false;
  const ctx = {
    pluginId: 'supabase-otp-hook',
    config: { appName: 'Acme', fallbackSessionId: 'sess' },
    logger: { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    storage: {} as PluginContext['storage'],
    registerHook: () => {},
    messages: {
      sendText: async () => {
        if (sendFails) throw new Error('no active engine');
        return { messageId: 'm1', timestamp: TS };
      },
      reply: async () => ({ messageId: 'm1', timestamp: TS }),
    },
    engine: {} as PluginContext['engine'],
    net: {} as PluginContext['net'],
    conversations: {} as PluginContext['conversations'],
    registerWebhook: (_route: string, h: (req: WebhookRequest) => unknown) => { handler = h; },
  } as unknown as PluginContext;

  const plugin = new SupabaseSmsHook();
  await plugin.onEnable(ctx);
  assert.equal((await plugin.healthCheck()).healthy, true, 'healthy before anything has been sent');

  const req = {
    body: JSON.stringify({ user: { phone: '+15551234567' }, sms: { otp: '111111' } }),
    sessionId: 'sess',
  } as unknown as WebhookRequest;

  await handler!(req);
  assert.equal((await plugin.healthCheck()).healthy, true, 'a delivered OTP keeps it healthy');

  sendFails = true;
  await assert.rejects(Promise.resolve(handler!(req)), /WhatsApp send failed/);
  const bad = await plugin.healthCheck();
  assert.equal(bad.healthy, false, 'a failed send is surfaced');
  assert.match(bad.message ?? '', /no active engine/);

  // A later success clears it, so the tile does not stay red forever after one transient failure.
  sendFails = false;
  await handler!(req);
  assert.equal((await plugin.healthCheck()).healthy, true, 'a later success clears the last error');
});
