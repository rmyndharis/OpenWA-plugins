import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRules, matchRule } from './rules.ts';

const ok = JSON.stringify([
  { mode: 'contains', pattern: 'harga', reply: 'Harga mulai 100rb' },
  { mode: 'exact', pattern: 'menu', reply: 'Menu: 1) Harga 2) Jam' },
  { mode: 'regex', pattern: '^/start', reply: 'Selamat datang' },
]);

test('parseRules rejects non-JSON, non-array, and empty', () => {
  assert.throws(() => parseRules('not json'));
  assert.throws(() => parseRules('{}'), /array/i);
  assert.throws(() => parseRules('[]'), /no usable/i);
});

test('parseRules rejects a rule with a bad mode or empty pattern/reply', () => {
  assert.throws(() => parseRules(JSON.stringify([{ mode: 'nope', pattern: 'x', reply: 'y' }])), /mode/i);
  assert.throws(() => parseRules(JSON.stringify([{ mode: 'contains', pattern: '', reply: 'y' }])), /pattern/i);
  assert.throws(() => parseRules(JSON.stringify([{ mode: 'contains', pattern: 'x', reply: '' }])), /reply/i);
});

test('parseRules skips an invalid regex but keeps valid rules', () => {
  const { rules, skipped } = parseRules(
    JSON.stringify([
      { mode: 'regex', pattern: '(', reply: 'bad' },
      { mode: 'contains', pattern: 'hi', reply: 'hello' },
    ]),
  );
  assert.equal(rules.length, 1);
  assert.deepEqual(skipped, ['(']);
});

test('parseRules skips a catastrophic-backtracking regex (nested unbounded quantifiers)', () => {
  const { rules, skipped } = parseRules(
    JSON.stringify([
      { mode: 'regex', pattern: '(a+)+$', reply: 'evil' },
      { mode: 'regex', pattern: '(\\w+\\s?)*$', reply: 'evil2' },
      { mode: 'contains', pattern: 'hi', reply: 'hello' },
    ]),
  );
  assert.equal(rules.length, 1);
  assert.deepEqual(skipped, ['(a+)+$', '(\\w+\\s?)*$']);
});

test('parseRules keeps safe regexes (single/non-nested quantifiers, lookahead)', () => {
  const { rules, skipped } = parseRules(
    JSON.stringify([
      { mode: 'regex', pattern: '^/start', reply: 'a' },
      { mode: 'regex', pattern: '(abc)+', reply: 'b' },
      { mode: 'regex', pattern: '\\d{2,5}', reply: 'c' },
      { mode: 'regex', pattern: 'a*b*c*', reply: 'd' },
      { mode: 'regex', pattern: '(?=.*foo)', reply: 'e' },
    ]),
  );
  assert.equal(skipped.length, 0);
  assert.equal(rules.length, 5);
  assert.equal(matchRule(rules, 'abcabc')?.reply, 'b');
});

test('matchRule: contains is case-insensitive substring; no match returns null', () => {
  const { rules } = parseRules(ok);
  assert.equal(matchRule(rules, 'Brp HARGAnya?')?.reply, 'Harga mulai 100rb');
  assert.equal(matchRule(rules, 'apa kabar'), null);
});

test('matchRule: exact trims + case-insensitive; regex uses the i flag', () => {
  const { rules } = parseRules(ok);
  assert.equal(matchRule(rules, '  MENU ')?.reply, 'Menu: 1) Harga 2) Jam');
  assert.equal(matchRule(rules, '/START now')?.reply, 'Selamat datang');
  assert.equal(matchRule(rules, 'nothing here'), null);
});
