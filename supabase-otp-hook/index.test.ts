import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import type { PluginContext, PluginManifest, WebhookRequest } from '../types/openwa';
import SupabaseSmsHook from './index.ts';

const keyBytes = randomBytes(32);
const keyB64 = keyBytes.toString('base64');
const secret = `v1,whsec_${keyB64}`;
const TS = Math.floor(Date.now() / 1000);
const ID = 'msg-integration';

function sign(t: number, body: string): string {
  return 'v1,' + createHmac('sha256', keyBytes).update(`${ID}.${t}.${body}`).digest('base64');
}

test('onEnable reads config, registers the send-sms webhook, and handles a signed request', async () => {
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
    config: { webhookSecret: secret, appName: 'Acme', fallbackSessionId: 'fallback-sess' },
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
    engine: {
      getGroupInfo: async () => ({}),
      getContacts: async () => [],
      getContactById: async () => ({}),
      checkNumberExists: async () => true,
      getChats: async () => [],
      getChatHistory: async () => [],
      canonicalChatId: async (_s: string, chatId: string) => chatId,
    } as PluginContext['engine'],
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
    headers: {
      'webhook-id': ID,
      'webhook-timestamp': String(TS),
      'webhook-signature': sign(TS, rawBody),
    },
    query: {},
    body: rawBody,
    rawBody,
    verified: true,
    deliveryId: 'd1',
  };

  const r = await registered[0].handler(req);
  assert.equal((r as { status?: number }).status, 200);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, 'fallback-sess');
  assert.equal(sent[0].chatId, '15551234567@c.us');
  assert.equal(sent[0].text, 'Acme | Your verification code is 654321');
});

test('onEnable throws when the base config is invalid', async () => {
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
    config: { appName: 'Acme' }, // missing webhookSecret
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
  await assert.rejects(plugin.onEnable(ctx), /webhookSecret is required/);
});
