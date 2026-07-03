import type { ChatSummary } from '../types/openwa';
import { relayMessage, ensureConversation, type InboundDeps } from './relay.ts';

// Replay a chat's recent history into its Chatwoot conversation: oldest→newest, both directions, deduped
// against the same markSeen store the live path uses (so a live message is never doubled). The caller
// holds the per-chat lock. Best-effort: any failure is logged, never thrown into the live relay.
export async function backfillHistory(
  deps: InboundDeps,
  sessionId: string,
  chatId: string,
  conversationId: number,
): Promise<void> {
  try {
    const history = await deps.engine.getChatHistory(sessionId, chatId, deps.backfillLimit, true);
    const ordered = [...history].sort((a, b) => a.timestamp - b.timestamp);
    for (const msg of ordered) {
      if (await deps.store.hasSeen('wa', msg.id, sessionId)) continue;
      await deps.store.markSeen('wa', msg.id, sessionId);
      await relayMessage(deps, conversationId, msg, msg.fromMe ? 'outgoing' : 'incoming');
    }
  } catch (err) {
    deps.log('history backfill failed', err);
  }
}

// In-memory guard so rapid successive inbounds can't launch the one-time sweep twice for a session.
const bulkInFlight = new Set<string>();

// One-time bulk sweep (opt-in): create a Chatwoot conversation for every existing chat and backfill its
// history. Sequential — no parallel fan-out at Chatwoot — and best-effort: a per-chat failure never
// aborts the sweep. Runs once per session behind a durable marker plus the in-memory in-flight guard.
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
          const conversationId = await ensureConversation(deps, sessionId, chat.id, { name: chat.name || chat.id });
          await backfillHistory(deps, sessionId, chat.id, conversationId);
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
