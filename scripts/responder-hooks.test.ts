import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import AfterHours from '../after-hours/index.ts';
import FaqBot from '../faq-bot/index.ts';
import ChatFlow from '../chat-flow/index.ts';
import type { HookHandler, IPlugin, PluginContext } from '../types/openwa';

const cases: Array<[string, new () => IPlugin, Record<string, unknown>]> = [
  ['after-hours', AfterHours, { schedule: '{"thu":"09:00-17:00"}', timezone: 'UTC', awayMessage: 'Closed' }],
  ['faq-bot', FaqBot, { rules: '[{"mode":"contains","pattern":"hello","reply":"Hello"}]' }],
  ['chat-flow', ChatFlow, { greeting: 'Choose', trigger: 'hello', options: [{ key: '1', text: 'Done' }] }],
];

for (const [name, Plugin, config] of cases) {
  test(`${name} claims a message before a pending reply completes`, async () => {
    mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    let release!: () => void;
    let fail!: (error: Error) => void;
    const sending = new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
    const sent: string[] = [];
    const errors: unknown[] = [];
    const rows = new Map<string, unknown>();
    let handler!: HookHandler;
    const ctx = {
      config,
      logger: { log() {}, debug() {}, warn() {}, error: (_message: string, error: unknown) => errors.push(error) },
      registerHook: (_event: string, h: HookHandler) => { handler = h; },
      storage: {
        get: async (key: string) => rows.get(key) ?? null,
        set: async (key: string, value: unknown) => void rows.set(key, structuredClone(value)),
        delete: async (key: string) => void rows.delete(key),
        list: async () => [...rows.keys()],
      },
      messages: { reply: async (_s: string, _c: string, id: string) => {
        sent.push(id);
        if (id === 'm1') await sending;
        return { messageId: 'sent', timestamp: 0 };
      } },
    } as unknown as PluginContext;
    const plugin = new Plugin();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await plugin.onEnable!(ctx);
      const fire = (id: string, body: string) => handler({
        event: 'message:received', source: 'Engine', sessionId: name, timestamp: new Date(),
        data: { id, body, chatId: '123@c.us', type: 'text', fromMe: false, isGroup: false },
      });
      const result = await Promise.race([
        fire('m1', 'hello'),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error('hook waited for the send')), 100);
        }),
      ]);
      assert.equal(result.continue, false);
      assert.deepEqual(sent, ['m1']);
      if (name === 'chat-flow') {
        assert.equal((await fire('m2', '1')).continue, false);
        assert.deepEqual(sent, ['m1'], 'the second send waits for the greeting');
      }
      const failure = new Error('send failed after the hook returned');
      fail(failure);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.deepEqual(errors, [failure]);
      if (name === 'chat-flow') assert.deepEqual(sent, ['m1', 'm2']);
    } finally {
      clearTimeout(deadline);
      release();
      await plugin.onDisable?.(ctx);
      await plugin.onUnload?.(ctx);
      mock.timers.reset();
    }
  });
}

const completions: Array<{
  name: string; Plugin: new () => IPlugin; config: Record<string, unknown>;
  delay: number; firstFails: boolean; secondFails: boolean; expectedSends: number;
}> = [
  { name: 'FAQ matched cooldown', Plugin: FaqBot, config: cases[1][2], delay: 11_000, firstFails: true, secondFails: false, expectedSends: 2 },
  { name: 'FAQ fallback cooldown', Plugin: FaqBot, config: { rules: '[{"mode":"exact","pattern":"other","reply":"Other"}]', fallbackReply: 'Fallback', fallbackCooldownSec: 1 }, delay: 2_000, firstFails: true, secondFails: false, expectedSends: 2 },
  { name: 'away failure backoff', Plugin: AfterHours, config: { ...cases[0][2], cooldownSec: 1 }, delay: 2_000, firstFails: false, secondFails: true, expectedSends: 2 },
  { name: 'away zero-cooldown backoff', Plugin: AfterHours, config: { ...cases[0][2], cooldownSec: 0 }, delay: 0, firstFails: false, secondFails: true, expectedSends: 2 },
  { name: 'away successful retry', Plugin: AfterHours, config: { ...cases[0][2], cooldownSec: 1 }, delay: 2_000, firstFails: true, secondFails: false, expectedSends: 3 },
];

for (const scenario of completions) {
  test(`${scenario.name} survives an older send completing later`, async () => {
    mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    let release!: () => void;
    let fail!: (error: Error) => void;
    const pending = new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
    const sent: string[] = [];
    let handler!: HookHandler;
    const ctx = {
      config: scenario.config,
      registerHook: (_event: string, h: HookHandler) => { handler = h; },
      logger: { log() {}, debug() {}, warn() {}, error() {} },
      messages: { reply: async (_s: string, _c: string, id: string) => {
        sent.push(id);
        if (id === 'first') await pending;
        if (id === 'second' && scenario.secondFails) throw new Error('new send failed');
        return { messageId: 'sent', timestamp: 0 };
      } },
    } as unknown as PluginContext;
    try {
      const plugin = new scenario.Plugin();
      await plugin.onEnable!(ctx);
      const fire = (id: string) => handler({
        event: 'message:received', source: 'Engine', sessionId: 's1', timestamp: new Date(),
        data: { id, body: 'hello', chatId: '123@c.us', type: 'text', fromMe: false, isGroup: false },
      });
      await fire('first');
      mock.timers.tick(scenario.delay);
      await fire('second');
      if (scenario.firstFails) fail(new Error('old send failed'));
      else release();
      await new Promise<void>(resolve => setImmediate(resolve));
      if (scenario.expectedSends === 3) mock.timers.tick(2_000);
      await fire('third');
      assert.equal(sent.length, scenario.expectedSends, 'old completion must not change the latest cooldown or backoff');
    } finally {
      release();
      await new Promise<void>(resolve => setImmediate(resolve));
      mock.timers.reset();
    }
  });
}
