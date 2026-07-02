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

function makeStore(): KvStore {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => (m.has(k) ? (m.get(k) as T) : null),
    set: async (k, v) => void m.set(k, v),
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
