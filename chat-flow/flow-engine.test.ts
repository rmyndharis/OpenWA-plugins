import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginContext } from '../types/openwa';
import { FlowEngine, SessionFlow } from './flow-engine.ts';

function makeCtx() {
  const storage = new Map<string, unknown>();
  const replies: Array<{ sessionId: string; chatId: string; quoted: string; text: string }> = [];
  const ctx = {
    storage: {
      get: async (k: string) => (storage.has(k) ? storage.get(k) : null),
      set: async (k: string, v: unknown) => { storage.set(k, v); },
      delete: async (k: string) => { storage.delete(k); },
      list: async () => [...storage.keys()],
    },
    messages: {
      reply: async (sessionId: string, chatId: string, quoted: string, text: string) => {
        replies.push({ sessionId, chatId, quoted, text });
        return { messageId: 'r', timestamp: 0 };
      },
      sendText: async () => ({ messageId: 'r', timestamp: 0 }),
    },
    logger: { log() {}, debug() {}, warn() {}, error() {} },
  } as unknown as PluginContext;
  return { ctx, storage, replies };
}

const abc: SessionFlow = {
  trigger: 'hi',
  greeting: 'abc menu: 1. hosting 2. domina',
  options: { '1': { text: 'hosting https://abc.com' }, '2': { text: 'domina https://abc.com/domina' } },
};
const xyz: SessionFlow = {
  trigger: '', // any message triggers
  greeting: 'xyz menu: 1. blog 2. support',
  options: {
    '1': { text: 'blog https://xyz.com/blog' },
    '2': { text: 'support https://xyz.com/support', options: { '1': { text: 'support ticket created' } } },
  },
};
const key = 'state__abc-company__user1';

test('triggers greeting on trigger word (case-insensitive, trimmed)', async () => {
  const { ctx, storage, replies } = makeCtx();
  const r = await FlowEngine.processMessage(ctx, abc, 'abc-company', 'user1', '  HI  ', 'm1');
  assert.equal(r, true);
  assert.equal(replies[0].text, abc.greeting);
  assert.deepEqual((storage.get(key) as { path: string[] }).path, []);
});

test('does not trigger if input does not match a non-empty trigger', async () => {
  const { ctx, storage, replies } = makeCtx();
  const r = await FlowEngine.processMessage(ctx, abc, 'abc-company', 'user1', 'something else', 'm1');
  assert.equal(r, false);
  assert.equal(replies.length, 0);
  assert.equal(storage.has(key), false);
});

test('empty trigger: any message starts the flow', async () => {
  const { ctx, replies } = makeCtx();
  const r = await FlowEngine.processMessage(ctx, xyz, 'xyz', 'user1', 'anything', 'm1');
  assert.equal(r, true);
  assert.equal(replies[0].text, xyz.greeting);
});

test('selecting a leaf option replies and ends the flow', async () => {
  const { ctx, storage, replies } = makeCtx();
  await FlowEngine.processMessage(ctx, abc, 'abc-company', 'user1', 'hi', 'm1');
  const r = await FlowEngine.processMessage(ctx, abc, 'abc-company', 'user1', '1', 'm2');
  assert.equal(r, true);
  assert.equal(replies.at(-1)!.text, 'hosting https://abc.com');
  assert.equal(storage.has(key), false); // leaf → state cleared
});

test('selecting a non-leaf saves path, then its child leaf ends the flow', async () => {
  const { ctx, storage, replies } = makeCtx();
  await FlowEngine.processMessage(ctx, xyz, 'xyz', 'user1', 'hello', 'm1');
  await FlowEngine.processMessage(ctx, xyz, 'xyz', 'user1', '2', 'm2');
  assert.equal(replies.at(-1)!.text, 'support https://xyz.com/support');
  assert.deepEqual((storage.get('state__xyz__user1') as { path: string[] }).path, ['2']);
  const r = await FlowEngine.processMessage(ctx, xyz, 'xyz', 'user1', '1', 'm3');
  assert.equal(r, true);
  assert.equal(replies.at(-1)!.text, 'support ticket created');
  assert.equal(storage.has('state__xyz__user1'), false);
});

test('invalid option replies with fallback and retains state', async () => {
  const { ctx, storage, replies } = makeCtx();
  await FlowEngine.processMessage(ctx, abc, 'abc-company', 'user1', 'hi', 'm1');
  const r = await FlowEngine.processMessage(ctx, abc, 'abc-company', 'user1', '99', 'm2');
  assert.equal(r, true);
  assert.equal(replies.at(-1)!.text, `Invalid option. Please choose one of the available options:\n\n${abc.greeting}`);
  assert.deepEqual((storage.get(key) as { path: string[] }).path, []);
});

