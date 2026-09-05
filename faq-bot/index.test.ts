import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from './index.ts';
import { allowCooldown as allowFallback } from './cooldown.ts';

const rules = JSON.stringify([{ mode: 'contains', pattern: 'hi', reply: 'hello' }]);

// Minimal ctx builder shared by the two tests below. The file's regression test further down builds its
// own inline ctx (it needs a live `config` getter); this one only needs static overrides.
function makeCtx(overrides: {
  config?: Record<string, unknown>;
  registerHook?: (event: string, handler: unknown, priority?: number) => void;
  reply?: (sessionId: string, chatId: string, quoted: string, text: string) => Promise<{ messageId: string; timestamp: number }>;
} = {}) {
  return {
    config: overrides.config ?? { rules },
    logger: { log() {}, debug() {}, warn() {}, error() {} },
    registerHook: overrides.registerHook ?? (() => {}),
    messages: {
      reply: overrides.reply ?? (async () => ({ messageId: 'x', timestamp: 0 })),
      sendText: async () => ({ messageId: 'x', timestamp: 0 }),
    },
  };
}

// Enables a fresh FaqBot with the given (rule-array) config, fires one message:received carrying `body`,
// and returns the {continue} result the host would see. `rules` is stringified here (not by the caller)
// so the test data reads as the plugin's rule objects, not the wire-format JSON string ctx.config expects.
// `onReply` receives every text the plugin actually sent, so a test can tell "claimed after replying"
// from "claimed without replying" — the two are indistinguishable from the {continue} value alone.
async function runHook(
  config: { rules: Array<{ mode: string; pattern: string; reply: string }> } & Record<string, unknown>,
  body: string,
  onReply?: (text: string) => void,
  type = 'text',
) {
  const { rules: ruleList, ...rest } = config;
  let handler: ((hook: unknown) => Promise<{ continue: boolean }>) | undefined;
  const ctx = makeCtx({
    config: { ...rest, rules: JSON.stringify(ruleList) },
    registerHook: (_e, h) => { handler = h as (hook: unknown) => Promise<{ continue: boolean }>; },
    reply: async (_s, _c, _q, text) => { onReply?.(text); return { messageId: 'x', timestamp: 0 }; },
  });
  const { default: FaqBot } = await import('./index.ts');
  await new FaqBot().onEnable(ctx as never);
  return handler!({
    source: 'Engine', sessionId: 's1', timestamp: new Date(),
    data: { id: 'm1', chatId: config.chatId ?? 'c@x', body, type, fromMe: false, isGroup: false },
  });
}

// A shared contact card and a poll carry real text in `body` from host 0.23.2 on, so a non-empty body
// is no longer proof a human typed something at this bot. A vCard is free text and matches ordinary
// rules readily; `fallbackReply` would answer one and claim the event from a plugin that handles media.
const VCARD = 'BEGIN:VCARD\nVERSION:3.0\nFN:Budi Santoso\nORG:Toko Berkah\nTEL;TYPE=CELL:+628123456789\nEND:VCARD';

test('a shared contact card never matches a rule and never claims the message', async () => {
  const replies: string[] = [];
  const rules = [{ mode: 'contains', pattern: 'toko', reply: 'Which store?' }];
  const matchedAsText = await runHook({ rules }, VCARD, t => replies.push(t));
  assert.equal(matchedAsText.continue, false, 'guard rail: as plain text this vCard DOES match the rule');

  replies.length = 0;
  const asContact = await runHook({ rules }, VCARD, t => replies.push(t), 'contact');
  assert.equal(asContact.continue, true, 'a contact card must pass down the chain');
  assert.deepEqual(replies, [], 'and must draw no reply');
});

test('a poll question never draws the fallback reply', async () => {
  const replies: string[] = [];
  const cfg = { rules: [{ mode: 'contains', pattern: 'xyzzy', reply: 'hit' }], fallbackReply: 'I did not understand' };
  const asPoll = await runHook(cfg, 'Where should we eat on Friday?', t => replies.push(t), 'poll');
  assert.equal(asPoll.continue, true, 'a poll must pass down the chain');
  assert.deepEqual(replies, [], 'the fallback must not answer a poll');
});

test('a business button reply is still answered: type unknown stays admitted', async () => {
  const replies: string[] = [];
  const rules = [{ mode: 'exact', pattern: 'Order status', reply: 'Order 123 is on the way' }];
  const tapped = await runHook({ rules }, 'Order status', t => replies.push(t), 'unknown');
  assert.equal(tapped.continue, false, 'a tapped button is real user input and must be answered');
  assert.deepEqual(replies, ['Order 123 is on the way']);
});

