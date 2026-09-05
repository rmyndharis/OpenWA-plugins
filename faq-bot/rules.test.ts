import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRules, matchRule, isSafeRegexPattern } from './rules.ts';

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

test('an unbounded-quantified GROUP counts toward the adjacency run, like an atom', () => {
  // Rule 2 only ever tracked bare atoms, so `.*.*.*done` was refused while the same shape written with
  // groups sailed through: a group restored the run parked when it opened instead of joining it.
  // Measured on the real engine, `(a|b)*(a|b)*(a|b)*$` takes 380 ms against 150 characters and is
  // O(n^3), i.e. ~113 s at the 1000-character body cap, which a regex cannot be interrupted to honour.
  for (const pattern of [
    '(a|b)*(a|b)*(a|b)*$',
    '(a)*(a)*(a)*$',
    '(a|b)+(a|b)+(a|b)+$',
    '(\\w)*(\\w)*(\\w)*!',
    '.*(a|b)*.*x', // mixed: a group between two wildcards is still three in a row
  ]) {
    assert.equal(isSafeRegexPattern(pattern), false, `should reject: ${pattern}`);
  }
  // Two adjacent is O(n^2) and stays allowed, exactly as for atoms, and groups that compete for
  // DIFFERENT characters never form a run however many of them there are.
  for (const pattern of ['(a|b)*(a|b)*$', '(x)*(y)*(z)*$', '(ab)*(cd)*(ef)*$']) {
    assert.equal(isSafeRegexPattern(pattern), true, `should accept: ${pattern}`);
  }
});

test('adjacency is judged on the characters an atom matches, not on how it is spelled', () => {
  // The run used to compare atoms by atom KEY (equal keys, or `.`), which is a different question from
  // "can these compete for the same character". `[ab]` and `[bc]` are different keys and both match
  // `b`, so a chain of overlapping classes read as three non-competing quantifiers. Measured against
  // 600 characters chosen to match every class and fail at the end, then O(n^3) to the 1000-char cap:
  // `[ab]*[bc]*[cd]*$` 8.9 s (~41 s), `\\w*\\d*\\w*x` 22 s (~103 s), `[a-z]*[a-z0-9]*[a-z]*z` 25 s (~117 s).
  // The alternation spelling of the same regex was already refused, so the verdict turned on notation.
  for (const pattern of ['[ab]*[bc]*[cd]*$', '\\w*\\d*\\w*x', '\\d*\\w*\\d*y', '[a-z]*[a-z0-9]*[a-z]*z']) {
    assert.equal(isSafeRegexPattern(pattern), false, `should reject: ${pattern}`);
  }
  // Classes that share no character still never form a run, which is what keeps ordinary rules alive.
  for (const pattern of ['a*b*c*', 'order\\s+\\d+', '\\s*\\d+', '[^0-9]*x', '\\d{3}-\\d{4}']) {
    assert.equal(isSafeRegexPattern(pattern), true, `should accept: ${pattern}`);
  }
});

