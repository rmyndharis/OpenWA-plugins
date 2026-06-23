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

/** Unbounded quantifier (`*`, `+`, or open-ended `{n,}`) at position `i`; returns its source length. */
function unboundedQuantifierAt(p: string, i: number): { unbounded: boolean; len: number } {
  const c = p[i];
  if (c === '*' || c === '+') return { unbounded: true, len: 1 };
  if (c === '{') {
    const close = p.indexOf('}', i);
    if (close === -1) return { unbounded: false, len: 1 };
    const m = /^(\d+)(,(\d*))?$/.exec(p.slice(i + 1, close));
    if (!m) return { unbounded: false, len: 1 };
    return { unbounded: m[2] !== undefined && (m[3] ?? '') === '', len: close - i + 1 };
  }
  return { unbounded: false, len: 0 };
}

/**
 * Conservatively reject patterns prone to catastrophic backtracking — an unbounded quantifier applied
 * to a group that itself contains an unbounded quantifier, e.g. `(a+)+`, `(\w+\s?)*`. Accepted patterns
 * run on the native engine unchanged (full ECMAScript semantics). Does not catch every ReDoS class
 * (e.g. overlapping alternation), but closes the dominant nested-quantifier class; fails closed.
 */
export function isSafeRegexPattern(p: string): boolean {
  if (p.length > MAX_PATTERN_LENGTH) return false;
  const stack: { hasUnbounded: boolean }[] = [];
  let inClass = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\') { i++; continue; } // escaped atom
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c === '(') { stack.push({ hasUnbounded: false }); continue; }
    if (c === ')') {
      const group = stack.pop() ?? { hasUnbounded: false };
      const q = unboundedQuantifierAt(p, i + 1);
      if (q.unbounded) {
        if (group.hasUnbounded) return false; // nested unbounded quantifier -> catastrophic
        if (stack.length) stack[stack.length - 1].hasUnbounded = true; // quantified group repeats too
        i += q.len;
      }
      continue;
    }
    const q = unboundedQuantifierAt(p, i);
    if (q.unbounded) {
      if (stack.length) stack[stack.length - 1].hasUnbounded = true;
      i += q.len - 1;
    }
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
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error('rules must be a JSON array');

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