// Responder band (PLUGIN-STANDARD.md "Co-installation"): keyword rules are more specific than a bot that
// answers everything, less specific than a command prefix.
test('registers at the faq-bot responder priority', async () => {
  let priority: number | undefined;
  const ctx = makeCtx({ registerHook: (_e, _h, p) => { priority = p; } });
  const { default: FaqBot } = await import('./index.ts');
  await new FaqBot().onEnable(ctx as never);
  assert.equal(priority, 80);
});

test('claims the message when a rule answered it, passes it on when nothing matched', async () => {
  const answered = await runHook({ rules: [{ mode: 'contains', pattern: 'hi', reply: 'hello' }] }, 'hi there');
  assert.equal(answered.continue, false, 'a rule replied — no other bot should answer too');

  const unmatched = await runHook({ rules: [{ mode: 'contains', pattern: 'hi', reply: 'hello' }] }, 'unrelated');
  assert.equal(unmatched.continue, true, 'nothing was sent — the chain must continue');
});

// The fallback is the path PLUGIN-STANDARD.md's "Known interactions" section publishes a guarantee
// about: it is what makes faq-bot able to take a message away from `after-hours`. Assert BOTH halves —
// a fallback that claimed without having sent anything would silence the chat with nothing to show for it.
test('an unmatched message claims when the fallback answered it', async () => {
  const sent: string[] = [];
  const result = await runHook(
    { rules: [{ mode: 'contains', pattern: 'hi', reply: 'hello' }], fallbackReply: 'Maaf, belum paham.' },
    'unrelated', // no rule matches, so the fallback is the only thing that can answer
    text => sent.push(text),
  );
  assert.deepEqual(sent, ['Maaf, belum paham.'], 'the fallback was actually delivered');
  assert.equal(result.continue, false, 'the fallback answered — no other bot should answer too');
});

// A send that throws delivers nothing. Claiming it anyway would silence the chat entirely — every later
// plugin sees a message that was "handled" when in fact no reply ever reached the contact.
test('a reply that throws does not claim the message', async () => {
  let handler: ((hook: unknown) => Promise<{ continue: boolean }>) | undefined;
  const ctx = makeCtx({
    config: { rules },
    registerHook: (_e, h) => { handler = h as (hook: unknown) => Promise<{ continue: boolean }>; },
    reply: async () => { throw new Error('blocked by plugin'); },
  });
  const { default: FaqBot } = await import('./index.ts');
  await new FaqBot().onEnable(ctx as never);
  const result = await handler!({
    source: 'Engine', sessionId: 's1', timestamp: new Date(),
    data: { id: 'm1', chatId: 'c@x', body: 'hi there', fromMe: false, isGroup: false },
  });
  assert.equal(result.continue, true, 'the send failed — a later plugin may still have an answer');
});

test('parseConfig requires rules', () => {
  assert.throws(() => parseConfig({}), /rules is required/);
  assert.throws(() => parseConfig({ rules: '   ' }), /rules is required/);
});

test('parseConfig surfaces a rules error with the faq-bot prefix', () => {
  assert.throws(() => parseConfig({ rules: 'not json' }), /faq-bot: invalid rules/);
});

test('parseConfig parses rules and applies option defaults', () => {
  const { config, rules: parsed } = parseConfig({ rules });
  assert.equal(parsed.length, 1);
  assert.equal(config.fallbackReply, '');
  assert.equal(config.fallbackCooldownSec, 600);
  assert.equal(config.respondInGroups, false);
});

test('parseConfig reads provided options', () => {
  const { config } = parseConfig({ rules, fallbackReply: 'Maaf', fallbackCooldownSec: 30, respondInGroups: true });
  assert.equal(config.fallbackReply, 'Maaf');
  assert.equal(config.fallbackCooldownSec, 30);
  assert.equal(config.respondInGroups, true);
});

test('allowFallback enforces the per-chat cooldown window', () => {
  const map = new Map<string, number>();
  assert.equal(allowFallback(map, 'c1', 1000, 60000), true); // first time
  assert.equal(allowFallback(map, 'c1', 1000 + 59999, 60000), false); // within window
  assert.equal(allowFallback(map, 'c1', 1000 + 60000, 60000), true); // window elapsed
  assert.equal(allowFallback(map, 'c2', 0, 0), true); // cooldown 0 => always
  assert.equal(allowFallback(map, 'c2', 0, 0), true);
});

