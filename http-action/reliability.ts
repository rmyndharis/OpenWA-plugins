// Reliability gates for HTTP Action Bot: idempotency (dedup) + per-chat cooldown + storage pruning.
//
// Dedup is split into a read-only presence CHECK (hasSeen, fail-closed) and a MARK written only AFTER a
// successful reply (markSeen) — mirroring chatwoot's hasSeen/markSeen split, so a transient send failure
// leaves the message un-marked and a WhatsApp redelivery retries instead of being silently dropped. The
// marker is an object {t} and the dup decision is presence-based, so it does not hinge on the storage
// bridge preserving a bare number type. Cooldown is in-memory and FAIL-OPEN (it never throws, so it can
// never wrongly block). Pure modulo the injected storage.
//
// Markers live in a FIXED number of sharded buckets, not one storage key per answered message. The host
// re-measures its 50 MiB per-plugin quota on EVERY `set` by readdir-ing the plugin's data directory and
// stat-ing every key, synchronously, on the gateway's own event loop. One key per message meant a busy
// install (20 commands a minute holds ~86,000 markers inside the 3-day window) made every storage write
// in the whole plugin, and in every other plugin, stat that many files.

import { KeyedAsyncLock } from './chat-lock.ts';

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

const BUCKET_PREFIX = 'dedupb:';
export const DEDUP_SHARDS = 256;

/** The pre-bucketing key: ONE storage file per marker. Still READ (see hasSeen) until the drain has
 *  emptied the last of them, and drained by prune — never written again. */
const legacyKey = (sessionId: string, msgId: string): string => `${KEY_PREFIX}${sessionId}:${msgId}`;

/** The logical marker id. Session included so two sessions never collide on a message id. */
const markerId = (sessionId: string, msgId: string): string => `${sessionId}:${msgId}`;

const bucketKey = (shard: number): string => `${BUCKET_PREFIX}s${shard}`;

/** FNV-1a (32-bit). Only needs to spread ids evenly; a bucket stores the full id as its entry key, so a
 *  collision merely shares a file. */
export function shardOf(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % DEDUP_SHARDS;
}

/** One bucket: logical marker id -> the wall-clock ms it was marked at. */
type DedupBucket = Record<string, number>;

// Serializes the read-modify-write in markSeen, per bucket. A bucket holds many markers and every await
// inside it is an IPC round-trip to the host, so two commands that hash together would interleave their
// get/set and the later write would drop the earlier marker. Losing a marker re-fires a real request
// against the operator's backend on redelivery, which is the one thing dedup exists to prevent.
const bucketLock = new KeyedAsyncLock();

/**
 * Read-only presence check. True if `msgId` is already marked (or on storage error → fail-closed drop).
 * `onError` is how the caller learns a drop was caused by storage rather than by a genuine duplicate:
 * without it, a failed read silently swallowed the command — no reply, no error template, no log line,
 * and the operator saw a command simply vanish.
 */
export async function hasSeen(
  storage: StorageLike,
  sessionId: string,
  msgId: string,
  onError?: (e: unknown) => void,
): Promise<boolean> {
  try {
    const id = markerId(sessionId, msgId);
    const bucket = await storage.get<DedupBucket>(bucketKey(shardOf(id)));
    if (bucket && bucket[id] !== undefined) return true;
    // Upgrade path: a marker written before bucketing lives in its own key, and missing it would fire a
    // second real request against the operator's backend on redelivery. There is deliberately no "no
    // legacy keys left, stop looking" flag: the only way to decide that is a storage listing, and the
    // host's list() resolves [] on its own errors, which is indistinguishable from genuinely empty, so
    // such a flag would retire permanently on one transient failure.
    const legacy = await storage.get<Marker>(legacyKey(sessionId, msgId));
    return legacy !== null && legacy !== undefined;
  } catch (e) {
    onError?.(e);
    return true; // fail-closed: can't read → drop rather than risk a double-fire
  }
}

/** Record a marker AFTER a successful reply so a failed send retries on redelivery. Best-effort. */
export async function markSeen(storage: StorageLike, sessionId: string, msgId: string, now: number): Promise<void> {
  const id = markerId(sessionId, msgId);
  const key = bucketKey(shardOf(id));
  try {
    await bucketLock.run(key, async () => {
      const bucket = (await storage.get<DedupBucket>(key)) ?? {};
      // Age the bucket out on write, so growth is bounded without any global scan. A bucket that stops
      // receiving writes keeps its last window of ids: bounded, and harmless, since they can only ever
      // match ids that will never recur.
      const next: DedupBucket = {};
      for (const [k, t] of Object.entries(bucket)) {
        if (typeof t === 'number' && now - t < DEDUP_TTL_MS) next[k] = t;
      }
      next[id] = now;
      await storage.set(key, next);
    });
  } catch {
    /* best-effort: a redelivery may re-fire, which is the safer failure mode */
  }
}

/**
 * Drain the per-message `dedup:` markers written before bucketing. Nothing writes them any more (a mark
 * goes into a `dedupb:` bucket, which ages itself out on write), so on a fresh install this finds
 * nothing and on an upgraded one it empties the leftovers. Throttled by a persisted last-prune
 * timestamp; best-effort.
 */
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

// The in-memory per-key cooldown lives in ./cooldown.ts (shared copy); re-exported here so existing
// imports from './reliability.ts' keep working.
export { allowCooldown } from './cooldown.ts';
