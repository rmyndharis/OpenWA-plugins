import { randomBytes } from 'node:crypto';
import type { IncomingMessage, PluginContext, WebhookRequest } from '../types/openwa';
import { RocketClient } from './client.ts';
import { digest, stateKey, type Config } from './config.ts';
import { parseAgentEvent } from './protocol.ts';
import { KeyedAsyncLock } from './chat-lock.ts';

export const MAX_CHATS = 500;
export const MAX_PENDING = 100;
export const MAX_SEEN = 500;
export const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 10_000;
interface ChatLink {
  chatId: string;
  token: string;
  roomId?: string;
}
interface Pending {
  id: string;
  chatId: string;
  text: string;
  name: string;
  attempts: number;
  nextAt: number;
  roomId?: string;
}
interface State {
  version: 1;
  links: ChatLink[];
  pending: Pending[];
  dead: Pending[];
  inboundSeen: string[];
  outboundSeen: string[];
}

export class Bridge {
  private readonly lock = new KeyedAsyncLock();
  private readonly key: string;
  private readonly client: RocketClient;
  private pumping = false;
  constructor(
    private readonly ctx: PluginContext,
    private readonly config: Config,
    private readonly assertCurrent: () => void,
    private readonly now: () => number = Date.now,
  ) {
    this.key = stateKey(config);
    this.client = new RocketClient((url, init) => {
      this.assertCurrent();
      return ctx.net.fetch(url, init);
    }, config);
  }

  private async read(): Promise<State> {
    const stored = await this.ctx.storage.get<State>(this.key);
    if (!stored) return { version: 1, links: [], pending: [], dead: [], inboundSeen: [], outboundSeen: [] };
    if (
      stored.version !== 1 ||
      ![stored.links, stored.pending, stored.dead, stored.inboundSeen, stored.outboundSeen].every(Array.isArray)
    ) {
      throw new Error('Unsupported Rocket.Chat state; refusing to reset stored mappings');
    }
    return stored;
  }
  private async write(state: State): Promise<void> {
    this.assertCurrent();
    await this.ctx.storage.set(this.key, state);
  }

  async enqueue(message: IncomingMessage): Promise<void> {
    await this.lock.run('state', async () => {
      this.assertCurrent();
      const state = await this.read();
      if (
        state.inboundSeen.includes(JSON.stringify([message.chatId, message.id])) ||
        [...state.pending, ...state.dead].some((p) => p.id === message.id && p.chatId === message.chatId)
      )
        return;
      if (state.pending.length + state.dead.length >= MAX_PENDING)
        throw new Error('Rocket.Chat retry queue is full; inbound message was not queued');
      let link = state.links.find((link) => link.chatId === message.chatId);
      if (!link) {
        if (state.links.length >= MAX_CHATS) throw new Error('Rocket.Chat chat mapping limit reached');
        link = { chatId: message.chatId, token: randomBytes(32).toString('hex') };
        state.links.push(link);
      }
      state.pending.push({
        id: message.id,
        chatId: message.chatId,
        text: message.body,
        name: String(message.contact?.pushName || message.contact?.name || 'WhatsApp visitor').slice(0, 100),
        attempts: 0,
        nextAt: 0,
      });
      // Persist visitor credentials and pending work BEFORE any request to Rocket.Chat.
      await this.write(state);
    });
  }

  /** At most one message per tick, keeping the critical section and retry pressure bounded. */
  async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      await this.lock.run('state', async () => {
        this.assertCurrent();
        const state = await this.read();
        const pending = state.pending[0];
        if (!pending || pending.nextAt > this.now()) return;
        const link = state.links.find((link) => link.chatId === pending.chatId);
        if (!link) throw new Error('Rocket.Chat pending message has no visitor mapping');
        const externalId = `owa${digest(JSON.stringify([this.key, pending.chatId, pending.id])).slice(0, 24)}`;
        try {
          // A retry after a timeout must inspect the SAME room and message id before attempting a new
          // room. Otherwise a closed room could turn an ambiguous prior success into a duplicate.
          if (pending.roomId && (await this.client.contains(link.token, pending.roomId, externalId))) {
            const completed = structuredClone(state);
            this.complete(completed, pending);
            await this.write(completed);
            return;
          }
          await this.client.visitor(link.token, pending.name);
          const roomId = pending.roomId ?? (await this.client.room(link.token));
          pending.roomId = roomId;
          link.roomId = roomId;
          await this.write(state);
          await this.client.message(link.token, roomId, externalId, pending.text);
          const completed = structuredClone(state);
          this.complete(completed, pending);
          await this.write(completed);
        } catch {
          // Keep the body and visitor token out of logs. Retain exhausted work for operator inspection.
          pending.attempts++;
          pending.nextAt = this.now() + RETRY_DELAY_MS * pending.attempts;
          if (pending.attempts >= MAX_ATTEMPTS) {
            state.pending = state.pending.filter((item) => item.id !== pending.id || item.chatId !== pending.chatId);
            state.dead.push(pending);
          }
          await this.write(state);
          throw new Error('Rocket.Chat relay failed; message retained in pending/dead-letter storage');
        }
      });
    } finally {
      this.pumping = false;
    }
  }

  private complete(state: State, pending: Pending): void {
    state.pending = state.pending.filter((item) => item.id !== pending.id || item.chatId !== pending.chatId);
    const id = JSON.stringify([pending.chatId, pending.id]);
    state.inboundSeen = [...state.inboundSeen.filter((item) => item !== id), id].slice(-MAX_SEEN);
  }

  async webhook(req: WebhookRequest): Promise<void> {
    if (!req.verified || req.sessionId !== this.config.sessionId)
      throw new Error('Webhook must be verified and bound to the configured session');
    const event = parseAgentEvent(req.body);
    if (!event || !event.messages.length) return;
    await this.lock.run('state', async () => {
      this.assertCurrent();
      const state = await this.read();
      // Never choose a WhatsApp recipient from a provider payload. Resolve only persisted mappings,
      // matching BOTH room and visitor credential for this destination/session namespace.
      const link = state.links.find((link) => link.roomId === event.roomId && link.token === event.visitorToken);
      if (!link) throw new Error('No matching WhatsApp mapping for Rocket.Chat room and visitor');
      for (const message of event.messages) {
        const id = JSON.stringify([event.roomId, message.id]);
        if (state.outboundSeen.includes(id)) continue;
        this.assertCurrent();
        await this.ctx.conversations.send({
          sessionId: this.config.sessionId,
          chatId: link.chatId,
          type: 'text',
          text: message.text,
          source: { provider: 'rocketchat-adapter', externalConversationId: event.roomId },
        });
        state.outboundSeen = [...state.outboundSeen, id].slice(-MAX_SEEN);
        await this.write(state);
      }
    });
  }

  async status(): Promise<{ pending: number; dead: number }> {
    return this.lock.run('state', async () => {
      const state = await this.read();
      return { pending: state.pending.length, dead: state.dead.length };
    });
  }
}
