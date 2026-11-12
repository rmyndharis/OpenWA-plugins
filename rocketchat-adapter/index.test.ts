import { test } from 'node:test';
import assert from 'node:assert/strict';
import Adapter, { HOOK_PRIORITY } from './index.ts';
import type { PluginContext, HookHandler, WebhookHandler } from '../types/openwa';

function harness() {
  const hooks = new Map<string, HookHandler>();
  const routes = new Map<string, WebhookHandler>();
  const data = new Map<string, unknown>();
  const priorities: number[] = [];
  let requests = 0;
  let storageWrites = 0;
  const ctx = {
    config: { baseUrl: 'https://rocket.example', sessionId: 'session-a' },
    storage: {
      get: async (key: string) => structuredClone(data.get(key) ?? null),
      set: async (key: string, value: unknown) => {
        storageWrites++;
        data.set(key, structuredClone(value));
      },
    },
    logger: { error: () => {} },
    net: {
      fetch: async () => {
        requests++;
        // Deliberately unresolved networking must never keep the hook from returning.
        return new Promise(() => {});
      },
    },
    registerHook: (name: string, callback: HookHandler, priority: number) => {
      hooks.set(name, callback);
      priorities.push(priority);
    },
    registerWebhook: (name: string, callback: WebhookHandler) => {
      routes.set(name, callback);
    },
  } as unknown as PluginContext;
  const fire = (over: Record<string, unknown> = {}) =>
    hooks.get('message:received')!({
      event: 'message:received',
      source: 'Engine',
      sessionId: 'session-a',
      timestamp: new Date(),
      data: { id: 'wa1', chatId: '15550001111@c.us', fromMe: false, isGroup: false, type: 'text', body: 'hello' },
      ...over,
    });
  return { ctx, hooks, routes, fire, priorities, requests: () => requests, writes: () => storageWrites };
}

test('enable registers an observer and verified ingress without network or engine calls', async () => {
  const h = harness();
  const plugin = new Adapter();
  await plugin.onEnable(h.ctx);
  try {
    assert.deepEqual([...h.hooks.keys()], ['message:received']);
    assert.deepEqual([...h.routes.keys()], ['omnichannel']);
    assert.deepEqual(h.priorities, [HOOK_PRIORITY]);
    assert.equal(h.requests(), 0);
  } finally {
    await plugin.onDisable();
  }
});

test('the inbound hook returns before a slow provider and does not claim the message', async () => {
  const h = harness();
  const plugin = new Adapter();
  await plugin.onEnable(h.ctx);
  try {
    const result = await h.fire();
    assert.equal(result.continue, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.requests(), 1);
  } finally {
    await plugin.onDisable();
  }
});

test('the hook resolves the current session config rather than retaining the enable snapshot', async () => {
  const h = harness();
  const plugin = new Adapter();
  await plugin.onEnable(h.ctx);
  try {
    h.ctx.config = { baseUrl: 'https://other.example', sessionId: 'session-b' };
    await h.fire();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.writes(), 0, 'session-a is outside the new resolved binding');
    await h.fire({ sessionId: 'session-b' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.requests(), 1);
  } finally {
    await plugin.onDisable();
  }
});

test('disable marks health inactive and retires queued work', async () => {
  const h = harness();
  const plugin = new Adapter();
  await plugin.onEnable(h.ctx);
  await plugin.onDisable();
  assert.equal((await plugin.healthCheck()).healthy, false);
  await h.fire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.requests(), 0);
});

test('invalid config changes retire existing jobs and cannot report healthy', async () => {
  const h = harness();
  const plugin = new Adapter();
  await plugin.onEnable(h.ctx);
  try {
    h.ctx.config = { sessionId: 'session-a' };
    await assert.rejects(plugin.onConfigChange(h.ctx));
    assert.equal((await plugin.healthCheck()).healthy, false);
  } finally {
    await plugin.onDisable();
  }
});