test('trigger word during an active flow restarts it', async () => {
  const { ctx, storage, replies } = makeCtx();
  await FlowEngine.processMessage(ctx, abc, 'abc-company', 'user1', 'hi', 'm1');
  (storage.get(key) as { path: string[] }).path = ['1']; // simulate progress
  const r = await FlowEngine.processMessage(ctx, abc, 'abc-company', 'user1', 'hi', 'm2');
  assert.equal(r, true);
  assert.equal(replies.at(-1)!.text, abc.greeting);
  assert.deepEqual((storage.get(key) as { path: string[] }).path, []);
});

test('expired state is cleared and a non-trigger input is ignored', async () => {
  const { ctx, storage, replies } = makeCtx();
  // Seed state directly so no initial greeting reply is added to `replies`.
  storage.set(key, { path: [], lastActive: Date.now() - 20 * 60 * 1000 });
  const r = await FlowEngine.processMessage(ctx, abc, 'abc-company', 'user1', '1', 'm2');
  assert.equal(r, false);
  assert.equal(replies.length, 0);
  assert.equal(storage.has(key), false);
});

test('invalid stored path is reset and re-processed once (bounded)', async () => {
  // empty-trigger flow → after reset, the re-process starts a fresh flow (greeting), terminating.
  const { ctx, storage, replies } = makeCtx();
  storage.set('state__xyz__user1', { path: ['nonexistent'], lastActive: Date.now() });
  const r = await FlowEngine.processMessage(ctx, xyz, 'xyz', 'user1', 'whatever', 'm1');
  assert.equal(r, true);
  assert.equal(replies.length, 1); // exactly one greeting — proves the recursion is bounded
  assert.equal(replies[0].text, xyz.greeting);
});

test('invalid stored path with a non-trigger input resets and stops (bounded)', async () => {
  const { ctx, storage, replies } = makeCtx();
  storage.set(key, { path: ['nonexistent'], lastActive: Date.now() });
  const r = await FlowEngine.processMessage(ctx, abc, 'abc-company', 'user1', 'x', 'm1');
  assert.equal(r, false);
  assert.equal(replies.length, 0);
  assert.equal(storage.has(key), false);
});

test('concurrent messages for the same chat are serialized (greeting sent once)', async () => {
  const { ctx, replies } = makeCtx();
  // Two messages racing on a fresh chat: without serialization both read "no state" and both greet.
  await Promise.all([
    FlowEngine.processMessage(ctx, xyz, 'xyz', 'user1', 'hello', 'm1'),
    FlowEngine.processMessage(ctx, xyz, 'xyz', 'user1', 'hello', 'm2'),
  ]);
  const greetings = replies.filter(r => r.text === xyz.greeting).length;
  assert.equal(greetings, 1, 'the greeting must be sent once; a load/save race would send it twice');
});

test('a stored path landing on a now-leaf node ends the flow instead of looping invalid-option', async () => {
  const { ctx, storage, replies } = makeCtx();
  // Config changed under the user: they are parked at option "1", which is a leaf with no sub-options.
  // The old behaviour re-saved state and replied "Invalid option" forever; it must now end cleanly.
  storage.set('state__xyz__user1', { path: ['1'], lastActive: Date.now() });
  const r = await FlowEngine.processMessage(ctx, xyz, 'xyz', 'user1', 'anything', 'm1');
  assert.equal(r, false);
  assert.equal(storage.has('state__xyz__user1'), false);
  assert.equal(replies.length, 0);
});

test('a prototype-property name as input is an invalid option, never a false match', async () => {
  // `abc.options` is a plain object, so a bare `options["constructor"]` would resolve to the inherited
  // Object constructor (truthy) and reply with `nextNode.text === undefined`. Object.hasOwn prevents that.
  for (const evil of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    const { ctx, storage, replies } = makeCtx();
    await FlowEngine.processMessage(ctx, abc, 'abc-company', 'user1', 'hi', 'm1'); // start the flow
    replies.length = 0;
    const r = await FlowEngine.processMessage(ctx, abc, 'abc-company', 'user1', evil, 'm2');
    assert.equal(r, true, `${evil} should be handled`);
    assert.equal(replies.length, 1, `${evil} should yield exactly one reply`);
    assert.equal(
      replies[0].text,
      `Invalid option. Please choose one of the available options:\n\n${abc.greeting}`,
      `${evil} should get the invalid-option fallback`,
    );
    assert.deepEqual((storage.get(key) as { path: string[] }).path, [], `${evil} keeps the flow active`);
  }
});
