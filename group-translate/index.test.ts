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

function makeStorage(seed: Record<string, unknown> = {}) {
  const m = new Map<string, unknown>(Object.entries(seed));
  return {
    get: async (k: string) => (m.has(k) ? m.get(k) : null),
    set: async (k: string, v: unknown) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
    list: async () => [...m.keys()],
  };
}

function fakeContext(
  config: Record<string, unknown>,
  over: {
    net?: { fetch: (url: string, init?: unknown) => Promise<PluginNetResponse> };
    messages?: Record<string, unknown>;
    engine?: Record<string, unknown>;
    seed?: Record<string, unknown>;
  } = {},
) {
  let hook:
    | ((ctx: HookContext<IncomingMessage>) => Promise<HookResult>)
    | undefined;
  let priority: number | undefined;
  const net = over.net ?? {
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
    storage: makeStorage(over.seed),
    registerHook: (
      _event: string,
      handler: (c: HookContext<IncomingMessage>) => Promise<HookResult>,
      p?: number,
    ) => {
      hook = handler;
      priority = p;
    },
    messages: over.messages ?? {},
    engine: over.engine ?? {},
    net,
    hookManager: {},
  } as unknown as PluginContext;
  return { ctx, getHook: () => hook, getPriority: () => priority };
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

// Transformer band (PLUGIN-STANDARD.md "Co-installation"): must run ahead of every responder, or a
// responder answers the untranslated original before this plugin's translation replaces it.
test("registers in the transformer band, ahead of every responder", async () => {
  const { ctx, getPriority } = fakeContext({});
  const plugin = new TranslationPlugin();
  await plugin.onEnable(ctx);
  assert.equal(getPriority(), 50);
});

// ── Claim wiring: the coordinator's `swallow` must reach the host as `continue` ──────────────────────
// The coordinator suites pin `{swallow: true/false}`, but nothing pinned that this plugin forwards it.
// The README, the CHANGELOG and PLUGIN-STANDARD.md all publish the resulting behavior — "claims only its
// own /tr admin commands, never a translated conversational message" — so a hook that hardcoded
// `continue: true` (or `false`) would make three public documents false with every test still green.

const GROUP_KEY = "group:s1:group@g.us";
const AUTHOR = "x@s.whatsapp.net";

test("claims a /tr admin command, so no responder answers a message addressed to this plugin", async () => {
  const sent: string[] = [];
  const { ctx, getHook } = fakeContext(
    {},
    {
      seed: {
        [GROUP_KEY]: {
          sessionId: "s1",
          chatId: "group@g.us",
          active: false,
          participants: {},
          delegatedControllers: [],
          announced: true, // already greeted, so the only send here is the command's own confirmation
        },
      },
      messages: { sendText: async (_s: string, _c: string, t: string) => void sent.push(t) },
      engine: {
        getGroupInfo: async () => ({ participants: [{ id: AUTHOR, isAdmin: true }] }),
      },
    },
  );
  const plugin = new TranslationPlugin();
  await plugin.onEnable(ctx);

  const result = await getHook()!(engineCtx({ body: "/tr on" }));
  assert.equal(sent.length, 1, "the command was handled (its confirmation was sent)");
  assert.equal(result.continue, false, "a control message addressed to this plugin is claimed");
});

test("does NOT claim a translated conversational message — a co-installed responder still sees it", async () => {
  const replies: string[] = [];
  const { ctx, getHook } = fakeContext(
    {},
    {
      seed: {
        [GROUP_KEY]: {
          sessionId: "s1",
          chatId: "group@g.us",
          active: true,
          participants: {
            [AUTHOR]: { lang: "en", source: "pinned", enabled: true, samples: 0, updatedAt: "" },
            "z@s.whatsapp.net": { lang: "id", source: "pinned", enabled: true, samples: 0, updatedAt: "" },
          },
          delegatedControllers: [],
          announced: true,
        },
      },
      net: {
        fetch: async (url: string) =>
          ({
            ok: true,
            status: 200,
            statusText: "",
            headers: {},
            body: url.endsWith("/detect")
              ? '[{"language":"en","confidence":0.99}]'
              : '{"translatedText":"halo dunia"}',
          }) as PluginNetResponse,
      },
      messages: {
        sendText: async () => {},
        reply: async (_s: string, _c: string, _q: string, t: string) => void replies.push(t),
      },
    },
  );
  const plugin = new TranslationPlugin();
  await plugin.onEnable(ctx);

  const result = await getHook()!(engineCtx({ body: "hello world" }));
  assert.equal(replies.length, 1, "the message really was translated (not skipped into a trivial pass)");
  assert.match(replies[0], /halo dunia/);
  assert.equal(result.continue, true, "conversational content is passed on, translated or not");
});

// From host 0.23.2 a shared contact card carries its full vCard as the body. Translating one would POST
// a stranger's name and number to the backend, post the machine-translated card back into the group,
// and feed the vCard to language detection, which pins the sender's language on their very first card.
// A poll is deliberately still translated: its question is human-typed prose.
test("a shared contact card is never translated; a poll question still is", async () => {
  const seed = {
    [GROUP_KEY]: {
      sessionId: "s1",
      chatId: "group@g.us",
      active: true,
      participants: {
        [AUTHOR]: { lang: "en", source: "pinned", enabled: true, samples: 0, updatedAt: "" },
        "z@s.whatsapp.net": { lang: "id", source: "pinned", enabled: true, samples: 0, updatedAt: "" },
      },
      delegatedControllers: [],
      announced: true,
    },
  };
  const urls: string[] = [];
  const replies: string[] = [];
  const { ctx, getHook } = fakeContext(
    {},
    {
      seed,
      net: {
        fetch: async (url: string) => {
          urls.push(url);
          return {
            ok: true,
            status: 200,
            statusText: "",
            headers: {},
            body: url.endsWith("/detect")
              ? '[{"language":"en","confidence":0.99}]'
              : '{"translatedText":"halo dunia"}',
          } as PluginNetResponse;
        },
      },
      messages: {
        sendText: async () => {},
        reply: async (_s: string, _c: string, _q: string, t: string) => void replies.push(t),
      },
    },
  );
  const plugin = new TranslationPlugin();
  await plugin.onEnable(ctx);

  const vcard =
    "BEGIN:VCARD\nVERSION:3.0\nFN:Budi Santoso\nORG:Toko Berkah\nTEL;TYPE=CELL:+628123456789\nEND:VCARD";
  const card = await getHook()!(engineCtx({ body: vcard, type: "contact" }));
  assert.equal(card.continue, true, "a contact card is passed on untouched");
  assert.deepEqual(urls, [], "no vCard may reach the translation backend");
  assert.deepEqual(replies, [], "and no translated card may be posted into the group");

  const poll = await getHook()!(engineCtx({ body: "hello world", type: "poll" }));
  assert.equal(poll.continue, true);
  assert.ok(urls.length > 0, "a poll question is prose and is still translated");
  assert.equal(replies.length, 1);
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
