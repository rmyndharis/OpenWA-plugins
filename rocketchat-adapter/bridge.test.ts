import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, PluginContext, WebhookRequest, ConversationSendEnvelope } from '../types/openwa';
import { Bridge, MAX_ATTEMPTS, MAX_CHATS, MAX_DEAD, DEAD_RETENTION_MS } from './bridge.ts';
import { readConfig, stateKey } from './config.ts';

const config = readConfig({ baseUrl: 'https://rocket.example', sessionId: 'session-a' });
const message = (id = 'wa-1'): IncomingMessage => ({
  id,
  chatId: '15550001111@c.us',
  from: '15550001111@c.us',
  to: 'me',
  body: 'hello',
  type: 'text',
  fromMe: false,
  isGroup: false,
  timestamp: 1,
});

function harness() {
  const rows = new Map<string, unknown>();
  const delivered = new Map<string, { _id: string; rid: string; msg: string }>();
  const posts: unknown[] = [];
  const sends: ConversationSendEnvelope[] = [];
  const requests: string[] = [];
  let time = 1;
  let offline = false;
  let ambiguous = false;
  let failCompletion = false;
  let sendError = false;
  const ctx = {
    logger: { warn: () => {}, log: () => {} },
    storage: {
      get: async (key: string) => structuredClone(rows.get(key) ?? null),
      set: async (key: string, value: unknown) => {
        const state = value as { inboundSeen: string[] };
        if (failCompletion && state.inboundSeen.length) {
          failCompletion = false;
          throw new Error('storage full');
        }
        rows.set(key, structuredClone(value));
      },
    },
    conversations: {
      send: async (env: ConversationSendEnvelope) => {
        if (sendError) throw new Error('engine offline');
        sends.push(env);
        return { messageId: 'sent' };
      },
    },
    net: {
      fetch: async (url: string, init?: { body?: string }) => {
        requests.push(url);
        if (offline) throw new Error('provider offline');
        const path = new URL(url).pathname;
        const data = init?.body ? JSON.parse(init.body) : undefined;
        let result: unknown = { success: true };
        if (path.endsWith('/room')) result = { success: true, room: { _id: 'room-1' } };
        if (path.includes('/messages.history/')) result = { success: true, messages: [...delivered.values()] };
        if (path.endsWith('/message')) {
          posts.push(data);
          delivered.set(data._id, data);
          if (ambiguous) {
            ambiguous = false;
            throw new Error('response timed out after delivery');
          }
        }
        return { ok: true, status: 200, statusText: 'OK', headers: {}, body: JSON.stringify(result) };
      },
    },
  } as unknown as PluginContext;
  const make = (cfg = config, guard = () => {}) => new Bridge(ctx, cfg, guard, () => time);
  const state = () =>
    structuredClone(rows.get(stateKey(config))) as {
      links: Array<{ chatId: string; token: string; roomId?: string }>;
      pending: unknown[];
      dead: unknown[];
      inboundSeen: string[];
    };
  const req = (over: Partial<WebhookRequest> = {}): WebhookRequest => ({
    verified: true,
    sessionId: config.sessionId,
    instanceId: 'main',
    method: 'POST',
    headers: {},
    query: {},
    body: JSON.stringify({
      type: 'Message',
      _id: 'room-1',
      visitor: { token: state().links[0].token },
      messages: [{ _id: 'reply-1', msg: 'agent answer', agentId: 'agent-1' }],
    }),
    rawBody: '',
    deliveryId: 'delivery-1',
    ...over,
  });
  return {
    ctx,
    make,
    state,
    req,
    rows,
    posts,
    sends,
    requests,
    tick: () => {
      time += 100_000;
    },
    offline: (value: boolean) => {
      offline = value;
    },
    ambiguous: () => {
      ambiguous = true;
    },
    failCompletion: () => {
      failCompletion = true;
    },
    sendError: (value: boolean) => {
      sendError = value;
    },
  };
}

async function seeded() {
  const h = harness();
  const bridge = h.make();
  await bridge.enqueue(message());
  await bridge.pump();
  return { ...h, bridge };
}

test('persists work and visitor credentials before networking; dedups repeated hooks', async () => {
  const h = harness();
  const bridge = h.make();
  await Promise.all([bridge.enqueue(message()), bridge.enqueue(message())]);
  assert.equal(h.requests.length, 0);
  assert.equal(h.state().pending.length, 1);
  assert.match(h.state().links[0].token, /^[0-9a-f]{64}$/);
  await bridge.pump();
  assert.equal(h.posts.length, 1);
  assert.equal(h.state().pending.length, 0);
  await bridge.enqueue(message());
  await bridge.pump();
  assert.equal(h.posts.length, 1);
});

test('recovers pending work and visitor mapping in a new bridge after restart', async () => {
  const h = harness();
  await h.make().enqueue(message());
  const token = h.state().links[0].token;
  await h.make().pump();
  assert.equal(h.posts.length, 1);
  assert.equal(h.state().links[0].token, token);
});

