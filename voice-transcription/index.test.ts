import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  PluginContext,
  HookContext,
  HookResult,
  IncomingMessage,
  PluginNetResponse,
} from "../types/openwa";
import { VoiceTranscriptionPlugin } from "./index.ts";

function voiceMsg(): IncomingMessage {
  return {
    id: "m1",
    from: "x@s.whatsapp.net",
    to: "y@s.whatsapp.net",
    chatId: "c1@s.whatsapp.net",
    body: "",
    type: "voice",
    timestamp: 0,
    fromMe: false,
    isGroup: false,
    media: {
      mimetype: "audio/ogg; codecs=opus",
      data: Buffer.from("AUDIO").toString("base64"),
      sizeBytes: 5,
    },
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

function fakeContext(opts: {
  net: { fetch: (...a: unknown[]) => Promise<PluginNetResponse> };
  config?: Record<string, unknown>;
}) {
  let hook:
    | ((ctx: HookContext<IncomingMessage>) => Promise<HookResult>)
    | undefined;
  const ctx = {
    pluginId: "voice-transcription",
    manifest: { id: "voice-transcription" },
    config: {
      sttBaseUrl: "http://stt",
      deliveryWebhookUrl: "http://hook.local/in",
      ...opts.config,
    },
    logger: { log() {}, debug() {}, warn() {}, error() {} },
    storage: makeStorage(),
    registerHook: (
      event: string,
      handler: (c: HookContext<IncomingMessage>) => Promise<HookResult>,
    ) => {
      if (event === "message:received") hook = handler;
    },
    messages: {},
    engine: {},
    net: opts.net,
    hookManager: {},
  } as unknown as PluginContext;
  return { ctx, getHook: () => hook };
}

const engineCtx = (data: IncomingMessage): HookContext<IncomingMessage> => ({
  event: "message:received",
  source: "Engine",
  sessionId: "s1",
  timestamp: new Date(0),
  data,
});

test("the message:received hook returns {continue:true} without awaiting STT (non-blocking)", async () => {
  // ctx.net.fetch never resolves. If the hook awaited the STT round-trip, the call below would hang.
  const net = { fetch: () => new Promise<PluginNetResponse>(() => {}) };
  const { ctx, getHook } = fakeContext({ net });
  const plugin = new VoiceTranscriptionPlugin();
  await plugin.onEnable(ctx);
  const hook = getHook();
  assert.ok(hook, "plugin must register a message:received hook");

  const hookCall = hook(engineCtx(voiceMsg()));
  const winner = await Promise.race([
    hookCall.then((r) => ({ result: r })),
    new Promise<string>((res) => setTimeout(() => res("timeout"), 250)),
  ]);
  assert.notEqual(
    winner,
    "timeout",
    "hook blocked on STT instead of returning immediately",
  );
  assert.deepEqual((winner as { result: HookResult }).result, {
    continue: true,
  });
});

test("does not start transcription for non-Engine sources", async () => {
  let fetched = false;
  const net = {
    fetch: async () => {
      fetched = true;
      return {
        ok: true,
        status: 200,
        statusText: "",
        headers: {},
        body: '{"text":"x"}',
      } as PluginNetResponse;
    },
  };
  const { ctx, getHook } = fakeContext({ net });
  const plugin = new VoiceTranscriptionPlugin();
  await plugin.onEnable(ctx);
  const result = await getHook()!({
    ...engineCtx(voiceMsg()),
    source: "Dashboard",
  });
  assert.deepEqual(result, { continue: true });
  await new Promise((r) => setImmediate(r)); // let any floated work run a tick
  assert.equal(fetched, false);
});

// Regression: the message hook must rebuild the coordinator when a coordinator-affecting config field
// changes (per-session override), and must NOT rebuild it when the config is unchanged (preserving the
// STT provider's circuit-breaker state across messages for the same backend).
test("coordinator rebuilds when coordinator-affecting config changes, is reused when unchanged", async () => {
  // Hold config by reference (fakeContext spreads it into a new object, hiding mutations). A custom
  // context mirrors what the host does: ctx.config is a live view of the firing session's resolved slice.
  const config: Record<string, unknown> = {
    sttBaseUrl: "http://stt-a",
    deliveryWebhookUrl: "http://hook.local/in",
  };
  let hook:
    | ((ctx: HookContext<IncomingMessage>) => Promise<HookResult>)
    | undefined;
  const net = {
    fetch: async () =>
      ({
        ok: true,
        status: 200,
        statusText: "",
        headers: {},
        body: '{"text":"x"}',
      }) as PluginNetResponse,
  };
  const ctx = {
    pluginId: "voice-transcription",
    manifest: { id: "voice-transcription" },
    config, // held by reference — mutations are visible to configSignature on the next hook fire
    logger: { log() {}, debug() {}, warn() {}, error() {} },
    storage: makeStorage(),
    registerHook: (
      _event: string,
      handler: (c: HookContext<IncomingMessage>) => Promise<HookResult>,
    ) => {
      hook = handler;
    },
    messages: {},
    engine: {},
    net,
    hookManager: {},
  } as unknown as PluginContext;
  const plugin = new VoiceTranscriptionPlugin();
  await plugin.onEnable(ctx);
  assert.ok(hook, "hook registered");
  const coordAfterEnable = (plugin as unknown as { coordinator: unknown })
    .coordinator;
  assert.ok(coordAfterEnable, "coordinator built at enable");

  // Fire a hook WITHOUT changing config → coordinator must be reused (circuit breaker preserved).
  hook!(engineCtx(voiceMsg()));
  const coordUnchanged = (plugin as unknown as { coordinator: unknown })
    .coordinator;
  assert.strictEqual(
    coordUnchanged,
    coordAfterEnable,
    "coordinator reused for unchanged config",
  );

  // Change a coordinator-affecting field (sttBaseUrl) → coordinator must rebuild on next hook fire.
  config.sttBaseUrl = "http://stt-b";
  hook!(engineCtx(voiceMsg()));
  const coordRebuilt = (plugin as unknown as { coordinator: unknown })
    .coordinator;
  assert.notStrictEqual(
    coordRebuilt,
    coordAfterEnable,
    "coordinator rebuilt for changed config",
  );
});
