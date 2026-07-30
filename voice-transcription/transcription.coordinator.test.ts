import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from '../types/openwa';
import type { SttResult, SttProvider } from './openai-stt.client.ts';
import type { TranscriptionPayload } from './webhook.delivery.ts';
import {
  TranscriptionCoordinator,
  KvStore,
  TranscriptionConfig,
  ChatSink,
  ChatDeliveryMode,
} from './transcription.coordinator.ts';

function makeStore(seed: Record<string, unknown> = {}): KvStore & { keys(): string[] } {
  const m = new Map<string, unknown>(Object.entries(seed));
  return {
    get: async <T>(k: string) => (m.has(k) ? (m.get(k) as T) : null),
    set: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
    // Mirrors the host: list(prefix) filters for you, and a bare list() returns everything.
    list: async (prefix?: string) => [...m.keys()].filter((k) => !prefix || k.startsWith(prefix)),
    keys: () => [...m.keys()],
  };
}

function voiceMsg(over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: 'm1',
    from: 'x@s.whatsapp.net',
    to: 'y@s.whatsapp.net',
    chatId: 'c1@s.whatsapp.net',
    body: '',
    type: 'voice',
    timestamp: 0,
    fromMe: false,
    isGroup: false,
    media: { mimetype: 'audio/ogg; codecs=opus', data: Buffer.from('AUDIO').toString('base64'), sizeBytes: 5 },
    ...over,
  };
}

interface FakeProvider extends SttProvider {
  calls: Array<{ audio: Uint8Array; mimetype: string }>;
}
type ChatSend =
  | { kind: 'sendText'; sessionId: string; chatId: string; text: string }
  | { kind: 'reply'; sessionId: string; chatId: string; quoted: string; text: string };

function setup(opts: {
  result?: SttResult;
  providerThrows?: boolean;
  deliveryThrows?: boolean;
  noDelivery?: boolean;
  chatDelivery?: ChatDeliveryMode;
  config?: Partial<TranscriptionConfig>;
  store?: KvStore;
  now?: () => number;
}) {
  const provider: FakeProvider = {
    calls: [],
    async transcribe(audio, mimetype) {
      this.calls.push({ audio, mimetype });
      if (opts.providerThrows) throw new Error('stt down');
      return opts.result ?? { text: 'hola', language: 'es' };
    },
  };
  const deliveries: TranscriptionPayload[] = [];
  const delivery = opts.noDelivery
    ? undefined
    : {
        async deliver(e: TranscriptionPayload) {
          deliveries.push(e);
          if (opts.deliveryThrows) throw new Error('hook 502');
        },
      };
  const chatSends: ChatSend[] = [];
  const chat: ChatSink = {
    sendText: async (sessionId, chatId, text) => void chatSends.push({ kind: 'sendText', sessionId, chatId, text }),
    reply: async (sessionId, chatId, quoted, text) =>
      void chatSends.push({ kind: 'reply', sessionId, chatId, quoted, text }),
  };
  const warns: string[] = [];
  const co = new TranscriptionCoordinator({
    provider,
    delivery,
    chat,
    chatDelivery: opts.chatDelivery ?? 'off',
    store: opts.store ?? makeStore(),
    config: { enabledMessageTypes: ['voice'], maxSizeBytes: 1000, maxPerHour: 100, ...opts.config },
    providerLabel: 'faster-whisper',
    model: 'small',
    logger: { warn: m => void warns.push(m) },
    now: opts.now,
  });
  return { co, provider, deliveries, chatSends, warns };
}

test('transcribes a voice note and delivers a completed event with decoded audio + payload', async () => {
  const { co, provider, deliveries, chatSends } = setup({});
  await co.handle('s1', voiceMsg());
  assert.equal(provider.calls.length, 1);
  assert.deepEqual([...provider.calls[0].audio], [...Buffer.from('AUDIO')]);
  assert.equal(provider.calls[0].mimetype, 'audio/ogg; codecs=opus');
  assert.deepEqual(deliveries[0], {
    event: 'message.transcription',
    sessionId: 's1',
    messageId: 'm1',
    chatId: 'c1@s.whatsapp.net',
    status: 'completed',
    source: 'speech-to-text',
    untrusted: true,
    transcription: { text: 'hola', language: 'es', provider: 'faster-whisper', model: 'small' },
  });
  assert.equal(chatSends.length, 0); // chatDelivery off by default
});

test('skips a non-enabled message type — no STT, no event', async () => {
  const { co, provider, deliveries } = setup({});
  await co.handle('s1', voiceMsg({ type: 'image' }));
  assert.equal(provider.calls.length, 0);
  assert.equal(deliveries.length, 0);
});

test('skips when media is absent — no event', async () => {
  const { co, provider, deliveries } = setup({});
  await co.handle('s1', voiceMsg({ media: undefined }));
  assert.equal(provider.calls.length, 0);
  assert.equal(deliveries.length, 0);
});

