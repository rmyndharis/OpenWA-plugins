import type { ChatSummary, IncomingMessage } from '../types/openwa';
import { relayMessage, ensureConversation, type InboundDeps } from './relay.ts';

// Fetch a chat's recent history oldest->newest. Best-effort: any failure (including an engine that does
// not support history, e.g. Baileys, which rejects) yields an empty list so callers degrade cleanly.
async function fetchHistory(deps: InboundDeps, sessionId: string, chatId: string): Promise<IncomingMessage[]> {
  try {
    const history = await deps.engine.getChatHistory(sessionId, chatId, deps.backfillLimit, true);
    return [...history].sort((a, b) => a.timestamp - b.timestamp);
  } catch (err) {
    deps.log(`history fetch failed for ${chatId}`, err);
    return [];
  }
}

// Replay ordered history into a Chatwoot conversation. Deduped against the same markSeen store the live
// path uses. Per-message isolation: one failed post is logged and skipped, never aborting the rest; the
// message is marked seen only AFTER a successful post so a transient error stays retryable rather than a
// silent drop. The caller holds the per-chat lock.
async function replayHistory(
  deps: InboundDeps,
  sessionId: string,
  conversationId: number,
  ordered: IncomingMessage[],
): Promise<void> {
  for (const msg of ordered) {
    if (await deps.store.hasSeen('wa', msg.id, sessionId)) continue;
    try {
      await relayMessage(deps, sessionId, conversationId, msg, msg.fromMe ? 'outgoing' : 'incoming');
      await deps.store.markSeen('wa', msg.id, sessionId);
    } catch (err) {
      deps.log(`history message ${msg.id} failed`, err);
    }
  }
}

// Lazy per-conversation backfill: fetch + replay this chat's history into its (already-created)
// conversation. Empty/unsupported history is a no-op.
export async function backfillHistory(
  deps: InboundDeps,
  sessionId: string,
  chatId: string,
  conversationId: number,
): Promise<void> {
  await replayHistory(deps, sessionId, conversationId, await fetchHistory(deps, sessionId, chatId));
}

// In-memory guard so rapid successive inbounds can't launch the one-time sweep twice for a session.
const bulkInFlight = new Set<string>();

// One-time bulk sweep (opt-in): for every existing chat WITH history, create a Chatwoot conversation and
// backfill it. History is fetched BEFORE ensureConversation, so a chat with no fetchable history (or an
// engine without history support) never creates an empty conversation. Sequential and best-effort — a
// per-chat failure never aborts the sweep. Runs once per session behind a durable marker + the in-flight
// guard.
export async function backfillAllChats(deps: InboundDeps, sessionId: string): Promise<void> {
  // Add to the in-flight set BEFORE the first await, so a concurrent call from a rapid second inbound
  // sees it synchronously and bails — otherwise both could pass the durable-marker check and double-sweep.
  if (bulkInFlight.has(sessionId)) return;
  bulkInFlight.add(sessionId);
  try {
    if (await deps.store.isBulkBackfilled(sessionId)) return;
    const chats = (await deps.engine.getChats(sessionId)) as ChatSummary[];
    for (const chat of chats) {
      if (chat.isGroup && !deps.relayGroups) continue;
      await deps.lock.run(`${sessionId}:${chat.id}`, async () => {
        try {
          const ordered = await fetchHistory(deps, sessionId, chat.id);
          if (!ordered.length) return; // nothing to import -> don't create an empty Chatwoot conversation
          const conversationId = await ensureConversation(deps, sessionId, chat.id, { name: chat.name || chat.id });
          await replayHistory(deps, sessionId, conversationId, ordered);
        } catch (err) {
          deps.log(`bulk backfill failed for ${chat.id}`, err);
        }
      });
    }
    await deps.store.setBulkBackfilled(sessionId);
  } catch (err) {
    deps.log('bulk backfill sweep failed', err);
  } finally {
    bulkInFlight.delete(sessionId);
  }
}
