export type RuleMode = 'contains' | 'exact' | 'regex';
export interface Rule {
  mode: RuleMode;
  pattern: string;
  reply: string;
}
export interface CompiledRule extends Rule {
  regex?: RegExp;
}

const MODES: RuleMode[] = ['contains', 'exact', 'regex'];
/** Cap on the body length a regex is tested against (defence in depth, not the ReDoS control). */
const MAX_REGEX_INPUT = 1000;
/** Reject absurdly long patterns outright. */
const MAX_PATTERN_LENGTH = 1000;

/** The single atom starting at `i` (an escaped token, a `[...]` class, `.`, or a literal) and its key
 *  for overlap comparison. `.` and a `[...]` class are compared by source; `.` (key `ANY`) overlaps any
 *  atom. Two atoms "overlap" when they can match a common character. */
function atomAt(p: string, i: number): { key: string; len: number } {
  const c = p[i];
  if (c === '\\') return { key: p.slice(i, i + 2), len: 2 };
  if (c === '[') {
    let j = i + 1;
    if (p[j] === '^') j++;
    if (p[j] === ']') j++; // a `]` as the first member is a literal, not the close
    while (j < p.length && p[j] !== ']') { if (p[j] === '\\') j++; j++; }
    const end = j < p.length ? j + 1 : p.length;
    return { key: p.slice(i, end), len: end - i };
  }
  if (c === '.') return { key: 'ANY', len: 1 };
  return { key: c, len: 1 };
}

/** The quantifier at `i`, if any. `min` = minimum repeats; `repeat2` = can apply its atom ≥2 times;
 *  `variable` = matches a variable count (so repeating it can backtrack); `unbounded` = no upper limit. */
function quantifierAt(
  p: string,
  i: number,
): { present: boolean; len: number; min: number; unbounded: boolean; repeat2: boolean; variable: boolean } {
  const none = { present: false, len: 0, min: 1, unbounded: false, repeat2: false, variable: false };
  const lazy = (len: number) => (p[i + len] === '?' ? len + 1 : len); // trailing `?` = lazy modifier
  const c = p[i];
  if (c === '*') return { present: true, len: lazy(1), min: 0, unbounded: true, repeat2: true, variable: true };
  if (c === '+') return { present: true, len: lazy(1), min: 1, unbounded: true, repeat2: true, variable: true };
  if (c === '?') return { present: true, len: lazy(1), min: 0, unbounded: false, repeat2: false, variable: true };
  if (c === '{') {
    const close = p.indexOf('}', i);
    if (close === -1) return none;
    const m = /^(\d+)(,(\d*))?$/.exec(p.slice(i + 1, close));
    if (!m) return none;
    const min = Number(m[1]);
    const len = lazy(close - i + 1);
    if (m[2] === undefined) return { present: true, len, min, unbounded: false, repeat2: min >= 2, variable: false }; // {n}
    if ((m[3] ?? '') === '') return { present: true, len, min, unbounded: true, repeat2: true, variable: true }; // {n,}
    const max = Number(m[3]); // {n,m}
    return { present: true, len, min, unbounded: false, repeat2: max >= 2, variable: max > min };
  }
  return none;
}

const overlaps = (a: string, b: string): boolean => a === 'ANY' || b === 'ANY' || a === b;

/**
 * Conservatively reject patterns prone to catastrophic backtracking. Three classes are closed:
 *  1. an unbounded quantifier on a group that itself contains one — `(a+)+`, `((a+))+`, `(\w+\s?)*`;
 *  2. two adjacent unbounded quantifiers over overlapping atoms in one concatenation — `.*.*`, `\w*\w*`
 *     (polynomial); a mandatory atom or a group boundary between them breaks the chain (`.*x.*` is fine);
 *  3. a group repeated ≥2 times whose body carries a variable-width quantifier — `(a?){40}` (exponential).
 * Accepted patterns run on the native engine unchanged. Overlapping-alternation (`(a|a)*`) is still not
 * modelled — a known, documented residual. Fails closed on anything it can't parse cleanly.
 */
