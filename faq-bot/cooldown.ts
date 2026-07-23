// In-memory per-key cooldown with an LRU cap. Pure — no ctx.
// NOTE: intentionally duplicated per plugin (plugins ship as self-contained zips) — keep all copies in
// sync; scripts/shared-copies.test.mjs fails the build when they drift.

const MAX_COOLDOWN_ENTRIES = 5000;

/**
 * Decide whether an action may go to `key` now. On allow, records `nowMs` (re-inserting so the map
 * evicts least-recently-used) and caps the map by dropping the LRU entry. A `cooldownMs` of 0 always allows.
 */
export function allowCooldown(map: Map<string, number>, key: string, nowMs: number, cooldownMs: number): boolean {
  const last = map.get(key);
  if (last !== undefined && nowMs - last < cooldownMs) return false;
  map.delete(key); // re-insert so iteration order tracks recency (LRU by touch)
  map.set(key, nowMs);
  if (map.size > MAX_COOLDOWN_ENTRIES) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest !== undefined) map.delete(oldest);
  }
  return true;
}
