// Reliability gates for HTTP Action Bot: idempotency (dedup) + per-chat cooldown + storage pruning.
// Dedup is storage-backed (survives worker restart, since WhatsApp redelivers the same message id) and
// FAIL-CLOSED — a storage error drops the message rather than risk a double-fire. Cooldown is in-memory
// and FAIL-OPEN (it never throws, so it can never wrongly block). Pure modulo the injected storage.

export interface StorageLike {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

const KEY_PREFIX = 'dedup:';
const PRUNE_KEY = 'dedup:__prune__';

/** Re-delivery window. WhatsApp redelivers within minutes; 3 days is generous and mirrors the repo norm. */
export const DEDUP_TTL_MS = 3 * 24 * 60 * 60 * 1000;
export const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // hourly

/** Check-and-mark `msgId` as seen for `sessionId`. True if newly claimed; false if a dup or storage error. */
export async function claim(
  storage: StorageLike,
  sessionId: string,
  msgId: string,
  ttlMs: number,
  now: number,
): Promise<boolean> {
  const key = `${KEY_PREFIX}${sessionId}:${msgId}`;
  let seen: unknown;
  try {
    seen = await storage.get<number>(key);
  } catch {
    return false; // fail-closed: can't read → drop rather than risk a double-fire
  }
  if (typeof seen === 'number' && now - seen < ttlMs) return false; // within TTL → duplicate
  try {
    await storage.set(key, now);
  } catch {
    return false; // fail-closed: couldn't mark → drop
  }
  return true;
}

/** Delete dedup markers older than `ttlMs`. Throttled by a persisted last-prune timestamp; best-effort. */
export async function prune(
  storage: StorageLike,
  now: number,
  ttlMs: number,
  intervalMs: number,
): Promise<{ ran: boolean; pruned: number }> {
  let last: unknown;
  try {
    last = await storage.get<number>(PRUNE_KEY);
  } catch {
    last = 0;
  }
  if (typeof last === 'number' && now - last < intervalMs) return { ran: false, pruned: 0 };
  try {
    await storage.set(PRUNE_KEY, now);
  } catch {
    /* best-effort: still attempt the sweep */
  }

  let keys: string[];
  try {
    keys = (await storage.list(KEY_PREFIX)).filter((k) => k.startsWith(KEY_PREFIX) && k !== PRUNE_KEY);
  } catch {
    return { ran: true, pruned: 0 };
  }

  let pruned = 0;
  for (const k of keys) {
    let t: unknown;
    try {
      t = await storage.get<number>(k);
    } catch {
      continue;
    }
    if (typeof t === 'number' && now - t > ttlMs) {
      try {
        await storage.delete(k);
        pruned++;
      } catch {
        /* leave it for next sweep */
      }
    }
  }
  return { ran: true, pruned };
}

const MAX_COOLDOWN_ENTRIES = 5000;

/** In-memory per-key cooldown, LRU-capped. True if allowed now (and records the touch); false if within the window. */
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