test('parseConfig falls back to 600 when fallbackCooldownSec is not a finite number', () => {
  const rules = JSON.stringify([{ mode: 'contains', pattern: 'hi', reply: 'hello' }]);
  assert.equal(parseConfig({ rules, fallbackCooldownSec: 'abc' }).config.fallbackCooldownSec, 600);
});

test('allowFallback caps the map at 5000 entries, dropping the oldest', () => {
  const map = new Map<string, number>();
  for (let i = 0; i < 5001; i++) allowFallback(map, `chat-${i}`, i, 60000);
  assert.equal(map.size, 5000);
  assert.equal(map.has('chat-0'), false); // oldest evicted
  assert.equal(map.has('chat-5000'), true); // newest kept
});

test('allowFallback eviction is recency-aware: re-touching a key protects it from eviction', () => {
  const map = new Map<string, number>();
  for (let i = 0; i < 5000; i++) allowFallback(map, `chat-${i}`, i, 0);
  allowFallback(map, 'chat-0', 10000, 0); // re-touch -> most recently used
  allowFallback(map, 'chat-new', 10001, 0); // overflow -> evict genuinely-oldest
  assert.equal(map.size, 5000);
  assert.equal(map.has('chat-0'), true); // protected by recent touch
  assert.equal(map.has('chat-1'), false); // now the oldest, evicted
});

// Regression: the message hook must re-read ctx.config per event (not a snapshot cached at enable) so a
// per-session override resolved by the host for the firing session is honored. We prove it by corrupting
// the config post-enable and asserting the hook warns + skips (a cached snapshot would hold the valid
// enable-time value and try to match rules that no longer exist).
test('onMessage re-reads ctx.config per event (per-session config is not cached at enable)', async () => {
  let liveConfig: Record<string, unknown> = { rules: JSON.stringify([{ mode: 'contains', pattern: 'hi', reply: 'hello' }]) };
  const warnings: string[] = [];
  let registered = false;
  let handler: (hook: any) => Promise<void> = async () => {}; // default no-op; overwritten on registerHook
  const ctx: any = {
    get config() { return liveConfig; }, // simulate the host's per-session getter
    logger: { log() {}, debug() {}, warn: (m: string) => warnings.push(m), error() {} },
    registerHook: (_e: string, h: any) => { handler = h; registered = true; },
    messages: { reply: async () => ({ messageId: '', timestamp: 0 }), sendText: async () => ({ messageId: '', timestamp: 0 }) },
  };
  const { default: FaqBot } = await import('./index.ts');
  const plugin = new FaqBot();
  await plugin.onEnable(ctx);
  assert.ok(registered, 'hook registered');

  // Corrupt the config AFTER enable. A snapshot cached at enable would not see this; a per-event read does.
  liveConfig = { rules: 'NOT JSON' };
  await handler({ source: 'Engine', sessionId: 's1', timestamp: new Date(),
    data: { id: 'm1', chatId: 'c@x', body: 'hi', fromMe: false, isGroup: false } });
  assert.ok(warnings.some(w => /config invalid/.test(w)), 'corrupted post-enable config was re-read and warned');
});

test('a message with no text is left alone', async () => {
  // A sticker, image or voice note arrives with an empty body — no rule matches, so the fallback fired
  // and answered a picture with "sorry, I did not understand". Returning true also claims the event, so
  // a later plugin that could handle media never saw it.
  const replied: string[] = [];
  const res = await runHook(
    { rules: [{ mode: 'contains', pattern: 'hi', reply: 'hello' }], fallbackReply: 'tidak paham' },
    '   ',
    (t) => replied.push(t),
  );
  assert.deepEqual(replied, [], 'a message with no text must not draw a fallback');
  assert.equal(res.continue, true, 'and must not be claimed');
});

