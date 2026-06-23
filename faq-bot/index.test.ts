import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, allowFallback } from './index.ts';

const rules = JSON.stringify([{ mode: 'contains', pattern: 'hi', reply: 'hello' }]);

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
