import type { ChatSummary, IncomingMessage } from '../types/openwa';
import { relayMessage, ensureConversation, resolvePhone, type InboundDeps } from './relay.ts';

// Media is inlined only for a window small enough to plausibly fit the host's 30 s per-capability budget.
// Above it the host downloads every blob serially — one Puppeteer round trip each, each separately bounded
// at 30 s — and the whole call times out with the history discarded. There is no cursor on getChatHistory,
// so paging is not an option; this is the only lever besides a smaller limit. Media messages above the
// threshold still relay as placeholderFor() lines, so the conversation's shape survives, only old
// attachments are absent.
const BACKFILL_MEDIA_MAX_LIMIT = 25;

// Fetch a chat's recent history oldest->newest. Returns `null` when the FETCH FAILED — a capability
// timeout, or an engine without history support (Baileys rejects) — and `[]` when the chat genuinely has
// no history. Callers MUST NOT treat the two alike: consuming a done-marker on a failure loses that
// chat's history permanently, which is exactly the bug this signature exists to prevent.
async function fetchHistory(deps: InboundDeps, sessionId: string, chatId: string): Promise<IncomingMessage[] | null> {
  try {
    const history = await deps.engine.getChatHistory(
      sessionId,
      chatId,
      deps.backfillLimit,
      deps.backfillLimit <= BACKFILL_MEDIA_MAX_LIMIT,
    );
    return [...history].sort((a, b) => a.timestamp - b.timestamp);
  } catch (err) {
    deps.log(`history fetch failed for ${chatId}`, err);
    return null;
  }
}

// Replay ordered history into a Chatwoot conversation. Deduped against the same markSeen store the live
// path uses. Per-message isolation: one failed post is logged and skipped, never aborting the rest; the
// message is marked seen only AFTER a successful post so a transient error stays retryable rather than a
// silent drop. Returns whether every attempted message actually posted — a caller that ignores this and
// records a completed import anyway would durably lose the messages a down Chatwoot rejected, which is
// the exact silent-loss bug this whole marker exists to remove. The caller holds the per-chat lock.
async function replayHistory(
  deps: InboundDeps,
  sessionId: string,
  conversationId: number,
  ordered: IncomingMessage[],
): Promise<boolean> {
  let allPosted = true;
  for (const msg of ordered) {
    if (await deps.store.hasSeen('wa', msg.id, sessionId)) continue;
    try {
      await relayMessage(deps, sessionId, conversationId, msg, msg.fromMe ? 'outgoing' : 'incoming');
      await deps.store.markSeen('wa', msg.id, sessionId);
    } catch (err) {
      deps.log(`history message ${msg.id} failed`, err);
      allPosted = false;
    }
  }
  return allPosted;
}

// Lazy per-conversation backfill: fetch + replay this chat's history into its (already-created)
// conversation. Returns false when the fetch failed OR when any message failed to post — either way the
// caller must retry later, never record a completed import. A genuinely empty history (nothing to post)
// is a successful no-op. markSeen dedup makes a retry cheap: only the messages that failed post again.
export async function backfillHistory(
  deps: InboundDeps,
  sessionId: string,
  chatId: string,
  conversationId: number,
): Promise<boolean> {
  const ordered = await fetchHistory(deps, sessionId, chatId);
  if (ordered === null) return false;
  return replayHistory(deps, sessionId, conversationId, ordered);
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
          // null (fetch failed) and [] (no history) both skip: never create an empty Chatwoot
          // conversation, and never post a partial import. A failed chat is picked up later by the lazy
          // path, which counts its own attempts.
          if (!ordered?.length) return;
          // chat.id is already the neutral JID on this path (anti-corruption layer), so the phone can be
          // resolved from it without an engine call. Groups skip (no MSISDN); a cold @lid stays no-phone.
          const conversationId = await ensureConversation(deps, sessionId, chat.id, {
            name: chat.name || chat.id,
            phone: resolvePhone(chat, chat.id),
          });
          const allPosted = await replayHistory(deps, sessionId, conversationId, ordered);
          // Share the lazy path's marker — but only when every message actually posted. A sweep that hit a
          // down Chatwoot partway through must not record a completed import, or the unposted messages are
          // lost for good instead of being picked up (and counted) by the lazy path's own retry budget.
          if (allPosted) await deps.store.patch(sessionId, chat.id, { backfillDone: true });
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
