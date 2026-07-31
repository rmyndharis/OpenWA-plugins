import type { PluginStorage, PluginMappingsCapability, IncomingMessage } from '../types/openwa';
import { KeyedAsyncLock } from './chat-lock.ts';

// A failed inbound relay held for retry. The full message (incl. media) is stored so the retry re-posts
// it faithfully. `enqueuedAt` is a wall-clock ms used only to pick the oldest entry to drop on overflow.
export interface RetryEntry {
  sessionId: string;
  chatId: string;
  msg: IncomingMessage;
  attempts: number;
  enqueuedAt: number;
}

export interface ChatLink {
  conversationId: number;
  contactId: number;
  sourceId: string;
  handoverState?: 'bot' | 'human' | 'closed';
  // Last name synced to the Chatwoot contact. Lets inbound skip a redundant rename and detect when a real
  // pushName has arrived for a contact first seeded with a bare JID. Absent on pre-0.2.0 rows.
  name?: string;
  // History-import state. Kept on this document rather than in its own key: the host re-measures the
  // 50 MiB quota by stat-ing every key on every write, so key COUNT is a per-message cost. `done` and
  // `attempts` stay separate on purpose — a retry budget that ran out must never be recorded as a
  // completed import, which is precisely how the previous `created`-derived trigger lost history.
  backfillDone?: boolean;
  backfillAttempts?: number;
}

// Single-document-per-chat mapping over ctx.storage, mirrored into the core ctx.mappings row so the
// session+chat handover gate and handover.set can resolve this chat. `ctx.storage` is plugin-GLOBAL
// (shared across every session/instance), and Chatwoot conversation + message ids are per-account
// autoincrement, so anything keyed by id alone collides across tenants. The reverse map and dedup markers
// are therefore scoped by the WA sessionId (the one identity both the inbound hook and the outbound
// ingress delivery share). A session-scoped legacy reverse key is ALSO written so a delivery that arrives
// without a session scope (or a pre-scope row) still resolves — unscoped, so single-tenant is unaffected.
// Retention window for `seen:` de-dup markers, and how often expired ones are pruned. Hardcoded (mirroring
// the retry-timer constants in retry.ts) — a generous default that outlasts any realistic WhatsApp message
// re-delivery, so pruning never re-posts a duplicate. Bumping the TTL is a one-line change.
export const SEEN_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
export const SEEN_PRUNE_INTERVAL_MS = 60 * 60 * 1000; // hourly

// Dedup markers live in a FIXED number of sharded buckets, not one storage key per message.
//
// The host re-measures its 50 MiB per-plugin storage quota on EVERY `set` by readdir-ing the plugin's
// data directory and stat-ing every key — synchronously, on the gateway's own event loop. A key per
// message therefore made each inbound message cost O(total markers) syscalls: a session at 10 msg/min
// holds ~43k markers within the 3-day TTL, so every message stalled the whole gateway (HTTP, websocket,
// engine callbacks) while the host stat-ed 43k files, and the prune then issued 43k more round-trips.
//
// Sharding by a hash of the logical marker id makes that cost constant — SEEN_SHARDS keys forever — while
// keeping the per-message work identical to before (one get, one set). Each bucket drops its own expired
// entries when it is written, so no global scan is needed to bound growth. More shards means more (tiny)
// files to stat per write but smaller values to parse; 256 keeps both trivial.
export const SEEN_SHARDS = 256;

// FNV-1a (32-bit). Only needs to spread ids evenly across buckets — not to resist collisions, since a
// bucket stores the full logical id as its entry key and a collision merely shares a file.
// Exported so a test can construct two ids that deliberately land in the same bucket.
export function shardOf(logicalId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < logicalId.length; i++) {
    h ^= logicalId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % SEEN_SHARDS;
}

// One bucket: logical marker id -> first-seen wall-clock ms.
type SeenBucket = Record<string, number>;

export class MappingStore {

