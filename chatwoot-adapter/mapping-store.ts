import type { PluginStorage, PluginMappingsCapability, IncomingMessage } from '../types/openwa';

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

export class MappingStore {
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
  private seenKey(kind: 'wa' | 'cw', id: string, scope?: string): string {
    return scope ? `seen:${scope}:${kind}:${id}` : `seen:${kind}:${id}`;
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
    return Boolean(await this.storage.get(this.seenKey(kind, id, scope)));
  }
  async markSeen(kind: 'wa' | 'cw', id: string, scope?: string, nowMs: number = Date.now()): Promise<void> {
    // Store a timestamp (not a bare `1`) so pruneSeen can age the marker out. hasSeen only checks presence.
    await this.storage.set(this.seenKey(kind, id, scope), { t: nowMs });
  }

  // Prune expired `seen:` markers so ctx.storage doesn't grow without bound (one file per marker) and the
  // retry drain's directory scan stays cheap. Streams keys one at a time (matching the drain's OOM-safe
  // discipline). A pre-0.5.2 marker stored as a bare `1` has no timestamp: it is ADOPTED (stamped with the
  // current time) rather than deleted, so it can never re-post a duplicate and ages out one TTL from here.
  // Touches only `seen:`-prefixed keys — the list() prefix is filtered defensively (a fake ignoring the
  // arg would otherwise return every key).
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

  async unlinkByChatId(sessionId: string, chatId: string) {
    await this.storage.delete(this.fwdKey(sessionId, chatId));
  }

  async unlinkByConversationId(sessionId: string, conversationId: number) {
    await this.storage.delete(this.revKey(sessionId, conversationId));
    await this.storage.delete(this.legacyRevKey(conversationId));
  }
}
