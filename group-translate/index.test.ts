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

// ── Claim wiring: the coordinator's claim must reach the host as `continue` ──────────────────────────
// The coordinator suites pin `{swallow: true/false}`, but nothing pinned that this plugin forwards it.
// The README, the CHANGELOG and PLUGIN-STANDARD.md all publish the resulting behavior — "claims only its
// own /tr admin commands, never a translated conversational message" — so a hook that hardcoded
// `continue: true` (or `false`) would make three public documents false with every test still green.

const GROUP_KEY = "group:s1:group@g.us";
const AUTHOR = "x@s.whatsapp.net";
// A claimed command runs after the hook returns; its work is all microtasks, so one turn drains it.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

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
  assert.equal(result.continue, false, "a control message addressed to this plugin is claimed");
  await settle();
  assert.equal(sent.length, 1, "the command was handled (its confirmation was sent)");
});

// The claim is decided on the parse, not on how the command ends. A group admin lookup that fails, or
// outlasts the host's 5 s hook budget (which then passes the message on by itself), must not hand
// "/tr on" to the next responder.
function commandContext(getGroupInfo: () => Promise<unknown>) {
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
          announced: true,
        },
      },
      messages: { sendText: async (_s: string, _c: string, t: string) => void sent.push(t) },
      engine: { getGroupInfo, getContactById: async () => null },
    },
  );
  return { ctx, getHook, sent };
}

test("a /tr command is claimed at once when the admin lookup throws", async () => {
  const { ctx, getHook, sent } = commandContext(async () => {
    throw new Error("WhatsApp Web did not answer the read of group group@g.us in time");
  });
  await new TranslationPlugin().onEnable(ctx);

  const result = await getHook()!(engineCtx({ body: "/tr on" }));
  assert.equal(result.continue, false);
  await settle();
  assert.deepEqual(sent, [], "an unknown admin list denies, silently by default");
});

test("a /tr command is claimed at once when the admin lookup never answers", async () => {
  const { ctx, getHook, sent } = commandContext(() => new Promise(() => {}));
  await new TranslationPlugin().onEnable(ctx);

  // The host's hook budget in miniature: whichever settles first is what the next responder sees.
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<HookResult>((resolve) => {
    timer = setTimeout(() => resolve({ continue: true }), 100);
  });
  const result = await Promise.race([getHook()!(engineCtx({ body: "/tr on" })), budget]);
  clearTimeout(timer);
  assert.equal(result.continue, false);
  await settle();
  assert.deepEqual(sent, []);
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

// From host 0.23.5 a Baileys order arrives as 'order' with its note or title as the body, and a shared
// product card as 'product' with its text or title. A commerce message is not conversation: translating
// it posts a quote-reply into the group and lets detection learn the member's language from a seller's
// catalog wording.
for (const [type, body] of [
  ["order", "Please deliver before noon"],
  ["product", "Arabica coffee beans 250g"],
]) {
  test(`a Baileys '${type}' message is never translated`, async () => {
    const urls: string[] = [];
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

    const result = await getHook()!(engineCtx({ body, type }));
    assert.equal(result.continue, true, "passed on untouched");
    assert.deepEqual(urls, [], "no translation request is made");
    assert.deepEqual(replies, [], "and no reply is posted into the group");
  });
}

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

// From OpenWA 0.23.6 a Baileys session delivers, after it reconnects, what WhatsApp queued while it was
// disconnected, each message with its original send time in `timestamp` (unix seconds).
async function translatingHook() {
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
  return { hook: getHook()!, replies };
}

test("a message sent more than 5 minutes before it arrives is not translated; a fresh one is", async (t) => {
  const nowSec = 1_790_000_000;
  t.mock.timers.enable({ apis: ["Date"], now: nowSec * 1000 });
  const cases: Array<[string, unknown, boolean]> = [
    ["10 minutes old", nowSec - 600, true],
    ["301 s old", nowSec - 301, true],
    ["exactly 5 minutes old", nowSec - 300, false],
    ["299 s old", nowSec - 299, false],
    ["a minute in the future", nowSec + 60, false],
    ["ten minutes in the future", nowSec + 600, false],
    ["zero", 0, false],
    ["missing", undefined, false],
    ["null", null, false],
    ["NaN", NaN, false],
    ["not a number", "x", false],
    ["negative", -5, false],
  ];
  for (const [label, timestamp, late] of cases) {
    const { hook, replies } = await translatingHook();
    const result = await hook(engineCtx({ body: "hello world", timestamp: timestamp as number }));
    assert.equal(result.continue, true, `${label}: conversation is passed on`);
    assert.equal(replies.length, late ? 0 : 1, `${label}: ${late ? "late, not" : "fresh, so"} translated`);
  }
});

test("a late /tr command is still claimed, but not run", async () => {
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
          announced: true,
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

  const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
  const result = await getHook()!(engineCtx({ body: "/tr on", timestamp: tenMinutesAgo }));
  assert.equal(result.continue, false, "no other bot answers a control message addressed to this plugin");
  await settle();
  assert.deepEqual(sent, [], "the command is not run, so no confirmation is posted");
});
