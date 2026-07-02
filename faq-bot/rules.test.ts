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

test('parseRules rejects 3+ adjacent overlapping unbounded quantifiers (sibling ReDoS)', () => {
  // 3+ same-level adjacent quantifiers over overlapping classes backtrack polynomially (O(n^3)+) and hang
  // on a 1000-char body. Two adjacent is only O(n^2) — safe under the cap — so it is allowed (next test).
  const { rules, skipped } = parseRules(
    JSON.stringify([
      { mode: 'regex', pattern: '.*.*.*done', reply: 'evil1' },
      { mode: 'regex', pattern: '\\w*\\w*\\w*\\w*\\w*!', reply: 'evil3' },
      { mode: 'contains', pattern: 'hi', reply: 'hello' },
    ]),
  );
  assert.equal(rules.length, 1);
  assert.deepEqual(skipped, ['.*.*.*done', '\\w*\\w*\\w*\\w*\\w*!']);
});

test('parseRules allows two adjacent overlapping quantifiers (O(n^2) is safe under the 1000-char cap)', () => {
  const { skipped } = parseRules(
    JSON.stringify([
      { mode: 'regex', pattern: '.*.*done', reply: 'a' }, // two dots
      { mode: 'regex', pattern: '.*\\d+', reply: 'b' },   // dot then \d
      { mode: 'regex', pattern: '\\w+.*', reply: 'c' },
    ]),
  );
  assert.deepEqual(skipped, []);
});

test('parseRules rejects a LARGE/unbounded repeat of a variable-width group, allows a small bounded one', () => {
  // `(a?){40}` is exponential (2^40); a small bounded repeat like `(ab?){2}` is bounded by the constant and
  // safe. Reject on unbounded or a large count; allow the small ones common in real (e.g. phone) patterns.
  const { rules, skipped } = parseRules(
    JSON.stringify([
      { mode: 'regex', pattern: '(a?){40}b', reply: 'evil1' },
      { mode: 'regex', pattern: '(a?){25}b', reply: 'evil2' },
      { mode: 'regex', pattern: '(a?)+b', reply: 'evil3' }, // unbounded outer
      { mode: 'regex', pattern: '(ab?){2}', reply: 'ok1' },
      { mode: 'regex', pattern: '(\\d{2,4}){3}', reply: 'ok2' },
      { mode: 'contains', pattern: 'hi', reply: 'hello' },
    ]),
  );
  assert.deepEqual(skipped, ['(a?){40}b', '(a?){25}b', '(a?)+b']);
  assert.equal(rules.length, 3); // ok1, ok2, hi
});

test('parseRules: an empty character class [^] / [] does not hide a catastrophic pattern (JS class semantics)', () => {
  // In JavaScript `[^]` matches ANY char and `[]` is an empty class — the `]` closes the class. A POSIX-style
  // "leading ] is a literal member" reading would swallow the rest of the pattern and bypass the screen.
  const { rules, skipped } = parseRules(
    JSON.stringify([
      { mode: 'regex', pattern: '[^](a+)+!', reply: 'evil1' },
      { mode: 'regex', pattern: '[](a+)+!', reply: 'evil2' },
      { mode: 'contains', pattern: 'hi', reply: 'hello' },
    ]),
  );
  assert.equal(rules.length, 1);
  assert.deepEqual(skipped, ['[^](a+)+!', '[](a+)+!']);
});

test('parseRules: a normal character class is still accepted (no regression from the empty-class fix)', () => {
  const { rules, skipped } = parseRules(
    JSON.stringify([
      { mode: 'regex', pattern: '[abc]+', reply: 'a' },
      { mode: 'regex', pattern: '[a\\]b]+', reply: 'b' }, // an escaped ] inside the class
      { mode: 'regex', pattern: '[^0-9]*x', reply: 'c' },
    ]),
  );
  assert.deepEqual(skipped, []);
  assert.equal(rules.length, 3);
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
