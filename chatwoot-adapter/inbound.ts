import type { IncomingMessage } from '../types/openwa';
import { shouldRelayInbound } from './filters.ts';
import { relayMessage, ensureConversation, refreshContactName, type InboundDeps } from './relay.ts';
import { backfillHistory } from './backfill.ts';
import { MAX_PENDING_RETRIES, slimForRetry } from './retry.ts';

export type { InboundDeps };

// The resolve + backfill + relay core, lock-free, that THROWS on failure. Shared by the live inbound
// handler and the retry drain (retry.ts) so a retried message follows the exact same path. `opts.recoverOn404`
// defaults TRUE for the live path; the retry drain (index.ts) flips it FALSE so drain attempts against a
// still-dangling mapping burn their retry-budget instead of minting a fresh orphan conversation per
// attempt — the next LIVE inbound recovers the chat.
export async function relayInbound(
  deps: InboundDeps,
  sessionId: string,
  msg: IncomingMessage,
  opts: { recoverOn404?: boolean } = {},
): Promise<void> {
  const recoverOn404 = opts.recoverOn404 ?? true;
  // Best-effort @lid -> <phone>@c.us for the LOOKUP only (never the lock — see handleInbound). Raw-fallback:
  // canonicalChatId needs a live engine, but the retry drain re-relays messages whose WA session may be
  // offline (the relay is a Chatwoot post that doesn't need it), so a failure must not block the relay.
  let canonical = msg.chatId;
  try {
    canonical = await deps.engine.canonicalChatId(sessionId, msg.chatId);
  } catch {
    /* session down / unresolvable — fall back to the raw id; dedup is best-effort */
  }
  const { conversationId, created, foundKey } = await resolveConversation(deps, sessionId, msg, canonical);
  // Lazy backfill: the first time this chat maps, replay its recent history (older messages, both
  // directions, deduped) BEFORE posting this one — so the thread reads chronologically and this message's
  // quote resolves against a just-posted source_id. This message is already markSeen, so backfill skips it.
  if (created && deps.backfillLimit > 0) {
    await backfillHistory(deps, sessionId, msg.chatId, conversationId);
  }
  try {
    await relayMessage(deps, sessionId, conversationId, msg, 'incoming');
  } catch (err) {
    // A 404 mid-relay means the CACHED conversation id is gone — almost always because an operator
    // (or Chatwoot) deleted the conversation out-of-band, leaving the conv<->WA mapping dangling. Drop
    // the stale forward + scoped + legacy reverse keys and rebuild via the same resolveConversation ->
    // ensureConversation path; then retry once. A second failure (404 or anything) survives the rebuild
    // and falls through to the regular enqueueRetry -> drainRetries pipeline with its 5-attempt cap, so
    // a wedged Chatwoot or a misconfigured inbox cannot loop here.
    if ((err as { status?: number } | null)?.status !== 404) throw err;
    // Drain path: same 404, but the drain is already a re-attempt of a previously failed relay. Rebuilding
    // here would mint a fresh orphan conversation per attempt (up to 5) and never converge — better to let
    // the retry budget run out and let the NEXT live inbound self-heal the chat.
    if (!recoverOn404) throw err;
    const originalErr = err;
    try {
      // Unlink the key the mapping actually lived under (resolveConversation returns it), not msg.chatId.
      // A migrated contact's mapping is often keyed under the canonical @c.us while msg.chatId is @lid —
      // unlinking the raw key would miss entirely, resolveConversation would re-find the stale row via its
      // canonical fallback, the second relay would 404 again, and the message would dead-letter.
      await deps.store.unlinkByChatId(sessionId, foundKey);
      await deps.store.unlinkByConversationId(sessionId, conversationId);
      const re = await resolveConversation(deps, sessionId, msg, canonical);
      // The deleted Chatwoot conversation is gone, so its history is gone too. When the rebuild mints a
      // brand-new conversation, re-import prior history under the same gate the happy path uses — a fresh
      // Chatwoot thread without context defeats the point of (lazy) backfill.
      if (re.created && deps.backfillLimit > 0) {
        await backfillHistory(deps, sessionId, msg.chatId, re.conversationId);
      }
      await relayMessage(deps, sessionId, re.conversationId, msg, 'incoming');
    } catch (rebuildErr) {
      deps.log('inbound 404-recovery failed; surfacing original 404 to retry queue', rebuildErr);
      throw originalErr;
    }
  }
}