test('reconciles an ambiguous successful HTTP send before reposting', async () => {
  const h = harness();
  const bridge = h.make();
  h.ambiguous();
  await bridge.enqueue(message());
  await assert.rejects(bridge.pump(), /retained/);
  h.tick();
  await h.make().pump();
  assert.equal(h.posts.length, 1);
  assert.equal(h.state().pending.length, 0);
});

test('a failed completion write cannot erase the durable pending message', async () => {
  const h = harness();
  const bridge = h.make();
  h.failCompletion();
  await bridge.enqueue(message());
  await assert.rejects(bridge.pump(), /retained/);
  assert.equal(h.state().pending.length, 1);
  h.tick();
  await h.make().pump();
  assert.equal(h.posts.length, 1);
  assert.equal(h.state().pending.length, 0);
});

test('retains exhausted retries as dead letters and reports them', async () => {
  const h = harness();
  const bridge = h.make();
  h.offline(true);
  await bridge.enqueue(message());
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await assert.rejects(bridge.pump());
    h.tick();
  }
  assert.deepEqual(await bridge.status(), { pending: 0, dead: 1 });
  await bridge.enqueue(message());
  assert.equal(h.state().pending.length, 0, 'duplicate hook must not rearm an exhausted message');
});

test('FIFO queue does not deliver a later message ahead of a failed one', async () => {
  const h = harness();
  const bridge = h.make();
  await bridge.enqueue(message('first'));
  await bridge.enqueue(message('second'));
  h.offline(true);
  await assert.rejects(bridge.pump());
  h.offline(false);
  await bridge.pump();
  assert.equal(h.posts.length, 0);
  h.tick();
  await bridge.pump();
  await bridge.pump();
  assert.equal(h.posts.length, 2);
});

test('agent reply resolves the recipient from persisted mapping; concurrent retries send once', async () => {
  const h = await seeded();
  await Promise.all([h.bridge.webhook(h.req()), h.bridge.webhook(h.req())]);
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].chatId, message().chatId);
  assert.equal(h.sends[0].sessionId, config.sessionId);
  await h.make().webhook(h.req());
  assert.equal(h.sends.length, 1);
});

test('a failed WhatsApp send can retry rather than being marked delivered', async () => {
  const h = await seeded();
  h.sendError(true);
  await assert.rejects(h.bridge.webhook(h.req()));
  h.sendError(false);
  await h.bridge.webhook(h.req());
  assert.equal(h.sends.length, 1);
});

test('unverified, unscoped, foreign-session and wrong-visitor deliveries cannot send', async () => {
  const h = await seeded();
  for (const over of [{ verified: false }, { sessionId: undefined }, { sessionId: 'other' }]) {
    await assert.rejects(h.bridge.webhook(h.req(over)));
  }
  const body = JSON.parse(h.req().body);
  body.visitor.token = 'wrong';
  await assert.doesNotReject(h.bridge.webhook(h.req({ body: JSON.stringify(body) })));
  assert.equal(h.sends.length, 0);
});

test('same provider room id cannot leak across destinations or sessions', async () => {
  const h = await seeded();
  for (const cfg of [
    { ...config, baseUrl: 'https://other.example' },
    { ...config, sessionId: 'other' },
    { ...config, department: 'other' },
  ]) {
    await assert.doesNotReject(h.make(cfg).webhook(h.req({ sessionId: cfg.sessionId })));
  }
  assert.equal(h.sends.length, 0);
});

test('a config-generation fence prevents queued work from using a retired destination', async () => {
  const h = harness();
  let active = true;
  const bridge = h.make(config, () => {
    if (!active) throw new Error('configuration changed');
  });
  await bridge.enqueue(message());
  active = false;
  await assert.rejects(bridge.pump());
  assert.equal(h.requests.length, 0);
  assert.equal(h.state().pending.length, 1);
});

test('transcript and visitor webhook echoes never create WhatsApp replies', async () => {
  const h = await seeded();
  const body = JSON.parse(h.req().body);
  body.type = 'LivechatSession';
  await h.bridge.webhook(h.req({ body: JSON.stringify(body) }));
  body.type = 'Message';
  delete body.messages[0].agentId;
  await h.bridge.webhook(h.req({ body: JSON.stringify(body) }));
  assert.equal(h.sends.length, 0);
});

test('identical WhatsApp IDs in different chats do not suppress one another', async () => {
  const h = harness();
  const bridge = h.make();
  await bridge.enqueue(message());
  await bridge.enqueue({ ...message(), chatId: '15550002222@c.us' });
  assert.equal(h.state().pending.length, 2);
  await bridge.pump();
  await bridge.pump();
  assert.equal(h.posts.length, 2);
  assert.equal(h.state().inboundSeen.length, 2);
});

