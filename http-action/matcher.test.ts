import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchAction, parseArgs } from './matcher.ts';
import type { HttpAction } from './config.ts';

const mk = (match: { type?: 'exact' | 'prefix'; value: string; caseSensitive?: boolean }, id = 'a'): HttpAction => ({
  id,
  match: { type: match.type ?? 'prefix', value: match.value, caseSensitive: match.caseSensitive ?? false },
  request: { method: 'GET', path: '/x' },
  replyTemplate: 'r',
});

test('prefix match returns the action + the trailing args', () => {
  const out = matchAction([mk({ value: 'cek-order ' })], 'cek-order INV-001');
  assert.ok(out);
  assert.equal(out!.action.id, 'a');
  assert.deepEqual(out!.args, ['INV-001']);
});

test('exact match returns the action with empty args', () => {
  const out = matchAction([mk({ type: 'exact', value: 'ping' })], 'ping');
  assert.ok(out);
  assert.deepEqual(out!.args, []);
});

test('exact does not match when there is trailing text', () => {
  assert.equal(matchAction([mk({ type: 'exact', value: 'ping' })], 'ping extra'), null);
});

test('no match returns null (silent)', () => {
  assert.equal(matchAction([mk({ value: 'cek-order ' })], 'hello world'), null);
});

test('prefix is case-insensitive by default, but args keep their original case', () => {
  const out = matchAction([mk({ value: 'cek-order ' })], 'CEK-ORDER InvX');
  assert.ok(out);
  assert.deepEqual(out!.args, ['InvX']);
});

test('caseSensitive prefix blocks mismatched case', () => {
  assert.equal(matchAction([mk({ value: 'cek-order ', caseSensitive: true })], 'CEK-ORDER x'), null);
});

test('first matching action wins (config order)', () => {
  const a = mk({ value: 'cek ' }, 'first');
  const b = mk({ value: 'cek ' }, 'second');
  const out = matchAction([a, b], 'cek x');
  assert.equal(out!.action.id, 'first');
});

test('quoted arg is kept as one token', () => {
  assert.deepEqual(parseArgs('"INV 001" note'), ['INV 001', 'note']);
  const out = matchAction([mk({ value: 'cek ' })], 'cek "INV 001"');
  assert.deepEqual(out!.args, ['INV 001']);
});

test('double spaces between tokens are stable', () => {
  assert.deepEqual(parseArgs('a  b'), ['a', 'b']);
  const out = matchAction([mk({ value: 'cek ' })], 'cek  a');
  assert.deepEqual(out!.args, ['a']);
});

test('prefix with empty remainder yields empty args', () => {
  const out = matchAction([mk({ value: 'cek ' })], 'cek ');
  assert.ok(out);
  assert.deepEqual(out!.args, []);
});