// WhatsApp → Chatwoot. Filter, then run resolve+post under the per-chat lock so two near-simultaneous
// first messages can't create duplicate Chatwoot contacts/conversations. Inbound is AT-LEAST-ONCE: a
// failed relay is queued for retry (retry.ts drains it) rather than dropped.
export async function handleInbound(
  deps: InboundDeps,
  sessionId: string,
  source: string,
  msg: IncomingMessage,
): Promise<void> {
  if (!shouldRelayInbound(msg, source, deps.relayGroups)) return;
  // Lock on the RAW chatId, NOT the canonical one. canonicalChatId is best-effort and non-deterministic
  // (it returns @c.us when the lid->phone cache is warm, @lid when cold, and can throw when the session is
  // down), so using it as a lock key wouldn't reliably serialize two inbound for the same chat — that would
  // reintroduce the duplicate-conversation double-create. The raw id is deterministic and already converges
  // a migrated contact's inbound (they all carry chatId=@lid). The @lid dedup is done by the dual-lookup
  // inside relayInbound. Keeping the canonicalChatId call OUT of this path also means it can never throw
  // here and drop the message before it is markSeen/enqueued.
  await deps.lock.run(`${sessionId}:${msg.chatId}`, async () => {
    // markSeen stays BEFORE the relay: it dedups WA re-deliveries and makes backfill skip this live
    // message. It is NOT the "relayed" signal — a failed relay is enqueued below, and the pending-queue
    // entry is what drives retry, independent of this marker. Scoped by session so two tenants' WA message
    // ids can't collide in the shared plugin store.
    if (await deps.store.hasSeen('wa', msg.id, sessionId)) return;
    await deps.store.markSeen('wa', msg.id, sessionId);
    try {
      await relayInbound(deps, sessionId, msg);
    } catch (err) {
      deps.log('inbound relay failed; queued for retry', err);
      // Strip an oversized media blob before persisting so a huge value can't be rejected by the storage
      // layer (which would lose the message — it's already markSeen); the retry then posts a placeholder.
      const dropped = await deps.store
        .enqueueRetry({ sessionId, chatId: msg.chatId, msg: slimForRetry(msg), enqueuedAt: Date.now() }, MAX_PENDING_RETRIES)
        .catch(e => {
          deps.log('enqueue retry failed', e);
          return null;
        });
      if (dropped) deps.log(`retry queue full; dropped oldest pending inbound (msg ${dropped})`);
    }
  });
}

async function resolveConversation(
  deps: InboundDeps,
  sessionId: string,
  msg: IncomingMessage,
  canonicalChatId: string,
): Promise<{ conversationId: number; created: boolean; foundKey: string }> {
  // Dual lookup (re-read inside the lock): the raw chatId finds a mapping keyed by @lid, the canonical
  // chatId finds one keyed by @c.us (a contact that has since migrated to @lid, when the lid resolves) —
  // so a migrated contact's inbound lands in its EXISTING conversation instead of splitting a duplicate.
  // `foundKey` is the key the mapping actually lives under, so refreshContactName patches the right doc
  // AND the 404-recovery path knows which forward key to unlink (a migrated contact's stale row is under
  // the canonical key, NOT msg.chatId — unlinking the raw id would miss it entirely).
  let existing = await deps.store.getByChat(sessionId, msg.chatId);
  let foundKey = msg.chatId;
  if (!existing && canonicalChatId !== msg.chatId) {
    existing = await deps.store.getByChat(sessionId, canonicalChatId);
    foundKey = canonicalChatId;
  }
  if (existing) {
    await refreshContactName(deps, sessionId, msg, existing, foundKey);
    return { conversationId: existing.conversationId, created: false, foundKey };
  }
  const name = msg.isGroup
    ? `Group ${msg.chatId}`
    : msg.contact?.pushName || msg.contact?.name || msg.senderPhone || msg.chatId;
  const conversationId = await ensureConversation(deps, sessionId, msg.chatId, {
    name,
    phone: msg.isGroup ? undefined : msg.senderPhone ?? undefined,
  });
  // A freshly-created mapping lives under msg.chatId (ensureConversation links raw). The recovery path
  // reads foundKey off this return only when `created === false` (a 404 implies a row existed); the value
  // here is still defined so the return shape is uniform.
  return { conversationId, created: true, foundKey: msg.chatId };
}