test('a failed fallback send releases the cooldown slot instead of silencing the chat', async () => {
  // The slot is claimed before the send. When the send throws, the window was spent anyway, so the chat
  // stayed silent for the whole cooldown over a reply that never arrived.
  const { default: FaqBot } = await import('./index.ts');
  let failNext = true;
  let delivered = 0;
  let handler: ((h: unknown) => Promise<{ continue: boolean }>) | undefined;
  const ctx = makeCtx({
    config: { rules: JSON.stringify([{ mode: 'contains', pattern: 'hi', reply: 'hello' }]), fallbackReply: 'tidak paham', fallbackCooldownSec: 600 },
    registerHook: (_e, h) => { handler = h as (h2: unknown) => Promise<{ continue: boolean }>; },
    reply: async () => {
      if (failNext) throw new Error('send failed');
      delivered++;
      return { messageId: 'x', timestamp: 0 };
    },
  });
  await new FaqBot().onEnable(ctx as never);
  const fire = (id: string) => handler!({
    source: 'Engine', sessionId: 's1', timestamp: new Date(),
    data: { id, chatId: 'c@x', body: 'apa kabar', fromMe: false, isGroup: false },
  });

  await fire('m1');           // send throws; the slot must not stay burnt
  failNext = false;
  await fire('m2');
  assert.equal(delivered, 1, 'the next message must be able to retry the fallback');
});

test('the same repeated text is answered once, but different questions are all answered', async () => {
  // A rule whose reply matches its own pattern is a fixed point, and an autoresponder on the other end
  // then answers each of this plugin's replies forever, repeating one canned message. The throttle is
  // keyed on that repeated TEXT, not on the rule: keying on the rule would silence a customer's second,
  // genuinely different question whenever it happened to match the same rule, which costs more than the
  // loop it prevents.
  const rules = [
    { mode: 'contains', pattern: 'harga', reply: 'Harga mulai 50rb' },
    { mode: 'contains', pattern: 'jam', reply: 'Buka 09.00-17.00' },
  ];
  const sent: string[] = [];
  let handler: ((h: unknown) => Promise<{ continue: boolean }>) | undefined;
  const ctx = makeCtx({
    config: { rules: JSON.stringify(rules) },
    registerHook: (_e, h) => { handler = h as (hook: unknown) => Promise<{ continue: boolean }>; },
    reply: async (_s, _c, _q, text) => { sent.push(text); return { messageId: 'x', timestamp: 0 }; },
  });
  const { default: FaqBot } = await import('./index.ts');
  await new FaqBot().onEnable(ctx as never);
  const fire = (body: string, id: string) =>
    handler!({ source: 'Engine', sessionId: 's1', timestamp: new Date(),
               data: { id, chatId: 'c@x', body, type: 'text', fromMe: false, isGroup: false } });

  // The loop shape: one canned message arriving over and over.
  const canned = 'Terima kasih, cek harga di katalog kami';
  const first = await fire(canned, 'm1');
  await fire(canned, 'm2');
  await fire(canned, 'm3');
  assert.equal(first.continue, false, 'a matched message is claimed');
  assert.deepEqual(sent, ['Harga mulai 50rb'], 'the repeat is answered once, so the exchange cannot run away');

  // Two DIFFERENT customer questions that both match the `harga` rule must both be answered.
  await fire('berapa harga paket A?', 'm4');
  await fire('kalau harga paket B?', 'm5');
  assert.deepEqual(
    sent,
    ['Harga mulai 50rb', 'Harga mulai 50rb', 'Harga mulai 50rb'],
    'a different question matching the same rule is still answered',
  );

  await fire('jam berapa buka', 'm6');
  assert.equal(sent.length, 4, 'and a different rule is unaffected');
});

test('a channel or broadcast post never draws an FAQ reply', async () => {
  // A `@newsletter` post arrives flagged as a non-group chat, so the only chat-scope gate let it
  // through and a followed channel whose post happened to match a keyword drew a reply into a chat
  // the account can never post to.
  const rules = [{ mode: 'contains', pattern: 'promo', reply: 'Here is the promo' }];
  const replies: string[] = [];
  for (const chatId of ['120363000000000000@newsletter', '628123-456@broadcast', 'status@broadcast']) {
    const r = await runHook({ rules, chatId }, 'promo hari ini', (t) => replies.push(t));
    assert.deepEqual(r, { continue: true }, `${chatId} must not be claimed`);
  }
  // assert.equal on the length, not deepEqual against []: node:assert/strict's deepEqual is an
  // `asserts actual is T` guard, so comparing to a literal [] narrows `replies` to never[] and the
  // guard-rail push below stops compiling.
  assert.equal(replies.length, 0, 'nothing may be sent into a channel or broadcast chat');
  // Guard rail: the same body in a real chat still answers.
  await runHook({ rules, chatId: '628123456789@c.us' }, 'promo hari ini', (t) => replies.push(t));
  assert.deepEqual(replies, ['Here is the promo']);
});