  // Serializes the read-modify-write inside markSeen, per bucket. A bucket holds many markers, so two
  // concurrent marks — an inbound on one chat and the echo marker for a different conversation — can
  // hash into the SAME bucket and interleave their get/set, and the later write would drop the earlier
  // marker. The surrounding per-chat and per-conversation locks cannot prevent it: they are keyed by
  // chat, and a shard is shared across chats. Losing a 'cw' marker re-sends an agent's reply to the
  // contact; losing a 'wa' marker re-posts an inbound to Chatwoot. The pre-0.6.0 one-key-per-marker
  // scheme had no read-modify-write and so no such window — this lock restores that guarantee.
  // Lock order is always caller-lock → bucket-lock (nothing takes a chat lock while holding this), so
  // it cannot deadlock against them.
  private readonly bucketLock = new KeyedAsyncLock();

  constructor(
    private readonly storage: PluginStorage,
    private readonly mappings: PluginMappingsCapability,
  ) {}

  private fwdKey(sessionId: string, chatId: string): string {
    return `conv:${sessionId}:${chatId}`;
  }
  private revKey(sessionId: string, conversationId: number): string {
    return `wa:${sessionId}:${conversationId}`;
  }
  private legacyRevKey(conversationId: number): string {
    return `wa:${conversationId}`;
  }
  // The pre-0.6.0 key: ONE storage file per marker. Still read (see hasSeen) until the last of them has
  // aged out, and still pruned by pruneSeen — never written again.
  private legacySeenKey(kind: 'wa' | 'cw', id: string, scope?: string): string {
    return scope ? `seen:${scope}:${kind}:${id}` : `seen:${kind}:${id}`;
  }

  // The logical marker id, scope+kind included so every tenant and both marker kinds share ONE shard
  // pool — key count stays SEEN_SHARDS no matter how many sessions the host runs.
  private seenId(kind: 'wa' | 'cw', id: string, scope?: string): string {
    return scope ? `${scope}:${kind}:${id}` : `${kind}:${id}`;
  }

  // Deliberately NOT under the `seen:` prefix: pruneSeen treats every `seen:`-prefixed value without a
  // numeric `.t` as a legacy marker and ADOPTS it by overwriting it with `{ t: now }` — which would erase
  // a whole bucket every hour. `seenb:` does not match a `seen:` prefix filter, so the two never mix.
  private seenBucketKey(shard: number): string {
    return `seenb:s${shard}`;
  }

  getByChat(sessionId: string, chatId: string): Promise<ChatLink | null> {
    return this.storage.get<ChatLink>(this.fwdKey(sessionId, chatId));
  }

  // Resolve the WA chat for a Chatwoot conversation. With a `sessionId` (a delivery that carries its
  // session scope), the tenant-scoped key wins — isolating two accounts that share a conversation id.
  // Without one, fall back to the unscoped key (single-tenant / pre-scope data), same as before.
  async getByConversation(
    conversationId: number,
    sessionId?: string,
  ): Promise<{ sessionId: string; chatId: string } | null> {
    if (sessionId) {
      const scoped = await this.storage.get<{ sessionId: string; chatId: string }>(this.revKey(sessionId, conversationId));
      if (scoped) return scoped;
    }
    return this.storage.get<{ sessionId: string; chatId: string }>(this.legacyRevKey(conversationId));
  }

  async link(sessionId: string, chatId: string, instanceId: string, link: ChatLink): Promise<void> {
    await this.storage.set(this.fwdKey(sessionId, chatId), link);
    const rev = { sessionId, chatId };
    await this.storage.set(this.revKey(sessionId, link.conversationId), rev); // tenant-scoped lookup
    await this.storage.set(this.legacyRevKey(link.conversationId), rev); // back-compat for scope-less deliveries
    await this.mappings.upsert({ sessionId, chatId, instanceId }, String(link.conversationId));
  }

  async patch(sessionId: string, chatId: string, patch: Partial<ChatLink>): Promise<void> {
    const existing = await this.getByChat(sessionId, chatId);
    if (!existing) return;
    await this.storage.set(this.fwdKey(sessionId, chatId), { ...existing, ...patch });
  }