export function isSafeRegexPattern(p: string): boolean {
  if (p.length > MAX_PATTERN_LENGTH) return false;
  const stack: { hasUnbounded: boolean; hasVariable: boolean }[] = [];
  // Rule 2 state: the key of the previous unbounded-quantified atom in the current flat concatenation,
  // or null after a mandatory atom / `|` / group boundary (which break adjacency).
  let prevUnbounded: string | null = null;
  let i = 0;
  while (i < p.length) {
    const c = p[i];

    if (c === '|') { prevUnbounded = null; i++; continue; }
    if (c === '(') {
      stack.push({ hasUnbounded: false, hasVariable: false });
      prevUnbounded = null;
      i++;
      if (p[i] === '?') { i++; if (p[i] === '<') i++; if (p[i] === ':' || p[i] === '=' || p[i] === '!') i++; }
      continue;
    }
    if (c === ')') {
      const frame = stack.pop() ?? { hasUnbounded: false, hasVariable: false };
      const q = quantifierAt(p, i + 1);
      if (q.unbounded && frame.hasUnbounded) return false; // (1) nested unbounded
      if (q.repeat2 && frame.hasVariable) return false; // (3) repeated group with a variable-width body
      if (stack.length) {
        if (q.unbounded || frame.hasUnbounded) stack[stack.length - 1].hasUnbounded = true;
        if (q.variable || frame.hasVariable) stack[stack.length - 1].hasVariable = true;
      }
      prevUnbounded = null; // a group boundary breaks flat adjacency (Rule 2)
      i += 1 + q.len;
      continue;
    }

    const atom = atomAt(p, i);
    const q = quantifierAt(p, i + atom.len);
    if (stack.length && q.variable) stack[stack.length - 1].hasVariable = true;
    if (q.unbounded) {
      if (stack.length) stack[stack.length - 1].hasUnbounded = true;
      if (prevUnbounded !== null && overlaps(prevUnbounded, atom.key)) return false; // (2) adjacent overlap
      prevUnbounded = atom.key;
    } else if (!q.present || q.min >= 1) {
      prevUnbounded = null; // a mandatory (non-skippable) atom breaks adjacency
    }
    i += atom.len + q.len;
  }
  return true;
}

/**
 * Parse + validate the rules JSON. Throws on structurally invalid input (not JSON, not an array, a rule
 * with a bad mode or an empty pattern/reply, or no usable rules). A `regex` rule whose pattern fails to
 * compile is dropped and its pattern returned in `skipped` (the caller logs it) — one bad regex must
 * not kill the whole set.
 */
export function parseRules(json: string): { rules: CompiledRule[]; skipped: string[] } {
  let parsed: unknown = JSON.parse(json);
  // Convenience: accept a single rule object and wrap it, so pasting one { mode, pattern, reply }
  // (a common mistake) works instead of erroring with "rules must be a JSON array". A JSON primitive
  // or null is NOT an object here and still falls through to the array check below.
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    parsed = [parsed];
  }
  if (!Array.isArray(parsed)) throw new Error('rules must be a JSON array (e.g. [{"mode":"contains","pattern":"hi","reply":"hello"}])');

  const rules: CompiledRule[] = [];
  const skipped: string[] = [];
  parsed.forEach((raw, i) => {
    const r = (raw ?? {}) as Partial<Rule>;
    const mode = r.mode as RuleMode;
    if (!MODES.includes(mode)) throw new Error(`rule ${i}: invalid mode (${String(r.mode)})`);
    if (typeof r.pattern !== 'string' || r.pattern.length === 0) {
      throw new Error(`rule ${i}: pattern must be a non-empty string`);
    }
    if (typeof r.reply !== 'string' || r.reply.length === 0) {
      throw new Error(`rule ${i}: reply must be a non-empty string`);
    }
    if (mode === 'regex') {
      if (!isSafeRegexPattern(r.pattern)) {
        skipped.push(r.pattern);
        return;
      }
      try {
        rules.push({ mode: 'regex', pattern: r.pattern, reply: r.reply, regex: new RegExp(r.pattern, 'i') });
      } catch {
        skipped.push(r.pattern);
      }
    } else {
      rules.push({ mode, pattern: r.pattern, reply: r.reply });
    }
  });

  if (rules.length === 0) throw new Error('rules has no usable entries');
  return { rules, skipped };
}

/** First rule that matches `text` (contains/exact are case-insensitive; regex uses its compiled flags). */
export function matchRule(rules: CompiledRule[], text: string): CompiledRule | null {
  const lower = text.toLowerCase();
  const trimmedLower = text.trim().toLowerCase();
  for (const rule of rules) {
    if (rule.mode === 'contains' && lower.includes(rule.pattern.toLowerCase())) return rule;
    if (rule.mode === 'exact' && trimmedLower === rule.pattern.toLowerCase()) return rule;
    if (rule.mode === 'regex' && rule.regex && rule.regex.test(text.slice(0, MAX_REGEX_INPUT))) return rule;
  }
  return null;
}
