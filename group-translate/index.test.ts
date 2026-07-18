import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  PluginContext,
  HookContext,
  HookResult,
  IncomingMessage,
  PluginNetResponse,
} from "../types/openwa";
import { TranslationPlugin } from "./index.ts";

function makeStorage() {
  const m = new Map<string, unknown>();
  return {
    get: async (k: string) => (m.has(k) ? m.get(k) : null),
    set: async (k: string, v: unknown) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
    list: async () => [...m.keys()],
  };
}

function fakeContext(config: Record<string, unknown>) {
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
        body: '[{"code":"en"}]',
      }) as PluginNetResponse,
  };
  const ctx = {
    pluginId: "group-translate",
    manifest: { id: "group-translate" },
    config,
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
  return { ctx, getHook: () => hook };
}

const engineCtx = (
  data: Partial<IncomingMessage> = {},
): HookContext<IncomingMessage> => ({
  event: "message:received",
  source: "Engine",
  sessionId: "s1",
  timestamp: new Date(0),
  data: {
    id: "m1",
    from: "x@s.whatsapp.net",
    to: "y@s.whatsapp.net",
    chatId: "group@g.us",
    body: "hello",
    type: "text",
    timestamp: 0,
    fromMe: false,
    isGroup: true,
    author: "x@s.whatsapp.net",
    ...data,
  } as IncomingMessage,
});

// Regression: the message hook must rebuild the coordinator when a coordinator-affecting config field
// changes (per-session override), and must NOT rebuild it when the config is unchanged (preserving the
// LibreTranslate client's circuit-breaker state across messages for the same backend).
test("coordinator rebuilds when coordinator-affecting config changes, is reused when unchanged", async () => {
  const config: Record<string, unknown> = {
    libretranslateUrl: "http://lt-a:7001",
  };
  const { ctx, getHook } = fakeContext(config);
  const plugin = new TranslationPlugin();
  await plugin.onEnable(ctx);
  const coordAfterEnable = (plugin as unknown as { coordinator: unknown })
    .coordinator;
  assert.ok(coordAfterEnable, "coordinator built at enable");

  // Fire a hook WITHOUT changing config → coordinator must be reused (circuit breaker preserved).
  await getHook()!(engineCtx());
  const coordUnchanged = (plugin as unknown as { coordinator: unknown })
    .coordinator;
  assert.strictEqual(
    coordUnchanged,
    coordAfterEnable,
    "coordinator reused for unchanged config",
  );

  // Change a coordinator-affecting field (libretranslateUrl) → coordinator must rebuild on next hook fire.
  config.libretranslateUrl = "http://lt-b:7001";
  await getHook()!(engineCtx());
  const coordRebuilt = (plugin as unknown as { coordinator: unknown })
    .coordinator;
  assert.notStrictEqual(
    coordRebuilt,
    coordAfterEnable,
    "coordinator rebuilt for changed config",
  );
});
