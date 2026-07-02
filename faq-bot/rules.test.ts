import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRules, matchRule } from './rules.ts';

const ok = JSON.stringify([
  { mode: 'contains', pattern: 'harga', reply: 'Harga mulai 100rb' },
  { mode: 'exact', pattern: 'menu', reply: 'Menu: 1) Harga 2) Jam' },
  { mode: 'regex', pattern: '^/start', reply: 'Selamat datang' },
]);

test('parseRules rejects non-JSON, JSON primitives, and empty', () => {
  assert.throws(() => parseRules('not json'));
  // JSON primitives are not an array/object → still rejected with the array hint.
  assert.throws(() => parseRules('42'), /array/i);
  assert.throws(() => parseRules('"hi"'), /array/i);
  assert.throws(() => parseRules('null'), /array/i);
  assert.throws(() => parseRules('[]'), /no usable/i);
});

test('parseRules accepts a single rule object by wrapping it in an array', () => {
  const { rules } = parseRules(JSON.stringify({ mode: 'contains', pattern: 'hi', reply: 'hello' }));
  assert.equal(rules.length, 1);
  assert.equal(rules[0].reply, 'hello');
  // An object missing required fields is still wrapped, then rejected by field validation.
  assert.throws(() => parseRules('{}'), /mode/i);
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

test('parseRules rejects nested unbounded quantifiers hidden behind extra groups', () => {
  const { rules, skipped } = parseRules(
    JSON.stringify([
      { mode: 'regex', pattern: '((a+))+$', reply: 'evil' },
      { mode: 'regex', pattern: '(((a+)))*', reply: 'evil2' },
      { mode: 'regex', pattern: '((\\w+\\s?))*$', reply: 'evil3' },
      { mode: 'contains', pattern: 'hi', reply: 'hello' },
    ]),
  );
  assert.equal(rules.length, 1);
  assert.deepEqual(skipped, ['((a+))+$', '(((a+)))*', '((\\w+\\s?))*$']);
});

test('parseRules keeps grouped patterns that carry only a single quantifier', () => {
  const { rules, skipped } = parseRules(
    JSON.stringify([
      { mode: 'regex', pattern: '((ab)+)', reply: 'a' },
      { mode: 'regex', pattern: '(a+)', reply: 'b' },
      { mode: 'regex', pattern: '((cat|dog))', reply: 'c' },
    ]),
  );
  assert.equal(skipped.length, 0);
  assert.equal(rules.length, 3);
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

test('parseRules rejects adjacent overlapping unbounded quantifiers (sibling ReDoS)', () => {
  // Same-level adjacent quantifiers over overlapping classes backtrack polynomially even without
  // any group nesting — e.g. `.*.*.*done` hangs on a 1000-char body. The nested-only check missed them.
  const { rules, skipped } = parseRules(
    JSON.stringify([
      { mode: 'regex', pattern: '.*.*.*done', reply: 'evil1' },
      { mode: 'regex', pattern: '.*.*done', reply: 'evil2' },
      { mode: 'regex', pattern: '\\w*\\w*\\w*\\w*\\w*!', reply: 'evil3' },
      { mode: 'contains', pattern: 'hi', reply: 'hello' },
    ]),
  );
  assert.equal(rules.length, 1);
  assert.deepEqual(skipped, ['.*.*.*done', '.*.*done', '\\w*\\w*\\w*\\w*\\w*!']);
});

test('parseRules rejects a repeated group whose body has a variable-width quantifier', () => {
  // `(a?){40}` is exponential: the optional inner + a bounded outer repeat is invisible to a check
  // that only models UNBOUNDED nesting. Reject any group repeated >=2 times with a variable-width body.
  const { rules, skipped } = parseRules(
    JSON.stringify([
      { mode: 'regex', pattern: '(a?){40}b', reply: 'evil1' },
      { mode: 'regex', pattern: '(a?){25}b', reply: 'evil2' },
      { mode: 'contains', pattern: 'hi', reply: 'hello' },
    ]),
  );
  assert.equal(rules.length, 1);
  assert.deepEqual(skipped, ['(a?){40}b', '(a?){25}b']);
});

test('parseRules keeps legitimate patterns (adjacent DISJOINT classes, separated widecards, fixed nesting)', () => {
  // Regression guard: the hardening must not reject ordinary operator patterns. Adjacent quantifiers
  // over disjoint classes (a/b/c, \s/\d) are linear; a wildcard separated by a literal is fine; a group
  // with only a fixed-width body ({2}) repeated is fine.
  const corpus = [
    'a*b*c*',        // adjacent, disjoint literals — already a shipped assertion
    'order\\s+\\d+', // adjacent, disjoint classes
    '.*urgent.*',    // two wildcards separated by a mandatory literal
    'https?://\\S+', // single unbounded quantifier
    '(cat|dog)s?',   // group not repeated
    'colou?r',       // lone optional
    '\\d{3}-\\d{4}', // bounded, no repeat-of-variable
    '(\\d{2}){3}',   // repeated group, FIXED-width body — safe
    'hi|hello|hey',
    '\\bprice\\b',
  ].map((pattern, i) => ({ mode: 'regex', pattern, reply: String(i) }));
  const { rules, skipped } = parseRules(JSON.stringify(corpus));
  assert.deepEqual(skipped, []);
  assert.equal(rules.length, corpus.length);
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