test('a transparent group splices its body into the run instead of hiding it', () => {
  // Parentheses that carry no quantifier are not a boundary, they are punctuation: `(a*)(a*)(a*)` is
  // `a*a*a*` with three pairs of them. The run was PARKED at `(` and RESTORED at `)`, so whatever the
  // body ended with was discarded and the same shape escaped however it was grouped. Measured against
  // 140 characters and O(n^3) from there: `(a*)(a*)(a*)$` 87 ms, `((a|b)*(a|b)*)(a|b)*$` 334 ms,
  // `(a*){1}(a*){1}(a*){1}$` 407 ms, i.e. tens of seconds at the 1000-character body cap.
  for (const pattern of [
    '(a*)(a*)(a*)$',
    '(a)*(a)*(a)*$',
    '((a|b)*(a|b)*)(a|b)*$',
    '(a|b)*((a|b)*(a|b)*)$',
    '((a|b)*(a|b)*(a|b)*)$',
    '(.*)(.*)(.*)x',
    '(a*){1}(a*){1}(a*){1}$', // `{1}` is transparent too
  ]) {
    assert.equal(isSafeRegexPattern(pattern), false, `should reject: ${pattern}`);
  }
  // Splicing must not invent a run where none exists. A mandatory atom between the groups breaks the
  // chain, disjoint bodies never form one, and a group with nothing unbounded in it is untouched.
  for (const pattern of ['(a*)(b*)(c*)', '(a*)x(a*)x(a*)', '(a*)', '((a*))', 'x*(y?)z*w*', '.*(x).*(y).*!']) {
    assert.equal(isSafeRegexPattern(pattern), true, `should accept: ${pattern}`);
    const started = Date.now();
    new RegExp(pattern, 'i').test('a'.repeat(1000));
    assert.ok(Date.now() - started < 200, `${pattern} is slow at the input cap`);
  }
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

test('a bounded repeat of an unbounded body is rejected', () => {
  // The doc reasoned that a small bounded repeat is "bounded by the constant and safe". That holds for a
  // variable-width body, not for an unbounded one: `(a+){3}` expands to `a+a+a+`, which backtracks
  // exponentially. Measured before this case was closed: 200 characters took 1.4 s, 1000 took over 6 s.
  for (const pattern of ['(a+){3}b', '(a+){2}b', '(\\w+){4}!', '(a*){3}b']) {
    assert.equal(isSafeRegexPattern(pattern), false, `should reject: ${pattern}`);
  }
  // A bounded repeat of a VARIABLE body stays allowed — that is the case the constant really does bound.
  assert.equal(isSafeRegexPattern('(ab?){2}'), true);
  assert.equal(isSafeRegexPattern('(abc){5}'), true);
});

test('a nullable group does not break a run of adjacent unbounded quantifiers', () => {
  // Rule 2 treats a group boundary as breaking adjacency, which is true only when the group must consume
  // something. `(x?)` can match empty, so `.*(x?).*(x?).*` is `.*.*.*` wearing a disguise — three
  // adjacent unbounded quantifiers over overlapping atoms. Measured: 1000 characters took over 6 s.
  for (const pattern of ['.*(x?).*(x?).*!', '.*(x*).*(x*).*!', '\\w*(a?)\\w*(a?)\\w*!']) {
    assert.equal(isSafeRegexPattern(pattern), false, `should reject: ${pattern}`);
  }
  // A group that must consume still breaks the run, which is what makes these patterns safe.
  assert.equal(isSafeRegexPattern('.*(x).*(y).*!'), true);
});

test('an ambiguous repeated alternation is rejected, an unambiguous one is kept', () => {
  // Two branches that can consume the SAME text give the engine more than one way forward at each
  // position, and it must try them all on failure. Measured on the real engine: `^([a-z]|[a-z0-9])+$`
  // takes 259 ms against 23 characters and over a minute against 31, well inside the 1000-char body cap,
  // and JS regex execution cannot be interrupted. One short message from a stranger pinned the worker,
  // and every later message queued behind it, so the plugin silently stopped answering.
  for (const pattern of ['(a|a)*$', '^([a-z]|[a-z0-9])+$', '^(\\w|\\d)+$', '(a|ab)+', '(x|xy|xyz)+']) {
    assert.equal(isSafeRegexPattern(pattern), false, `should reject: ${pattern}`);
  }
  // Sharing a first character is NOT enough: `two` and `three` both start with `t` but diverge at the
  // next character, so no input can split two ways. Rejecting these would break ordinary keyword rules.
  for (const pattern of ['(one|two|three)+', '(cat|dog)', '^(yes|no)$', '(foo|bar)*', '(ya|tidak)+', 'hal(o|lo)']) {
    assert.equal(isSafeRegexPattern(pattern), true, `should accept: ${pattern}`);
  }
});

test('a wrapping group does not hide an ambiguous repeated alternation', () => {
  // The rejection only ever inspected the branches of the group being closed, so moving the quantifier
  // one level out left it looking at a single-branch frame and it stopped firing. Every pattern here is
  // the accepted one above with nothing added but cover; measured on the real engine against a
  // 27-character message, `((a|a))+$` took ~8.9 s and `^(([a-z]|[a-z0-9]))+$` ~4.9 s, both past the
  // host's 5 s hook budget, which a regex cannot be interrupted to honour.
  for (const pattern of [
    '((a|a))+$',
    '(?:(a|a))+$',
    '((?:a|a))+$',
    '(((a|a)))+$',
    '^(([a-z]|[a-z0-9]))+$',
    '((\\w|\\d))+$',
    '^((ya|ya))+$',
    '((a|a)){2}',
    '((a|a)){3,}',
  ]) {
    assert.equal(isSafeRegexPattern(pattern), false, `should reject: ${pattern}`);
  }
  // An ambiguous alternation that is never repeated is linear, however deeply it is wrapped.
  for (const pattern of ['(a|a)', '((a|a))', '((a|a)){1}', '((a|a))?', '((a|b))+$']) {
    assert.equal(isSafeRegexPattern(pattern), true, `should accept: ${pattern}`);
  }
});

test('a wrapper that adds a mandatory atom is not cover, so ordinary keyword rules still compile', () => {
  // The guard rail for the test above, and the reason the propagation is limited to PURE cover. Every
  // pattern here nests an alternation whose branches share a first character inside a repeated group,
  // which is the shape the test above rejects. They are all linear anyway, because the wrapper also
  // contributes a MANDATORY atom (a space, a comma, a colon) that realigns every iteration, so the
  // branches can never consume the same text two ways. Each measures 0.0 ms against the 1000-character
  // input cap, and each is a rule an operator really writes. Propagating the inner verdict through
  // these wrappers refused all of them, which would silently stop an upgraded install from replying
  // with no config change and no error the operator sees.
  for (const pattern of [
    '^((no|nope) )+$',
    '^((thank|thanks) )+$',
    '^((cek|cekresi):)+$',
    '((ok|oke)\\s)+',
    '^((ya|yaa),)+$',
    '^((halo|(hai|hei)) )+$',
    '^((satu|dua|(tiga|empat)),)+$',
    '^((cs|(admin|support)):)+$',
    '^((0|00),)+$',
  ]) {
    assert.equal(isSafeRegexPattern(pattern), true, `should accept: ${pattern}`);
    // Accepting is only meaningful if accepting is safe, so prove each is fast at the full input cap.
    const started = Date.now();
    new RegExp(pattern, 'i').test('no '.repeat(333) + 'x');
    assert.ok(Date.now() - started < 200, `${pattern} is slow at the input cap`);
  }
});

test('an accepted alternation stays fast at the full input cap', () => {
  // The guard rail for the test above: proving a pattern is accepted is only meaningful if accepting it
  // is actually safe.
  const re = new RegExp('^(one|two|three)+$');
  const started = performance.now();
  re.test('one'.repeat(333) + 'x');
  assert.ok(performance.now() - started < 100, 'an accepted alternation must not backtrack');
});