  // Idempotency markers, split so the caller controls WHEN the mark lands (outbound marks only AFTER a
  // successful send, so a transient failure retries instead of silently dropping the reply). `scope`
  // isolates a tenant's markers; both sides of a given `kind` must pass the same scope.
  async hasSeen(kind: 'wa' | 'cw', id: string, scope?: string): Promise<boolean> {
    const logicalId = this.seenId(kind, id, scope);
    const bucket = await this.storage.get<SeenBucket>(this.seenBucketKey(shardOf(logicalId)));
    if (bucket && bucket[logicalId] !== undefined) return true;
    // Upgrade path: a marker written by <=0.5.7 lives in its own key. Missing it would re-post an inbound
    // message on WhatsApp re-delivery and — worse, via the 'cw' marker — send a Chatwoot reply to the
    // recipient a SECOND time.
    //
    // There is deliberately no "no legacy keys left, stop looking" flag. The only way to decide that is a
    // storage listing, and the host's list() swallows its own errors and resolves [] — indistinguishable
    // from genuinely empty. A flag built on that retires permanently on one transient failure, and the
    // failure it causes is a duplicate message the CUSTOMER sees. The price of not having it is one extra
    // read per not-yet-seen message, against the 43k stat calls per write this release removed.
    return Boolean(await this.storage.get(this.legacySeenKey(kind, id, scope)));
  }

  async markSeen(kind: 'wa' | 'cw', id: string, scope?: string, nowMs: number = Date.now()): Promise<void> {
    const logicalId = this.seenId(kind, id, scope);
    const key = this.seenBucketKey(shardOf(logicalId));
    // Serialized per bucket: see bucketLock. Every await between the read and the write is an IPC
    // round-trip to the host, so the window is wide, not theoretical.
    await this.bucketLock.run(key, async () => {
      const bucket = (await this.storage.get<SeenBucket>(key)) ?? {};
      // Age the bucket out on write, so growth is bounded without a global scan. A bucket that stops
      // receiving writes keeps its last window of ids — bounded, and harmless (they only ever match ids
      // that will never recur).
      const next: SeenBucket = { [logicalId]: nowMs };
      for (const [k, t] of Object.entries(bucket)) {
        if (k !== logicalId && nowMs - t <= SEEN_TTL_MS) next[k] = t;
      }
      await this.storage.set(key, next);
    });
  }

  // Drain the pre-0.6.0 per-message `seen:` markers. Since 0.6.0 nothing writes them — new markers go into
  // the sharded `seenb:` buckets, which age themselves out on write — so this only empties the leftovers
  // from an upgraded install, and clearing the last one retires hasSeen's legacy read.
  // Streams keys one at a time (matching the drain's OOM-safe discipline). A pre-0.5.2 marker stored as a
  // bare `1` has no timestamp: it is ADOPTED (stamped with the current time) rather than deleted, so it can
  // never re-post a duplicate and ages out one TTL from here. Touches only `seen:`-prefixed keys — the
  // list() prefix is filtered defensively (a fake ignoring the arg would otherwise return every key), and
  // `seenb:` buckets do not match that prefix, which is exactly why they use a different one.
  async pruneSeen(nowMs: number, ttlMs: number): Promise<{ pruned: number; adopted: number }> {
    const keys = (await this.storage.list('seen:')).filter(k => k.startsWith('seen:'));
    let pruned = 0;
    let adopted = 0;
    for (const key of keys) {
      const v = await this.storage.get<unknown>(key);
      if (v == null) continue; // vanished since the scan — nothing to do
      const t =
        typeof v === 'object' && v !== null && typeof (v as { t?: unknown }).t === 'number'
          ? (v as { t: number }).t
          : undefined;
      if (t === undefined) {
        await this.storage.set(key, { t: nowMs }); // legacy/malformed marker → adopt
        adopted++;
      } else if (nowMs - t > ttlMs) {
        await this.storage.delete(key);
        pruned++;
      }
    }
    return { pruned, adopted };
  }

