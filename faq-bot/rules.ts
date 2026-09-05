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
    // JS class semantics: a `]` here CLOSES the class (`[]` is an empty class, `[^]` matches any char).
    // Do NOT treat a leading `]` as a literal member (POSIX/PCRE) — that would let `[^]`/`[]` swallow the
    // rest of the pattern into one fake atom and hide a catastrophic tail (e.g. `[^](a+)+`).
    while (j < p.length && p[j] !== ']') { if (p[j] === '\\') j++; j++; }
    const end = j < p.length ? j + 1 : p.length;
    return { key: p.slice(i, end), len: end - i };
  }
  if (c === '.') return { key: 'ANY', len: 1 };
  return { key: c, len: 1 };
}

/** The quantifier at `i`, if any. `min` = minimum repeats; `count` = the MAXIMUM repeats (Infinity when
 *  unbounded); `variable` = matches a variable count (so repeating it can backtrack); `unbounded` = no
 *  upper limit. `count` drives the repeated-group check: a large/unbounded repeat of a variable-width
 *  body backtracks exponentially, a small bounded one (2–4) does not. */
function quantifierAt(
  p: string,
  i: number,
): { present: boolean; len: number; min: number; count: number; unbounded: boolean; variable: boolean } {
  const none = { present: false, len: 0, min: 1, count: 1, unbounded: false, variable: false };
  const lazy = (len: number) => (p[i + len] === '?' ? len + 1 : len); // trailing `?` = lazy modifier
  const c = p[i];
  if (c === '*') return { present: true, len: lazy(1), min: 0, count: Infinity, unbounded: true, variable: true };
  if (c === '+') return { present: true, len: lazy(1), min: 1, count: Infinity, unbounded: true, variable: true };
  if (c === '?') return { present: true, len: lazy(1), min: 0, count: 1, unbounded: false, variable: true };
  if (c === '{') {
    const close = p.indexOf('}', i);
    if (close === -1) return none;
    const m = /^(\d+)(,(\d*))?$/.exec(p.slice(i + 1, close));
    if (!m) return none;
    const min = Number(m[1]);
    const len = lazy(close - i + 1);
    if (m[2] === undefined) return { present: true, len, min, count: min, unbounded: false, variable: false }; // {n}
    if ((m[3] ?? '') === '') return { present: true, len, min, count: Infinity, unbounded: true, variable: true }; // {n,}
    const max = Number(m[3]); // {n,m}
    return { present: true, len, min, count: max, unbounded: false, variable: max > min };
  }
  return none;
}

const overlaps = (a: string, b: string): boolean => a === 'ANY' || b === 'ANY' || a === b;

/**
 * One element of a rule-2 adjacency run: a bare atom, or an unbounded-quantified GROUP.
 *
 * A group has to be carried differently from an atom because it has no single atom key: `(a|b)*` can
 * start with either branch, so it is represented by the characters its body can begin with, unioned
 * over the branches (null = could not be decided, treated as overlapping).
 */
type RunElement = { kind: 'atom'; key: string } | { kind: 'group'; chars: Set<string> | null };

/**
 * The characters ANY branch of a group can start with, or null when that cannot be decided.
 *
 * Unioned rather than intersected: the group is entered afresh on every repetition, so it competes for
 * a character as soon as ONE branch can begin with it. A branch whose first atom is unknown (it opens
 * with a nested group) makes the whole set undecidable, which fails closed.
 */
function branchFirstChars(branches: Branch[]): Set<string> | null {
  const out = new Set<string>();
  for (const b of branches) {
    if (b.first === null) return null;
    const set = firstCharSet(b.first);
    if (set === null) return null;
    for (const ch of set) out.add(ch);
  }
  return out.size > 0 ? out : null;
}

/** The characters a run element can start with, or null when that cannot be decided. */
function runChars(e: RunElement): Set<string> | null {
  return e.kind === 'atom' ? firstCharSet(e.key) : e.chars;
}

/**
 * Do two adjacent unbounded-quantified elements compete for the same characters?
 *
 * Two ATOMS are compared exactly as before, by atom key, so no pattern that passed this screen on the
 * atom path changes verdict. A group on either side falls back to comparing character sets, which is
 * the only comparison available for something with no single key; an undecidable set fails closed.
 */
