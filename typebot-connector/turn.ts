import type { IncomingMessage, PluginConversationsCapability, ConversationSendEnvelope } from '../types/openwa';
import { phoneFromJid } from './jid.ts';
import type { TypebotConfig, OutgoingPart } from './typebot-types.ts';
import { TypebotHttpError } from './typebot-client.ts';
import type { TypebotClient, ContinueMessage } from './typebot-client.ts';
import type { SessionStore } from './session-store.ts';
import type { KeyedAsyncLock } from './chat-lock.ts';
import { inScope, sessionKey } from './filters.ts';
import { renderResponse } from './render.ts';
import { mapReply } from './reply-map.ts';

export interface TurnDeps {
  cfg: TypebotConfig;
  client: TypebotClient;
  store: SessionStore;
  lock: KeyedAsyncLock;
  conversations: PluginConversationsCapability;
  now: () => number;
  log: (m: string, e?: unknown) => void;
}

// From OpenWA 0.23.6 a Baileys session delivers, after it reconnects, what WhatsApp queued while it was
// disconnected, each message with its original send time. Five minutes is far above the clock skew
// between WhatsApp and the gateway and matches the host's own auto-reply age limit.
export const LATE_AFTER_MS = 5 * 60_000;

// One WhatsApp message → one Typebot turn. Runs under the per-key lock so concurrent messages from the same
// chat serialize (a concurrent continueChat would race the same server session row).
export async function handleTurn(deps: TurnDeps, sessionId: string, source: string, msg: IncomingMessage): Promise<void> {
  if (!inScope(msg, source, deps.cfg.respondInGroups)) return;
  const key = sessionKey(sessionId, msg);

  await deps.lock.run(key, async () => {
    let state = await deps.store.get(key);
    // When the contact wrote. `timestamp` is unix seconds; a missing, zero, negative, unrepresentable or
    // future one counts as now.
    const now = deps.now();
    const sent = new Date((msg.timestamp ?? 0) * 1000);
    const at = sent.getTime() > 0 ? Math.min(sent.getTime(), now) : now;
    // Idle is judged at the send time, so a reply typed during an outage still answers the step it saw.
    if (state && at - state.lastActivity > deps.cfg.sessionTimeoutMinutes * 60_000) state = null; // idle reset
    // Delivered late AND written well before the current step went out: the contact never saw that
    // prompt, so this is not its answer. index.ts has already claimed it; nothing is sent or stored.
    if (state && now - at > LATE_AFTER_MS && state.lastActivity - at > LATE_AFTER_MS) return;

    const prefilled = deps.cfg.passContactVariables ? contactVars(msg) : undefined;
    let resp;

    if (!state) {
      // Start from the top: the triggering message begins the session, it is NOT consumed as an answer.
      resp = await deps.client.startChat({ prefilledVariables: prefilled });
    } else {
      const intent = mapReply(state.awaiting, msg);
      if (intent.kind === 'fallback') {
        await send(deps, sessionId, msg, { type: 'text', text: intent.text });
        return; // stay on the same input
      }
      let message: ContinueMessage | undefined;
      if (intent.kind === 'file') {
        let url: string;
        try {
          url = await deps.client.uploadFile(state.sessionId, state.awaiting.blockId, {
            mime: intent.mime,
            filename: intent.filename,
            data: intent.data,
          });
        } catch (e) {
          deps.log('typebot upload failed', e);
          await send(deps, sessionId, msg, { type: 'text', text: 'Sorry, that upload failed — please try sending the file again.' });
          return; // state stays intact so the user can retry
        }
        // A `file input` block's answer IS the file: Typebot validates message.text as the URL and rejects an
        // empty text with attachedFileUrls. A text input with attachments enabled is the opposite — there the
        // answer is the typed text and the file rides along in attachedFileUrls.
        message = state.awaiting.kind === 'file'
          ? { type: 'text', text: url }
          : { type: 'text', text: '', attachedFileUrls: [url] };
      } else if (intent.kind === 'text') {
        message = intent.message;
      }
      // A 'skip' leaves `message` undefined, which is how Typebot skips an optional file step.
      try {
        resp = await deps.client.continueChat(state.sessionId, message);
      } catch (e) {
        if (e instanceof TypebotHttpError && (e.status === 400 || e.status === 404)) {
          await deps.store.clear(key); // expired session → restart from the top
          resp = await deps.client.startChat({ prefilledVariables: prefilled });
        } else {
          throw e;
        }
      }
    }

    // Persist BEFORE sending: startChat/continueChat already advanced the server irreversibly, so local
    // `awaiting` must track the server even if a WhatsApp send then fails — otherwise the next reply would be
    // mapped against a stale input.
    const sid = resp.sessionId ?? state?.sessionId;
    try {
      if (resp.input && sid) {
        await deps.store.set(key, { sessionId: sid, awaiting: resp.input, lastActivity: deps.now() });
      } else {
        await deps.store.clear(key); // flow ended
      }
    } catch (e) {
      // A rejected write (the host rejects every `set` once the plugin is at its storage quota) must not
      // swallow the bubbles below: the server has already advanced and they are the only thing the
      // contact can still be given. Losing the row costs them a restart on their next message; throwing
      // here costs them that restart AND this whole turn.
      deps.log('typebot session state write failed; delivering this turn anyway', e);
    }

    // Per-part isolation. State above already recorded that the prompt was delivered, so letting one
    // failed part abort the loop left the contact with a half-turn and no way to advance: the next thing
    // they typed was matched against an input whose prompt they never saw. A media part can also fail on
    // its own (unreachable mediaHost, host media path), and that must not silence the text that follows.
    for (const part of renderResponse(resp)) {
      try {
        await send(deps, sessionId, msg, part);
      } catch (err) {
        deps.log(`failed to deliver a ${part.type} part of this turn; continuing with the rest`, err);
      }
    }
  });
}

function contactVars(msg: IncomingMessage): Record<string, string> {
  // `senderPhone` is assigned by the host AFTER the message:received chain has run, and only for @lid
  // senders — so at hook time it is ALWAYS unset and {{waNumber}} reached every flow empty. Verified on a
  // live 0.12.1 host: the same flow rendered `num=[628999000]` when called directly and `num=[]` through
  // this plugin. Read it first anyway (harmless, and correct if the host ever moves the resolution), then
  // fall back to the JID's user part, which for a plain @c.us chat IS the number.
  // A group message is keyed by `author`; `from`/`chatId` there is the group, not a person.
  const jid = msg.author ?? msg.from;
  return {
    waNumber: msg.senderPhone ?? phoneFromJid(jid),
    waName: msg.contact?.pushName ?? msg.contact?.name ?? '',
    waChatId: msg.chatId,
  };
}


async function send(deps: TurnDeps, sessionId: string, msg: IncomingMessage, part: OutgoingPart): Promise<void> {
  const env: ConversationSendEnvelope = { sessionId, chatId: msg.chatId, ...part };
  // Quote the sender in groups to disambiguate — but only for text parts: OpenWA rejects replyTo on a media
  // envelope (the engine media path can't quote a message).
  if (msg.isGroup && part.type === 'text') env.replyTo = msg.id;
  await deps.conversations.send(env);
}