  // Durable run-once marker for the one-time bulk history sweep, per WA session.
  async isBulkBackfilled(sessionId: string): Promise<boolean> {
    return Boolean(await this.storage.get(`backfill:all:${sessionId}`));
  }
  async setBulkBackfilled(sessionId: string): Promise<void> {
    await this.storage.set(`backfill:all:${sessionId}`, 1);
  }

  // ---- Inbound retry queue (durable, over ctx.storage) --------------------------------------------
  // Individual keys `retry:<sessionId>:<msgId>` — one per failed relay — so concurrent enqueues never
  // read-modify-write a shared array. The list is filtered by the `retry:` prefix defensively (the host
  // list(prefix) already narrows, but a fake that ignores the arg would otherwise leak other keys).

  private retryKey(sessionId: string, msgId: string): string {
    return `retry:${sessionId}:${msgId}`;
  }

  private async retryKeys(): Promise<string[]> {
    return (await this.storage.list('retry:')).filter(k => k.startsWith('retry:'));
  }

  private async readRetries(keys: string[]): Promise<Array<RetryEntry & { key: string }>> {
    const out: Array<RetryEntry & { key: string }> = [];
    for (const key of keys) {
      const e = await this.storage.get<RetryEntry>(key);
      if (e) out.push({ ...e, key });
    }
    return out;
  }

  // Enqueue a failed inbound relay. No-op if this message id is already queued (never resets its attempt
  // count). When the queue is at `maxPending`, drop the OLDEST entry (returns its msg id so the caller can
  // log the loss) to bound storage. `attempts` starts at 0.
  async enqueueRetry(entry: Omit<RetryEntry, 'attempts'>, maxPending: number): Promise<string | null> {
    const key = this.retryKey(entry.sessionId, entry.msg.id);
    if (await this.storage.get(key)) return null;
    const keys = await this.retryKeys();
    let oldestKey: string | null = null;
    let dropped: string | null = null;
    if (keys.length >= maxPending) {
      // Only NOW load the values (to pick the oldest). The common under-cap path never deserializes any
      // queued blob — counting by key length keeps enqueue O(1) in payload size.
      const pending = await this.readRetries(keys);
      if (pending.length) {
        const oldest = pending.reduce((a, b) => (a.enqueuedAt <= b.enqueuedAt ? a : b));
        oldestKey = oldest.key;
        dropped = oldest.msg.id;
      }
    }
    // Write the NEW entry BEFORE deleting the oldest: if the set rejects (e.g. an oversized value), the
    // oldest is preserved instead of both being lost, and no drop is reported.
    await this.storage.set(key, { ...entry, attempts: 0 } satisfies RetryEntry);
    if (oldestKey) await this.storage.delete(oldestKey);
    return dropped;
  }

  async listRetries(): Promise<Array<RetryEntry & { key: string }>> {
    return this.readRetries(await this.retryKeys());
  }

  // Streaming primitives for the drain: list keys (a directory scan, no value loads), then fetch one
  // entry at a time — so a saturated queue of media messages is never all resident in memory at once.
  listRetryKeys(): Promise<string[]> {
    return this.retryKeys();
  }

  async getRetry(key: string): Promise<(RetryEntry & { key: string }) | null> {
    const e = await this.storage.get<RetryEntry>(key);
    return e ? { ...e, key } : null;
  }

  async bumpRetryAttempts(key: string, attempts: number): Promise<void> {
    const e = await this.storage.get<RetryEntry>(key);
    if (e) await this.storage.set(key, { ...e, attempts });
  }

  async deleteRetry(key: string): Promise<void> {
    await this.storage.delete(key);
  }

  // Count by key only — never load the (media-bearing) values, so a large backlog can't spike memory.
  async countRetries(): Promise<number> {
    return (await this.retryKeys()).length;
  }
}