test('emits a skipped event when media was omitted over the inbound cap', async () => {
  const { co, provider, deliveries } = setup({});
  await co.handle('s1', voiceMsg({ media: { mimetype: 'audio/ogg', omitted: true, sizeBytes: 99999999 } }));
  assert.equal(provider.calls.length, 0);
  assert.equal(deliveries[0].status, 'skipped');
  assert.equal(deliveries[0].reason, 'media_unavailable');
});

test('emits a skipped event when the audio exceeds maxSizeBytes', async () => {
  const { co, provider, deliveries } = setup({ config: { maxSizeBytes: 3 } }); // 'AUDIO' decodes to 5 bytes
  await co.handle('s1', voiceMsg());
  assert.equal(provider.calls.length, 0);
  assert.equal(deliveries[0].status, 'skipped');
  assert.equal(deliveries[0].reason, 'too_large');
});

test('idempotency: the same messageId is processed once (one STT call, one event)', async () => {
  const { co, provider, deliveries } = setup({});
  await co.handle('s1', voiceMsg());
  await co.handle('s1', voiceMsg()); // re-fire
  assert.equal(provider.calls.length, 1);
  assert.equal(deliveries.length, 1);
});

test('rate limit: emits a skipped event once maxPerHour is reached, with no more STT', async () => {
  const { co, provider, deliveries } = setup({ config: { maxPerHour: 2 }, now: () => 0 });
  for (const id of ['a', 'b', 'c']) await co.handle('s1', voiceMsg({ id }));
  assert.equal(provider.calls.length, 2);
  assert.equal(deliveries[deliveries.length - 1].status, 'skipped');
  assert.equal(deliveries[deliveries.length - 1].reason, 'rate_limited');
});

test('emits a skipped event when the transcript is empty/whitespace', async () => {
  const { co, deliveries } = setup({ result: { text: '   ' } });
  await co.handle('s1', voiceMsg());
  assert.equal(deliveries[0].status, 'skipped');
  assert.equal(deliveries[0].reason, 'empty');
});

test('emits a failed event (and never throws) when STT errors', async () => {
  const { co, deliveries, warns } = setup({ providerThrows: true });
  await assert.doesNotReject(co.handle('s1', voiceMsg()));
  assert.equal(deliveries[0].status, 'failed');
  assert.ok(warns.length >= 1);
});

test('fail-open: a delivery error is swallowed and warned', async () => {
  const { co, warns } = setup({ deliveryThrows: true });
  await assert.doesNotReject(co.handle('s1', voiceMsg()));
  assert.ok(warns.length >= 1);
});

test('chatDelivery=self sends the transcript to the bot own number (msg.to)', async () => {
  const { co, chatSends } = setup({ chatDelivery: 'self' });
  await co.handle('s1', voiceMsg());
  assert.deepEqual(chatSends[0], { kind: 'sendText', sessionId: 's1', chatId: 'y@s.whatsapp.net', text: 'hola' });
});

test('chatDelivery=reply quote-replies in the original chat', async () => {
  const { co, chatSends } = setup({ chatDelivery: 'reply' });
  await co.handle('s1', voiceMsg());
  assert.deepEqual(chatSends[0], {
    kind: 'reply',
    sessionId: 's1',
    chatId: 'c1@s.whatsapp.net',
    quoted: 'm1',
    text: 'hola',
  });
});

test('chat delivery does not fire for a skipped/failed outcome', async () => {
  const { co, chatSends } = setup({ chatDelivery: 'self', config: { maxSizeBytes: 3 } }); // oversize → skipped
  await co.handle('s1', voiceMsg());
  assert.equal(chatSends.length, 0);
});

test('works chat-only when no webhook delivery is configured', async () => {
  const { co, chatSends } = setup({ noDelivery: true, chatDelivery: 'self' });
  await assert.doesNotReject(co.handle('s1', voiceMsg()));
  assert.equal(chatSends.length, 1);
});

test('a webhook delivery failure does not suppress the in-chat transcript delivery', async () => {
  // The two sinks are independent: a 502 from the delivery webhook must not swallow the chat send.
  const { co, chatSends, warns } = setup({ deliveryThrows: true, chatDelivery: 'self' });
  await assert.doesNotReject(co.handle('s1', voiceMsg()));
  assert.equal(chatSends.length, 1);   // chat sink still fired despite the webhook failure
  assert.ok(warns.length >= 1);        // the webhook failure is still warned
});

// ── Storage growth (1.1.0) ──────────────────────────────────────────────────────────────────────────
// The host re-stats every one of a plugin's storage keys on EVERY write. Pre-1.1.0 this plugin wrote one
// never-deleted key per transcribed voice note plus one per session per hour, so each write cost more
// than the last, forever.

test('storage keys stay bounded at one dedup list + one rate counter per session', async () => {
  const store = makeStore();
  const { co } = setup({ store, config: { maxPerHour: 10_000 } });
  for (let i = 0; i < 200; i++) await co.handle('s1', voiceMsg({ id: `m${i}` }));
  assert.deepEqual(store.keys().sort(), ['rate:s1', 'seen:s1']);
});

