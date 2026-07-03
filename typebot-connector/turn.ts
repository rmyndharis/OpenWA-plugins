import type { IncomingMessage, PluginConversationsCapability, ConversationSendEnvelope } from '../types/openwa';
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

// One WhatsApp message → one Typebot turn. Runs under the per-key lock so concurrent messages from the same
// chat serialize (a concurrent continueChat would race the same server session row).
export async function handleTurn(deps: TurnDeps, sessionId: string, source: string, msg: IncomingMessage): Promise<void> {
  if (!inScope(msg, source, deps.cfg.respondInGroups)) return;
  const key = sessionKey(sessionId, msg);

  await deps.lock.run(key, async () => {
    let state = await deps.store.get(key);
    if (state && deps.now() - state.lastActivity > deps.cfg.sessionTimeoutMinutes * 60_000) state = null; // idle reset

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
      let message: ContinueMessage;
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
        message = { type: 'text', text: '', attachedFileUrls: [url] };
      } else {
        message = intent.message;
      }
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

    for (const part of renderResponse(resp)) await send(deps, sessionId, msg, part);

    const sid = resp.sessionId ?? state?.sessionId;
    if (resp.input && sid) {
      await deps.store.set(key, { sessionId: sid, awaiting: resp.input, lastActivity: deps.now() });
    } else {
      await deps.store.clear(key); // flow ended
    }
  });
}

function contactVars(msg: IncomingMessage): Record<string, string> {
  return {
    waNumber: msg.senderPhone ?? '',
    waName: msg.contact?.pushName ?? msg.contact?.name ?? '',
    waChatId: msg.chatId,
  };
}

async function send(deps: TurnDeps, sessionId: string, msg: IncomingMessage, part: OutgoingPart): Promise<void> {
  const env: ConversationSendEnvelope = { sessionId, chatId: msg.chatId, ...part };
  if (msg.isGroup) env.replyTo = msg.id;
  await deps.conversations.send(env);
}