test('dead letters do not consume live capacity and can be cleared idempotently', async () => {
  const h = await seeded();
  const state = h.state();
  state.dead = Array.from({ length: MAX_DEAD }, (_, i) => ({
    id: `dead-${i}`,
    chatId: message().chatId,
    text: 'old',
    name: 'test',
    attempts: 5,
    nextAt: 0,
    failedAt: 1,
  }));
  h.rows.set(stateKey(config), state);
  await h.bridge.enqueue(message('new'));
  assert.equal(h.state().pending.length, 1);
  assert.equal((await h.bridge.maintenance('clear', 'clear-1')).cleared, MAX_DEAD);
  assert.equal((await h.bridge.maintenance('clear', 'clear-1')).cleared, 0);
  assert.equal(h.state().links.length, 1);
});

test('dead letters can be replayed after restart without resetting on repeated saves', async () => {
  const h = harness();
  const bridge = h.make();
  h.offline(true);
  await bridge.enqueue(message());
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await assert.rejects(bridge.pump());
    h.tick();
  }
  const restored = h.make();
  assert.equal((await restored.maintenance('replay', 'retry-1')).replayed, 1);
  assert.equal((await restored.maintenance('replay', 'retry-1')).replayed, 0);
  h.offline(false);
  await restored.pump();
  assert.equal(h.posts.length, 1);
});

test('LRU eviction removes inactive mappings but protects pending contacts', async () => {
  const h = await seeded();
  const state = h.state();
  state.links = Array.from({ length: MAX_CHATS }, (_, i) => ({
    chatId: `${15550000000 + i}@c.us`,
    token: `token-${i}`,
    lastUsedAt: i,
  }));
  state.pending = [
    { id: 'protected', chatId: state.links[0].chatId, text: 'pending', name: 'test', attempts: 0, nextAt: 0 },
  ];
  h.rows.set(stateKey(config), state);
  await h.bridge.enqueue(message('new-contact'));
  assert.equal(h.state().links.length, MAX_CHATS);
  assert.ok(h.state().links.some((l) => l.chatId === state.links[0].chatId));
  assert.ok(!h.state().links.some((l) => l.chatId === state.links[1].chatId));
});

test('a burst is drained without a ten-second gap between lines', async () => {
  const h = harness();
  const bridge = h.make();
  for (let i = 0; i < 3; i++) await bridge.enqueue(message(`burst-${i}`));
  await bridge.pump();
  assert.equal(h.posts.length, 3);
});

test('old dead letters expire without discarding pending work', async () => {
  const h = await seeded();
  const state = h.state();
  state.dead = [
    {
      id: 'expired',
      chatId: message().chatId,
      text: 'old',
      name: 'test',
      attempts: 5,
      nextAt: 0,
      failedAt: -DEAD_RETENTION_MS,
    },
  ];
  h.rows.set(stateKey(config), state);
  await h.bridge.enqueue(message('new'));
  assert.equal(h.state().dead.length, 0);
  assert.equal(h.state().pending.length, 1);
});

test('slow Rocket.Chat I/O cannot block an agent reply or a storage enqueue', async () => {
  const h = await seeded();
  const original = h.ctx.net.fetch;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.ctx.net.fetch = async (url, init) => {
    await held;
    return original(url, init);
  };
  await h.bridge.enqueue(message('blocked'));
  const pumping = h.bridge.pump();
  await new Promise((resolve) => setImmediate(resolve));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([h.bridge.webhook(h.req()), h.bridge.enqueue(message('another'))]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('global state lock held by network')), 500);
      }),
    ]);
    assert.equal(h.sends.length, 1);
  } finally {
    clearTimeout(timer);
    release();
    await pumping;
  }
});

test('one failing chat does not hold back another customer', async () => {
  const h = harness();
  const original = h.ctx.net.fetch;
  h.ctx.net.fetch = async (url, init) => {
    if (typeof init?.body === 'string' && JSON.parse(init.body).visitor?.name === 'blocked')
      throw new Error('no agent');
    return original(url, init);
  };
  const bridge = h.make();
  await bridge.enqueue({ ...message('bad'), contact: { pushName: 'blocked' } });
  await bridge.enqueue({ ...message('good'), chatId: '15550002222@c.us' });
  await assert.rejects(bridge.pump());
  assert.equal(h.posts.length, 1);
  assert.equal(h.state().pending.length, 1);
});

test('phone extraction never turns a privacy id into a telephone number', async () => {
  const { phoneFromChat } = await import('./bridge.ts');
  assert.equal(phoneFromChat('15550001111:2@s.whatsapp.net'), '+15550001111');
  assert.equal(phoneFromChat('15550001111@c.us'), '+15550001111');
  assert.equal(phoneFromChat('15550001111@lid'), undefined);
  assert.equal(phoneFromChat('15550001111@g.us'), undefined);
});

test('dead-letter count retention is bounded independently of live slots', async () => {
  const h = await seeded();
  const state = h.state();
  state.dead = Array.from({ length: MAX_DEAD + 20 }, (_, i) => ({
    id: `old-${i}`,
    chatId: message().chatId,
    text: 'old',
    name: 'test',
    attempts: 5,
    nextAt: 0,
    failedAt: 1,
  }));
  h.rows.set(stateKey(config), state);
  await h.bridge.enqueue(message('fresh'));
  assert.equal(h.state().dead.length, MAX_DEAD);
  assert.equal(h.state().pending.length, 1);
});
