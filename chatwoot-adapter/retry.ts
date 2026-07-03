import type { IncomingMessage } from '../types/openwa';
import type { MappingStore } from './mapping-store.ts';
import type { KeyedAsyncLock } from './chat-lock.ts';

// How often the retry queue is drained; how many times a message is retried before it's dead-lettered;
// and the max pending entries kept (older ones are dropped on overflow to bound ctx.storage).
export const RETRY_INTERVAL_MS = 30_000;
export const MAX_RETRY_ATTEMPTS = 5;
export const MAX_PENDING_RETRIES = 500;
// Cap the media blob persisted per queued entry. A larger blob is stripped (retried as a placeholder)
// rather than stored — so a queued entry can't exceed the host's per-value storage cap and get rejected,
// which would lose the whole message (it's already markSeen). ~700 KB base64 ≈ ~512 KB binary.
export const RETRY_MAX_MEDIA_B64 = 700_000;

// Return a copy safe to persist in the retry queue: an oversized media blob is dropped (marked omitted)
// so the retry posts a type placeholder instead of failing to persist. Small media is kept for a faithful
// retry. Pure.
export function slimForRetry(msg: IncomingMessage): IncomingMessage {
  const media = msg.media;
  if (media?.data && media.data.length > RETRY_MAX_MEDIA_B64) {
    return { ...msg, media: { ...media, data: undefined, omitted: true } };
  }
  return msg;
}

export interface DrainDeps {
  store: MappingStore;
  lock: KeyedAsyncLock;
  log: (m: string, e?: unknown) => void;
}

// Drain the inbound retry queue: re-relay each queued failed message under its per-chat lock (so it
// serializes with a concurrent live inbound for the same chat). Success drops the entry; a failure bumps
// its attempt count, and once attempts reach `maxAttempts` the message is dead-lettered (logged + dropped)
// rather than retried forever. `relay` re-posts the message and throws on failure. Returns how many were
// dead-lettered this run, for the plugin health check.
export async function drainRetries(
  deps: DrainDeps,
  relay: (sessionId: string, chatId: string, msg: IncomingMessage) => Promise<void>,
  maxAttempts: number,
): Promise<{ deadLettered: number }> {
  // Stream by key so a large media backlog is never fully resident: fetch one entry at a time.
  const keys = await deps.store.listRetryKeys();
  let deadLettered = 0;
  for (const key of keys) {
    const e = await deps.store.getRetry(key);
    if (!e) continue; // key vanished since the scan (already drained/dropped) — nothing to do
    // Lock on the RAW chatId, same deterministic key live inbound uses for this chat. @lid canonicalization
    // is a lookup concern handled inside relayInbound (best-effort), not a lock concern.
    await deps.lock.run(`${e.sessionId}:${e.chatId}`, async () => {
      let relayed = false;
      try {
        await relay(e.sessionId, e.chatId, e.msg);
        relayed = true;
      } catch (err) {
        const attempts = e.attempts + 1;
        if (attempts >= maxAttempts) {
          deps.log(`inbound relay dead-lettered after ${attempts} attempts (chat ${e.chatId}, msg ${e.msg.id})`, err);
          await deps.store.deleteRetry(e.key);
          deadLettered++;
        } else {
          await deps.store.bumpRetryAttempts(e.key, attempts);
        }
      }
      // Delete OUTSIDE the try: a storage.delete failure after a SUCCESSFUL post must not be caught as a
      // relay failure (which would bump attempts and re-post the already-delivered message next drain).
      if (relayed) {
        await deps.store.deleteRetry(e.key).catch(err => deps.log('deleteRetry after a successful relay failed', err));
      }
    });
  }
  return { deadLettered };
}
