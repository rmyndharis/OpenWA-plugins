import type { IncomingMessage } from '../types/openwa';
import { shouldRelayInbound } from './filters.ts';
import { relayMessage, ensureConversation, refreshContactName, resolvePhone, type InboundDeps } from './relay.ts';
import { backfillHistory } from './backfill.ts';
import { MAX_PENDING_RETRIES, slimForRetry } from './retry.ts';

export type { InboundDeps };

// A chat's history import gets a bounded number of tries. Backfill runs inside the per-chat lock and
// BEFORE the live relay, so an unbounded retry would add a full 30 s capability timeout to every inbound
// message on a chat that can never be imported.
export const MAX_BACKFILL_ATTEMPTS = 3;

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
  const { conversationId, key, backfill } = await resolveConversation(deps, sessionId, msg, canonical);
  // Lazy backfill: replay this chat's recent history (older messages, both directions, deduped) BEFORE
  // posting this one, so the thread reads chronologically and this message's quote resolves against a
  // just-posted source_id. This message is already markSeen, so backfill skips it.
  //
  // The trigger is the stored marker, NOT "the conversation was just created". The old derivation could
  // only ever fire once: a failed fetch left the conversation in place, so every later message saw
  // created=false and the chat never got its history.
  //
  // `=== false` and not `!backfill.done`: the marker must be POSITIVELY present. ensureConversation
  // stamps `backfillDone: false` on every mapping this version creates, so absent means the mapping
  // predates the marker — a chat an earlier release already handled, which must be left alone. The
  // tradeoff is deliberate: a chat whose import failed before the upgrade is never retried, which is
  // exactly what those installs do today; every chat from here on gets the durable retry.
  await maybeBackfill(deps, sessionId, msg.chatId, conversationId, key, backfill);
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
      await deps.store.unlinkByChatId(sessionId, key);
      await deps.store.unlinkByConversationId(sessionId, conversationId);
      const re = await resolveConversation(deps, sessionId, msg, canonical);
      // The deleted Chatwoot conversation is gone, so its history is gone too. When the rebuild mints a
      // brand-new conversation, re-import prior history under the same gate the happy path uses — a fresh
      // Chatwoot thread without context defeats the point of (lazy) backfill.
      await maybeBackfill(deps, sessionId, msg.chatId, re.conversationId, re.key, re.backfill);
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
    try {
      // markSeen is INSIDE the try so that a storage failure here takes the same enqueue-for-retry path as
      // a failed relay. Left outside, a rejected marker write (the host rejects every `set` once the plugin
      // is at its storage quota) threw straight out of the hook with the message neither relayed nor queued.
      await deps.store.markSeen('wa', msg.id, sessionId);
      await relayInbound(deps, sessionId, msg);
    } catch (err) {
      deps.log('inbound relay failed; queued for retry', err);
      deps.onRelayError(err);
      // Strip an oversized media blob before persisting so a huge value can't be rejected by the storage
      // layer (which would lose the message — it's already markSeen); the retry then posts a placeholder.
      const dropped = await deps.store
        .enqueueRetry({ sessionId, chatId: msg.chatId, msg: slimForRetry(msg), enqueuedAt: Date.now() }, MAX_PENDING_RETRIES)
        .catch(e => {
          // The enqueue itself failed, so the message is gone: it is already marked seen (or failed to be),
          // and nothing is stored for the drain to pick up. Report it — the retry queue cannot count an
          // entry that was never written, so this is invisible to healthCheck otherwise.
          deps.onInboundLost(msg.id, e);
          return null;
        });
      if (dropped) deps.log(`retry queue full; dropped oldest pending inbound (msg ${dropped})`);
    }
  });
}

// The import marker is bookkeeping; the message is the product. A rejected write — the host rejects
// EVERY `set` once the plugin is at its 50 MiB quota — must cost at most one redundant import on the
// next message. Unguarded it threw past relayMessage, so a perfectly relayable message became a
// retry-queue entry whose drain re-ran the whole 30 s import behind it. Mirrors refreshContactName.
async function recordBackfill(
  deps: InboundDeps,
  sessionId: string,
  key: string,
  patch: { backfillDone?: boolean; backfillAttempts?: number },
): Promise<void> {
  try {
    await deps.store.patch(sessionId, key, patch);
  } catch (err) {
    deps.log('backfill marker write failed', err);
  }
}

// The marker-driven backfill gate, shared by the live resolve and the 404-recovery rebuild: both hand this
// a resolveConversation result and it decides whether to import, records the outcome, and reports exhaustion
// — so the two call sites can't drift apart on when a chat is eligible for import.
async function maybeBackfill(
  deps: InboundDeps,
  sessionId: string,
  chatId: string,
  conversationId: number,
  key: string,
  backfill: { done?: boolean; attempts?: number },
): Promise<void> {
  const attempts = backfill.attempts ?? 0;
  if (!(deps.backfillLimit > 0 && backfill.done === false && attempts < MAX_BACKFILL_ATTEMPTS)) return;
  if (await backfillHistory(deps, sessionId, chatId, conversationId)) {
    await recordBackfill(deps, sessionId, key, { backfillDone: true });
  } else {
    const next = attempts + 1;
    await recordBackfill(deps, sessionId, key, { backfillAttempts: next });
    if (next >= MAX_BACKFILL_ATTEMPTS) deps.onBackfillExhausted(key);
  }
}

// Resolves the Chatwoot conversation for this chat and reports where its mapping document lives, so the
// caller patches the SAME document refreshContactName does, plus that document's backfill state.
async function resolveConversation(
  deps: InboundDeps,
  sessionId: string,
  msg: IncomingMessage,
  canonicalChatId: string,
): Promise<{ conversationId: number; key: string; backfill: { done?: boolean; attempts?: number } }> {
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
    return {
      conversationId: existing.conversationId,
      key: foundKey,
      backfill: { done: existing.backfillDone, attempts: existing.backfillAttempts },
    };
  }
  const name = msg.isGroup
    ? `Group ${msg.chatId}`
    : msg.contact?.pushName || msg.contact?.name || msg.senderPhone || msg.chatId;
  const conversationId = await ensureConversation(deps, sessionId, msg.chatId, {
    // Phone from the host-resolved sender (RESOLVE_LID_TO_PHONE), or the canonical chat id (warm lid→pn
    // cache / every plain @c.us chat); undefined when genuinely unknown so the contact still creates.
    name,
    phone: resolvePhone(msg, canonicalChatId),
  });
  // ensureConversation wrote the mapping under msg.chatId, stamped `backfillDone: false`. Mirroring that
  // value here rather than reading the document back saves a storage round trip on every new chat.
  return { conversationId, key: msg.chatId, backfill: { done: false } };
}
