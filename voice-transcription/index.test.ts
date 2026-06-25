import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginContext, HookContext, HookResult, IncomingMessage, PluginNetResponse } from '../types/openwa';
import { VoiceTranscriptionPlugin } from './index.ts';

function voiceMsg(): IncomingMessage {
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
  };
}

function makeStorage() {
  const m = new Map<string, unknown>();
  return {
    get: async (k: string) => (m.has(k) ? m.get(k) : null),
    set: async (k: string, v: unknown) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
    list: async () => [...m.keys()],
  };
}

function fakeContext(opts: { net: { fetch: (...a: unknown[]) => Promise<PluginNetResponse> }; config?: Record<string, unknown> }) {
  let hook: ((ctx: HookContext<IncomingMessage>) => Promise<HookResult>) | undefined;
  const ctx = {
    pluginId: 'voice-transcription',
    manifest: { id: 'voice-transcription' },
    config: { sttBaseUrl: 'http://stt', deliveryWebhookUrl: 'http://hook.local/in', ...opts.config },
    logger: { log() {}, debug() {}, warn() {}, error() {} },
    storage: makeStorage(),
    registerHook: (event: string, handler: (c: HookContext<IncomingMessage>) => Promise<HookResult>) => {
      if (event === 'message:received') hook = handler;
    },
    messages: {},
    engine: {},
    net: opts.net,
    hookManager: {},
  } as unknown as PluginContext;
  return { ctx, getHook: () => hook };
}

const engineCtx = (data: IncomingMessage): HookContext<IncomingMessage> => ({
  event: 'message:received',
  source: 'Engine',
  sessionId: 's1',
  timestamp: new Date(0),
  data,
});

test('the message:received hook returns {continue:true} without awaiting STT (non-blocking)', async () => {
  // ctx.net.fetch never resolves. If the hook awaited the STT round-trip, the call below would hang.
  const net = { fetch: () => new Promise<PluginNetResponse>(() => {}) };
  const { ctx, getHook } = fakeContext({ net });
  const plugin = new VoiceTranscriptionPlugin();
  await plugin.onEnable(ctx);
  const hook = getHook();
  assert.ok(hook, 'plugin must register a message:received hook');

  const hookCall = hook(engineCtx(voiceMsg()));
  const winner = await Promise.race([
    hookCall.then(r => ({ result: r })),
    new Promise<string>(res => setTimeout(() => res('timeout'), 250)),
  ]);
  assert.notEqual(winner, 'timeout', 'hook blocked on STT instead of returning immediately');
  assert.deepEqual((winner as { result: HookResult }).result, { continue: true });
});

test('does not start transcription for non-Engine sources', async () => {
  let fetched = false;
  const net = {
    fetch: async () => {
      fetched = true;
      return { ok: true, status: 200, statusText: '', headers: {}, body: '{"text":"x"}' } as PluginNetResponse;
    },
  };
  const { ctx, getHook } = fakeContext({ net });
  const plugin = new VoiceTranscriptionPlugin();
  await plugin.onEnable(ctx);
  const result = await getHook()!({ ...engineCtx(voiceMsg()), source: 'Dashboard' });
  assert.deepEqual(result, { continue: true });
  await new Promise(r => setImmediate(r)); // let any floated work run a tick
  assert.equal(fetched, false);
});