function runOverlaps(a: RunElement, b: RunElement): boolean {
  if (a.kind === 'atom' && b.kind === 'atom') return overlaps(a.key, b.key);
  const sa = runChars(a);
  const sb = runChars(b);
  if (sa === null || sb === null) return true;
  for (const ch of sa) if (sb.has(ch)) return true;
  return false;
}

/** Turn an atom key back into a regex source safe to compile on its own. */
function atomSource(key: string): string {
  if (key.startsWith('\\') || key.startsWith('[')) return key;
  return key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The printable-ASCII characters an atom can match, or null when that cannot be decided (treated as
 *  "matches anything"). Exact over the range an operator's rule realistically uses. Compiling a single
 *  atom and testing it against one character cannot itself backtrack, and this runs once when config is
 *  parsed, never per message. */
function firstCharSet(key: string): Set<string> | null {
  if (key === 'ANY') return null;
  let re: RegExp;
  try {
    re = new RegExp(`^(?:${atomSource(key)})$`, 'u');
  } catch {
    return null; // unparseable on its own: assume it overlaps, fail closed
  }
  const out = new Set<string>();
  for (let c = 32; c <= 126; c++) {
    const ch = String.fromCharCode(c);
    try {
      if (re.test(ch)) out.add(ch);
    } catch {
      return null;
    }
  }
  return out;
}

/** One top-level branch of an alternation. `literal` is the branch's exact text when it is nothing but
 *  unquantified literal characters, else null. `first` is the key of its first atom, or null when that
 *  could not be reduced to one atom (a branch opening with a group). */
export interface Branch {
  literal: string | null;
  first: string | null;
}

/** True when a REPEATED alternation is ambiguous: two branches can consume the same text, so at each
 *  position the engine has more than one way forward and must try them all on failure. That is what
 *  turns `(a|a)*` and `^([a-z]|[a-z0-9])+$` exponential.
 *
 *  Two literal branches are ambiguous only when one is a PREFIX of the other (`a` and `ab`, or two equal
 *  branches). Sharing a first character is not enough on its own: `(one|two|three)+` has two branches
 *  starting `t`, but they diverge at the next character and the engine can never split the same text two
 *  ways. Anything not reducible to a literal falls back to first-character overlap, which is
 *  conservative, and an unknown branch counts as overlapping so the check fails closed. */
function branchesAmbiguous(branches: Branch[]): boolean {
  for (let a = 0; a < branches.length; a++) {
    for (let b = a + 1; b < branches.length; b++) {
      const x = branches[a];
      const y = branches[b];
      if (x.literal !== null && y.literal !== null) {
        if (x.literal.startsWith(y.literal) || y.literal.startsWith(x.literal)) return true;
        continue;
      }
      if (x.first === null || y.first === null) return true;
      const sx = firstCharSet(x.first);
      const sy = firstCharSet(y.first);
      if (sx === null || sy === null) return true;
      for (const ch of sx) if (sy.has(ch)) return true;
    }
  }
  return false;
}

/** A group repeated this many times (or unbounded) with a variable-width body backtracks catastrophically;
 *  a smaller bounded repeat is bounded by the constant and safe. */
const REPEAT_THRESHOLD = 10;

/**
 * Conservatively reject patterns prone to catastrophic backtracking. Four classes are closed:
 *  1. an unbounded quantifier on a group that itself contains one — `(a+)+`, `((a+))+`, `(\w+\s?)*`;
 *  2. THREE OR MORE adjacent unbounded quantifiers over overlapping elements in one concatenation —
 *     `.*.*.*`, `\w*\w*\w*`, `(a|b)*(a|b)*(a|b)*` (O(n^3)+); TWO adjacent (`.*.*`, `.*\d+`) is only
 *     O(n^2), safe under the 1000-char input cap, so it is allowed; a mandatory atom or a `|` breaks
 *     the chain. An element is a bare atom OR an unbounded-quantified group, and a TRANSPARENT group
 *     (no quantifier, or `{1}`) splices its body into the enclosing run rather than hiding it, so
 *     `(a*)(a*)(a*)` and `((a|b)*(a|b)*)(a|b)*` count as three. Counting only bare atoms left every
 *     one of those accepted, at tens of seconds on a 1000-character input;
 *  3. an unbounded or ≥REPEAT_THRESHOLD repeat of a group whose body has a variable-width quantifier —
 *     `(a?){40}`, `(a?)+` (exponential); a small bounded repeat of a VARIABLE body like `(ab?){2}` is
 *     allowed, but any repeat of an UNBOUNDED body is not — see (1).
 *  4. a REPEATED group whose top-level alternation is AMBIGUOUS, i.e. two branches can consume the same
 *     text: `(a|a)*`, `(a|ab)+`, `^([a-z]|[a-z0-9])+$`, `^(\w|\d)+$`. The engine then has more than one
 *     way forward at each position and must try them all, which is exponential and saturates far below
 *     the input cap (`^([a-z]|[a-z0-9])+$` needs 259 ms at 23 characters and over a minute at 31).
 *     `(one|two|three)+` is NOT this shape: two branches start `t` but diverge immediately, so no text
 *     splits two ways. See branchesAmbiguous.
 * Character classes follow JS semantics (`[]` empty, `[^]` any). Accepted patterns run on the native engine
 * unchanged. Fails closed: anything the walker cannot reduce is treated as unsafe.
 *
 * This is a heuristic, not a decision procedure. It models the shapes that actually reach an operator's
 * config; a determined author can still write something pathological that it accepts, which is why the
 * body cap and the plugin's own guards remain.
 */
export function isSafeRegexPattern(p: string): boolean {
  if (p.length > MAX_PATTERN_LENGTH) return false;
  const stack: {
    hasUnbounded: boolean;
    hasVariable: boolean;
    // Rule 4 state. True when this group is, or purely WRAPS, an alternation whose branches can start
    // with the same character. Without it the rule only saw the group it was closing, so one paren of
    // cover moved the quantifier to a single-branch frame and the check went quiet: `(a|a)+$` was
    // refused while `((a|a))+$` was accepted and then spent ~9 s on a 27-character message.
    //
    // Propagated ONLY through pure cover (see `sawAtom`). A wrapper that also contributes a mandatory
    // atom is not cover: it anchors each repetition, so the branches can no longer consume the same
    // text two ways. `((no|nope) )+$` is linear precisely because of that trailing space, and flagging
    // it would silently disable an ordinary keyword rule on upgrade.
    hasAmbiguous: boolean;
    // Whether this group contributed an atom of its own, i.e. anything besides the nested group(s).
    sawAtom: boolean;
    savedPrev: RunElement | null;
    savedRun: number;
    // Rule 2, transparent-group support. `savedLead` / `savedUnbroken` park the ENCLOSING
    // concatenation's leading-run state, the way savedPrev/savedRun park its trailing state.
    savedLead: RunElement | null;
    savedUnbroken: boolean;
    // One record per top-level branch of THIS group; see Branch.
    branches: Branch[];
  }[] = [];
  // Rule 2 state: the previous unbounded-quantified element in the current flat concatenation, or null
  // after a mandatory atom / `|` / group boundary (which break adjacency).
  let prevUnbounded: RunElement | null = null;
  let adjacentRun = 0; // length of the current run of adjacent overlapping unbounded-quantified atoms
  // The element the CURRENT run starts at, and whether that run reaches back to the very beginning of
  // the current concatenation. Together they let a TRANSPARENT group (no quantifier, or `{1}`) splice
  // its body into the enclosing run instead of discarding it: `(a*)(a*)(a*)` is `a*a*a*` with three
  // pairs of parentheses, and counting it as three is the whole point of rule 2.
  let leadElement: RunElement | null = null;
  let unbroken = true;
  let i = 0;
  while (i < p.length) {
    const c = p[i];

    if (c === '|') {
      // A new branch is a new concatenation: nothing before the `|` is adjacent to anything after it.
      prevUnbounded = null; adjacentRun = 0; leadElement = null; unbroken = false;
      if (stack.length) stack[stack.length - 1].branches.push({ literal: '', first: null });
      i++; continue;
    }
    if (c === '(') {
      // The run so far is parked, not discarded: whether this group breaks it depends on whether it can
      // match empty, which is only known at the closing paren.
      if (stack.length) {
        // A nested group means this branch is no longer a plain literal and its first character is not a
        // single atom. Both are recorded as unknown, which branchesAmbiguous treats as overlapping.
        const br = stack[stack.length - 1].branches;
        const cur = br[br.length - 1];
        if (cur) { cur.literal = null; if (cur.first === null) cur.first = null; }
      }
      stack.push({
        hasUnbounded: false, hasVariable: false, hasAmbiguous: false, sawAtom: false,
        savedPrev: prevUnbounded, savedRun: adjacentRun,
        savedLead: leadElement, savedUnbroken: unbroken,
        branches: [{ literal: '', first: null }],
      });
      prevUnbounded = null; adjacentRun = 0; leadElement = null; unbroken = true;
      i++;
      if (p[i] === '?') { i++; if (p[i] === '<') i++; if (p[i] === ':' || p[i] === '=' || p[i] === '!') i++; }
      continue;
    }
    if (c === ')') {
      const frame = stack.pop() ?? {
        hasUnbounded: false, hasVariable: false, hasAmbiguous: false, sawAtom: false,
        savedPrev: null, savedRun: 0, savedLead: null as RunElement | null, savedUnbroken: true,
        branches: [] as Branch[],
      };
      const q = quantifierAt(p, i + 1);
      // (1) nested unbounded. A BOUNDED repeat counts too once it repeats at all: `(a+){3}` expands to
      // `a+a+a+`, which backtracks exponentially — the constant bounds the repeat, not the search.
      if ((q.unbounded || q.count >= 2) && frame.hasUnbounded) return false;
      if (q.count >= REPEAT_THRESHOLD && frame.hasVariable) return false; // (3) large/unbounded repeat of a variable body
      // (4) a REPEATED group whose top-level alternation branches can start with the same character.
      // The engine then has two ways to consume each character and must try both on failure, which is
      // exponential: `^([a-z]|[a-z0-9])+$` needs over a minute on a 31-character input, well inside the
      // body cap, and JS regex execution cannot be interrupted.
      // This group's own alternation, OR one it purely wraps. Pure cover means the group added nothing
      // but parentheses: no atom of its own and no alternation of its own. `((a|a))+$` is that shape,
      // and the repetition lands on the inner ambiguity unchanged.
      //
      // A wrapper that DOES contribute an atom is deliberately not propagated through. The atom is
      // mandatory in every iteration, so it realigns the match and the branches can no longer split
      // the same text: `((no|nope) )+$`, `^((satu|dua|(tiga|empat)),)+$` and `((ok|oke)\s)+` are all
      // linear (measured at 0.0 ms against the 1000-char input cap) and all of them are rules an
      // operator really writes. Rejecting those would silently stop an upgraded install from replying.
      const pureCover = !frame.sawAtom && frame.branches.length === 1;
      const ambiguous =
        (frame.hasAmbiguous && pureCover) || (frame.branches.length >= 2 && branchesAmbiguous(frame.branches));
      if ((q.unbounded || q.count >= 2) && ambiguous) {
        return false;
      }
      if (stack.length) {
        if (q.unbounded || frame.hasUnbounded) stack[stack.length - 1].hasUnbounded = true;
        if (q.variable || frame.hasVariable) stack[stack.length - 1].hasVariable = true;
        if (ambiguous) stack[stack.length - 1].hasAmbiguous = true;
      }
      // An UNBOUNDED-quantified group is itself a run element, exactly like an unbounded-quantified
      // atom. Restoring the parked run here instead (which is what a nullable group did) meant rule 2
      // only ever counted bare atoms, so `.*.*.*done` was refused while `(a|b)*(a|b)*(a|b)*$` was
      // accepted and then ran O(n^3): 380 ms at 150 characters, and ~113 s at the 1000-character body
      // cap, which a regex cannot be interrupted to honour.
      if (q.unbounded) {
        const here: RunElement = { kind: 'group', chars: branchFirstChars(frame.branches) };
        // Compared against the run PARKED when this group opened, not the live one: `(` resets
        // prevUnbounded so the body starts its own concatenation, so the live value here belongs to
        // the group's last inner atom and says nothing about what precedes the group.
        let run = frame.savedRun;
        leadElement = frame.savedLead;
        unbroken = frame.savedUnbroken;
        if (frame.savedPrev !== null && runOverlaps(frame.savedPrev, here)) {
          if (++run >= 3) return false; // (2) 3+ adjacent overlapping unbounded quantifiers
        } else {
          if (run > 0) unbroken = false;
          run = 1;
          leadElement = here;
        }
        adjacentRun = run;
        prevUnbounded = here;
        i += 1 + q.len;
        continue;
      }
      // A TRANSPARENT group (no quantifier, or `{1}`) is just parentheses: its body belongs to the
      // enclosing concatenation. Restoring the parked run here discarded whatever the body ended with,
      // so `a*a*a*` was refused while `(a*)(a*)(a*)` and `((a|b)*(a|b)*)(a|b)*` sailed through, at
      // 72 ms and 285 ms against 140 characters and O(n^3) from there. Splice instead: the body's own
      // trailing run joins the parked one when it reaches back to the body's first element AND that
      // element competes for the same characters as what preceded the group.
      const transparent = !q.present || (q.min === 1 && q.count === 1 && !q.variable);
      if (transparent && leadElement !== null) {
        const joins = unbroken && frame.savedPrev !== null && runOverlaps(frame.savedPrev, leadElement);
        const combined = joins ? frame.savedRun + adjacentRun : adjacentRun;
        if (combined >= 3) return false; // (2) 3+ adjacent overlapping unbounded quantifiers
        adjacentRun = combined;
        // `prevUnbounded` already holds the body's trailing element, which is what follows this group.
        // The lead belongs to the enclosing concatenation once one exists there; when it does not, the
        // body's lead becomes it, and only stays start-anchored if both sides were.
        if (frame.savedLead !== null) { leadElement = frame.savedLead; unbroken = frame.savedUnbroken; }
        else { unbroken = frame.savedUnbroken && unbroken; }
        i += 1 + q.len;
        continue;
      }
      // A group breaks flat adjacency only if it MUST consume something. `(x?)` can match empty, so
      // `.*(x?).*` is `.*.*` in disguise; resume the parked run rather than pretending it ended.
      const nullable = frame.hasVariable || (q.present && q.min === 0);
      if (nullable) {
        prevUnbounded = frame.savedPrev; adjacentRun = frame.savedRun;
        leadElement = frame.savedLead; unbroken = frame.savedUnbroken;
      } else {
        prevUnbounded = null; adjacentRun = 0; leadElement = null; unbroken = false;
      }
      i += 1 + q.len;
      continue;
    }

    const atom = atomAt(p, i);
    const q = quantifierAt(p, i + atom.len);
    if (stack.length) {
      stack[stack.length - 1].sawAtom = true; // this group is no longer pure cover for a nested one
      const br = stack[stack.length - 1].branches;
      const cur = br[br.length - 1];
      if (cur) {
        if (cur.first === null) cur.first = atom.key;
        // The branch stays a literal only while every atom is a bare, unquantified single character.
        if (cur.literal !== null) {
          cur.literal = !q.present && atom.len === 1 && atom.key !== 'ANY' ? cur.literal + atom.key : null;
        }
      }
    }
    if (stack.length && q.variable) stack[stack.length - 1].hasVariable = true;
    if (q.unbounded) {
      if (stack.length) stack[stack.length - 1].hasUnbounded = true;
      const here: RunElement = { kind: 'atom', key: atom.key };
      if (prevUnbounded !== null && runOverlaps(prevUnbounded, here)) {
        if (++adjacentRun >= 3) return false; // (2) 3+ adjacent overlapping unbounded quantifiers
      } else {
        // A new run starts here. If anything preceded it in this concatenation, the run no longer
        // reaches back to the start, so a transparent group around it cannot splice it onto the
        // enclosing run.
        if (adjacentRun > 0) unbroken = false;
        adjacentRun = 1;
        leadElement = here;
      }
      prevUnbounded = here;
    } else if (!q.present || q.min >= 1) {
      // A mandatory (non-skippable) atom breaks adjacency, and with it any claim that the run reaches
      // back to the start of this concatenation.
      prevUnbounded = null; adjacentRun = 0; leadElement = null; unbroken = false;
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
