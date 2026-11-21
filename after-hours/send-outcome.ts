// A send that threw may still have reached WhatsApp. From OpenWA 0.31.0 the host says so in the error text
// ("... it may or may not have been sent ...") where it used to call every such failure safe to retry, and a
// send verb that times out on the host can still land late. Only the message text crosses the worker
// boundary, so the text is the signal; hosts before 0.31.0 never word an error this way.
const OUTCOME_UNKNOWN =
  /\bmay or may not have been (?:sent|published)\b|\bcapability '[\w.]+' timed out after \d+ms\b/i;

/** Whether a failed send might nevertheless have gone out, so repeating it could deliver the message twice. */
export function sendOutcomeUnknown(err: unknown): boolean {
  return OUTCOME_UNKNOWN.test(err instanceof Error ? err.message : String(err));
}