test('a widget room webhook is ignored without degrading plugin health', async () => {
  const h = harness();
  const plugin = new Adapter();
  await plugin.onEnable(h.ctx);
  try {
    await h.routes.get('omnichannel')!({
      verified: true,
      sessionId: 'session-a',
      instanceId: 'support',
      method: 'POST',
      headers: {},
      query: {},
      deliveryId: 'widget',
      rawBody: '',
      body: JSON.stringify({
        type: 'Message',
        _id: 'widget-room',
        visitor: { token: 'widget-token' },
        messages: [{ _id: 'reply', agentId: 'agent', msg: 'widget reply' }],
      }),
    });
    assert.equal((await plugin.healthCheck()).healthy, true);
    assert.equal(h.writes(), 0);
  } finally {
    await plugin.onDisable();
  }
});

test('in-flight work from a retired config generation does not degrade replacement health', async () => {
  const h = harness();
  let releaseFetch!: () => void;
  const heldFetch = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  h.ctx.net.fetch = async () => {
    await heldFetch;
    return { ok: true, status: 200, statusText: 'OK', headers: {}, body: '{"success":true}' };
  };
  const plugin = new Adapter();
  await plugin.onEnable(h.ctx);
  try {
    await h.fire();
    await new Promise((resolve) => setImmediate(resolve));
    h.ctx.config = { baseUrl: 'https://other.example', sessionId: 'session-b' };
    await plugin.onConfigChange(h.ctx);
    releaseFetch();
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await plugin.healthCheck()).healthy, true);
  } finally {
    await plugin.onDisable();
  }
});

test('a slow successful WhatsApp send does not trip a premature worker deadline or degrade health', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.ctx.net.fetch = async (url) => {
    const body = new URL(url).pathname.endsWith('/room')
      ? '{"success":true,"room":{"_id":"room-1"}}'
      : '{"success":true}';
    return { ok: true, status: 200, statusText: 'OK', headers: {}, body };
  };
  let sent = 0;
  h.ctx.conversations = {
    send: () =>
      new Promise((resolve) => {
        setTimeout(() => {
          sent++;
          resolve({ messageId: 'out-1' });
        }, 4500);
      }),
  } as unknown as PluginContext['conversations'];
  const { stateKey, readConfig } = await import('./config.ts');
  const key = stateKey(readConfig(h.ctx.config));
  const plugin = new Adapter();
  await plugin.onEnable(h.ctx);
  try {
    await h.fire();
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
    const state = (await h.ctx.storage.get(key)) as { links: Array<{ token: string; roomId?: string }> };
    assert.equal(state.links[0]?.roomId, 'room-1');
    let sendStarted!: () => void;
    const reachedSend = new Promise<void>((resolve) => {
      sendStarted = resolve;
    });
    h.ctx.conversations = {
      send: () => {
        sendStarted();
        return new Promise((resolve) => {
          setTimeout(() => {
            sent++;
            resolve({ messageId: 'out-1' });
          }, 4500);
        });
      },
    } as unknown as PluginContext['conversations'];
    const webhookPromise = Promise.resolve(
      h.routes.get('omnichannel')!({
        verified: true,
        sessionId: 'session-a',
        instanceId: 'support',
        method: 'POST',
        headers: {},
        query: {},
        deliveryId: 'slow-send',
        rawBody: '',
        body: JSON.stringify({
          type: 'Message',
          _id: 'room-1',
          visitor: { token: state.links[0].token },
          messages: [{ _id: 'reply-slow', agentId: 'agent-1', msg: 'hello back' }],
        }),
      }),
    );
    await reachedSend;
    t.mock.timers.tick(4500);
    await assert.doesNotReject(webhookPromise);
    assert.equal(sent, 1);
    assert.equal((await plugin.healthCheck()).healthy, true);

    h.ctx.conversations = {
      send: async () => {
        throw new Error('WhatsApp offline');
      },
    } as unknown as PluginContext['conversations'];
    await assert.rejects(
      Promise.resolve(
        h.routes.get('omnichannel')!({
          verified: true,
          sessionId: 'session-a',
          instanceId: 'support',
          method: 'POST',
          headers: {},
          query: {},
          deliveryId: 'failed-send',
          rawBody: '',
          body: JSON.stringify({
            type: 'Message',
            _id: 'room-1',
            visitor: { token: state.links[0].token },
            messages: [{ _id: 'reply-fail', agentId: 'agent-1', msg: 'retry me' }],
          }),
        }),
      ),
      /ingress may retry/,
    );
    assert.equal((await plugin.healthCheck()).healthy, false);
  } finally {
    await plugin.onDisable();
  }
});
