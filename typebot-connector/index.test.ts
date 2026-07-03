import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginContext, HookHandler, HookContext } from '../types/openwa';
import Plugin, { readConfig } from './index.ts';

test('readConfig: defaults, normalization, and fail-fast', () => {
  const c = readConfig({ publicId: 'bot' });
  assert.equal(c.apiHost, 'https://typebot.io');
  assert.equal(c.respondInGroups, true);
  assert.equal(c.sessionTimeoutMinutes, 30);
  assert.equal(readConfig({ publicId: 'bot', apiHost: 'https://my.host/' }).apiHost, 'https://my.host');
  assert.throws(() => readConfig({}), /publicId/);
  assert.throws(() => readConfig({ publicId: 'b', apiHost: 'http://x' }), /https/);
  assert.throws(() => readConfig({ publicId: 'b', apiHost: 'https://u:p@x' }), /credentials/);
});

test('onEnable registers a message:received hook that returns {continue:true}', async () => {
  let registered: { event: string; handler: HookHandler } | undefined;
  const ctx = {
    config: { publicId: 'bot' },
    logger: { log() {}, debug() {}, warn() {}, error() {} },
    storage: { get: async () => null, set: async () => {}, delete: async () => {}, list: async () => [] },
    net: { fetch: async () => ({ ok: true, status: 200, headers: {}, body: '{}' }) },
    conversations: { send: async () => {} },
    registerHook: (event: string, handler: HookHandler) => void (registered = { event, handler }),
  } as unknown as PluginContext;

  await new Plugin().onEnable(ctx);
  assert.equal(registered?.event, 'message:received');
  const result = await registered!.handler({ event: 'message:received', data: undefined, timestamp: new Date(), source: 'Engine' });
  assert.deepEqual(result, { continue: true });
});

test('message:received hook returns {continue:true} without awaiting a hanging Typebot turn', async () => {
  let registered: { event: string; handler: HookHandler } | undefined;
  const ctx = {
    config: { publicId: 'bot' },
    logger: { log() {}, debug() {}, warn() {}, error() {} },
    storage: { get: async () => null, set: async () => {}, delete: async () => {}, list: async () => [] },
    net: { fetch: () => new Promise(() => {}) },
    conversations: { send: async () => {} },
    registerHook: (event: string, handler: HookHandler) => void (registered = { event, handler }),
  } as unknown as PluginContext;

  await new Plugin().onEnable(ctx);
  const populated = {
    event: 'message:received',
    sessionId: 'sess',
    source: 'Engine',
    timestamp: new Date(),
    data: {
      id: 'm', from: 'x', to: 'y', chatId: 'c@c.us', body: 'hi', type: 'chat',
      timestamp: 0, fromMe: false, isGroup: false,
    },
  } as unknown as HookContext;
  assert.deepEqual(await registered!.handler(populated), { continue: true });
});