test('the dedup list is capped, and still dedups within its window', async () => {
  const store = makeStore();
  const { co, provider } = setup({ store, config: { maxPerHour: 10_000 } });
  for (let i = 0; i < 600; i++) await co.handle('s1', voiceMsg({ id: `m${i}` }));
  const seen = (await store.get<string[]>('seen:s1'))!;
  assert.ok(seen.length <= 500, `dedup list grew to ${seen.length}`);
  const before = provider.calls.length;
  await co.handle('s1', voiceMsg({ id: 'm599' })); // the most recent id is still remembered
  assert.equal(provider.calls.length, before, 'a recently-seen message must not be transcribed again');
});

test('the hourly counter reuses one key across hours instead of leaving one behind per hour', async () => {
  const store = makeStore();
  let hour = 0;
  const { co, provider } = setup({ store, config: { maxPerHour: 1 }, now: () => hour * 3_600_000 });
  await co.handle('s1', voiceMsg({ id: 'a' }));
  await co.handle('s1', voiceMsg({ id: 'b' })); // over the cap in the same hour
  assert.equal(provider.calls.length, 1);
  hour = 1; // next hour: the budget resets, and no second rate key appears
  await co.handle('s1', voiceMsg({ id: 'c' }));
  assert.equal(provider.calls.length, 2);
  assert.equal(store.keys().filter(k => k.startsWith('rate:')).length, 1);
});

test('pre-1.1.0 per-message dedup keys are swept away as transcriptions run', async () => {
  const legacy: Record<string, unknown> = {};
  for (let i = 0; i < 60; i++) legacy[`seen:s1:old${i}`] = 1;
  const store = makeStore(legacy);
  const { co } = setup({ store, config: { maxPerHour: 10_000 } });
  for (let i = 0; i < 3; i++) await co.handle('s1', voiceMsg({ id: `m${i}` }));
  assert.equal(store.keys().filter(k => k.startsWith('seen:s1:')).length, 0, 'legacy keys should be gone');
  assert.ok(store.keys().includes('seen:s1'), 'the new dedup list survives the sweep');
});

// ── Size guard (1.1.0) ──────────────────────────────────────────────────────────────────────────────
// Checked before decoding: decoding first materialized an oversized note as a Buffer on top of the
// base64 string already in memory, against a 256 MB worker heap the host does not respawn.

test('oversized audio is skipped without ever being decoded', async () => {
  const { co, provider, deliveries } = setup({ config: { maxSizeBytes: 10 } });
  const big = { media: { mimetype: 'audio/ogg', data: Buffer.alloc(5000).toString('base64') } };
  await co.handle('s1', voiceMsg(big as Partial<IncomingMessage>));
  assert.equal(provider.calls.length, 0);
  assert.equal(deliveries[0].status, 'skipped');
  assert.equal(deliveries[0].reason, 'too_large');
});

test('audio exactly at the limit is still transcribed', async () => {
  const raw = Buffer.alloc(300, 7);
  const { co, provider } = setup({ config: { maxSizeBytes: raw.byteLength } });
  await co.handle('s1', voiceMsg({ media: { mimetype: 'audio/ogg', data: raw.toString('base64') } }));
  assert.equal(provider.calls.length, 1, 'a note exactly at maxSizeBytes must not be rejected');
});

// Regression: the dedup claim is a read-modify-write over ONE list per session, and handle() is floated
// off the hook — so a burst of voice notes interleaved and the last writer overwrote the others' ids.
// Each lost id is a second paid STT call and, with chatDelivery 'reply', a duplicate transcript the
// CONTACT sees. The pre-1.1.0 one-key-per-note scheme had no such window.
test('a concurrent burst of voice notes claims every id exactly once', async () => {
  const inner = makeStore();
  const tick = () => new Promise(r => setTimeout(r, 1));
  const slow: KvStore & { keys(): string[] } = {
    get: async <T>(k: string) => { await tick(); return inner.get<T>(k); },
    set: async (k, v) => { await tick(); return inner.set(k, v); },
    delete: k => inner.delete(k),
    list: p => inner.list(p),
    keys: () => inner.keys(),
  };
  const { co, provider } = setup({ store: slow, config: { maxPerHour: 10_000 } });
  const ids = ['a', 'b', 'c', 'd'];
  await Promise.all(ids.map(id => co.handle('s1', voiceMsg({ id }))));

  assert.equal(provider.calls.length, 4, 'each note transcribed once');
  const seen = (await slow.get<string[]>('seen:s1')) ?? [];
  assert.deepEqual([...seen].sort(), ids, 'every id retained — a lost one re-transcribes on redelivery');

  // Replaying the burst must now be a complete no-op.
  await Promise.all(ids.map(id => co.handle('s1', voiceMsg({ id }))));
  assert.equal(provider.calls.length, 4, 'no duplicate STT call on redelivery');
});
