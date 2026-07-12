import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginContext, PluginManifest, WebhookRequest } from '../types/openwa';
import SupabaseSmsHook from './index.ts';

const TS = 1_700_000_000;

test('onEnable reads config, registers the send-sms webhook, and delivers the OTP', async () => {
  const registered: Array<{ route: string; handler: (req: WebhookRequest) => unknown }> = [];
  const sent: Array<{ sessionId: string; chatId: string; text: string }> = [];
  const logs: string[] = [];

  const rawBody = JSON.stringify({ user: { phone: '+15551234567' }, sms: { otp: '654321' } });

  const manifest: PluginManifest = {
    id: 'supabase-otp-hook',
    name: 'Supabase Auth OTP',
    version: '0.1.0',
    type: 'extension',
    main: 'dist/index.js',
  };

  const ctx = {
    pluginId: 'supabase-otp-hook',
    manifest,
    // The Standard Webhooks secret is NOT plugin config — it is `instance.secret`, which the host uses
    // to verify the signature before this handler runs. Here the handler only needs appName + fallback.
    config: { appName: 'Acme', fallbackSessionId: 'fallback-sess' },
    hookManager: {},
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
  const manifest: PluginManifest = {
    id: 'supabase-otp-hook',
    name: 'Supabase Auth OTP',
    version: '0.1.0',
    type: 'extension',
    main: 'dist/index.js',
  };
  const ctx = {
    pluginId: 'supabase-otp-hook',
    manifest,
    config: {}, // missing appName
    hookManager: {},
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
