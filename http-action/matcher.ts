// Trigger matcher + argument parser for HTTP Action Bot. Pure (no ctx) → tests without OpenWA.
//
// Picks the FIRST action (config order) whose match clause fits the message body, and parses the trailing
// text into args. Case-insensitive by default (the toggle lives on each action's match). Args preserve the
// original message case; only the trigger comparison is case-folded.

import type { HttpAction } from './config.ts';

export interface MatchResult {
  action: HttpAction;
  args: string[];
}

/** Tokenize on whitespace, keeping a double-quoted run as one token. */
export function parseArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[1] ?? m[2]);
  return out;
}

/** First-match-wins over `actions` for `body`, or null when none match. */
export function matchAction(actions: HttpAction[], body: string): MatchResult | null {
  for (const action of actions) {
    const { type, value, caseSensitive } = action.match;
    const hay = caseSensitive ? body : body.toLowerCase();
    const needle = caseSensitive ? value : value.toLowerCase();
    if (type === 'exact') {
      if (hay === needle) return { action, args: [] };
    } else if (hay.startsWith(needle)) {
      return { action, args: parseArgs(body.slice(value.length)) };
    }
  }
  return null;
}
