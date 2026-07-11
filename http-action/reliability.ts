// Reliability gates for HTTP Action Bot: idempotency (dedup) + per-chat cooldown + storage pruning.
//
// Dedup is split into a read-only presence CHECK (hasSeen, fail-closed) and a MARK written only AFTER a
// successful reply (markSeen) — mirroring chatwoot's hasSeen/markSeen split, so a transient send failure
// leaves the message un-marked and a WhatsApp redelivery retries instead of being silently dropped. The
// marker is an object {t} and the dup decision is presence-based, so it does not hinge on the storage
// bridge preserving a bare number type. Cooldown is in-memory and FAIL-OPEN (it never throws, so it can
// never wrongly block). Pure modulo the injected storage.

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

interface Marker {
  t?: unknown;
}

const dedupKey = (sessionId: string, msgId: string): string => `${KEY_PREFIX}${sessionId}:${msgId}`;

/** Read-only presence check. True if `msgId` is already marked (or on storage error → fail-closed drop). */
export async function hasSeen(storage: StorageLike, sessionId: string, msgId: string): Promise<boolean> {
  try {
    const v = await storage.get<Marker>(dedupKey(sessionId, msgId));
    return v !== null && v !== undefined;
  } catch {
    return true; // fail-closed: can't read → drop rather than risk a double-fire
  }
}

/** Record a marker AFTER a successful reply so a failed send retries on redelivery. Best-effort. */
export async function markSeen(storage: StorageLike, sessionId: string, msgId: string, now: number): Promise<void> {
  try {
    await storage.set(dedupKey(sessionId, msgId), { t: now });
  } catch {
    /* best-effort: a redelivery may re-fire, which is the safer failure mode */
  }
}

/** Delete dedup markers older than `ttlMs`. Throttled by a persisted last-prune timestamp; best-effort. */
export async function prune(
  storage: StorageLike,
  now: number,
  ttlMs: number,
  intervalMs: number,
): Promise<{ ran: boolean; pruned: number }> {
  let last: Marker | null;
  try {
    last = await storage.get<Marker>(PRUNE_KEY);
  } catch {
    last = null;
  }
  if (last !== null && typeof last.t === 'number' && now - last.t < intervalMs) {
    return { ran: false, pruned: 0 };
  }
  try {
    await storage.set(PRUNE_KEY, { t: now });
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
    let m: Marker | null;
    try {
      m = await storage.get<Marker>(k);
    } catch {
      continue;
    }
    if (m !== null && typeof m.t === 'number' && now - m.t > ttlMs) {
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
