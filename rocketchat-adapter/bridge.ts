import { randomBytes } from 'node:crypto';
import type { IncomingMessage, PluginContext, WebhookRequest } from '../types/openwa';
import { RocketClient } from './client.ts';
import { digest, stateKey, type Config } from './config.ts';
import { parseAgentEvent } from './protocol.ts';
import { KeyedAsyncLock } from './chat-lock.ts';

export const MAX_CHATS = 500;
export const MAX_PENDING = 100;
export const MAX_DEAD = 100;
export const DEAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_SEEN = 500;
export const MAX_ATTEMPTS = 5;
export const RELAY_CONCURRENCY = 4;
const RETRY_DELAY_MS = 10_000;
interface ChatLink {
  chatId: string;
  token: string;
  roomId?: string;
  lastUsedAt?: number;
}
interface Pending {
  id: string;
  chatId: string;
  text: string;
  name: string;
  attempts: number;
  nextAt: number;
  roomId?: string;
  failedAt?: number;
  /** Retained with dead letters so LRU eviction does not discard the credential needed for replay. */
  visitorToken?: string;
}
interface State {
  version: 1;
  links: ChatLink[];
  pending: Pending[];
  dead: Pending[];
  inboundSeen: string[];
  outboundSeen: string[];
  maintenanceIds?: string[];
}
export interface MaintenanceResult {
  replayed: number;
  cleared: number;
  remaining: number;
}
const messageKey = (item: Pick<Pending, 'chatId' | 'id'>): string => JSON.stringify([item.chatId, item.id]);

/** A privacy id (@lid) is NOT a phone number. Only real phone JID domains may supply phone. */
export function phoneFromChat(chatId: string): string | undefined {
  const match = /^(\d+)(?::\d+)?@(c\.us|s\.whatsapp\.net)$/.exec(chatId);
  return match ? `+${match[1]}` : undefined;
}

export class Bridge {
  // Only short storage reads/writes hold 'state'. Provider I/O never does.
  private readonly lock = new KeyedAsyncLock();
  private readonly key: string;
  private readonly client: RocketClient;
  private pumping: Promise<void> | undefined;
  private readonly busyChats = new Set<string>();
  private readonly pins = new Map<string, number>();
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
    const state = await this.ctx.storage.get<State>(this.key);
    if (!state) return { version: 1, links: [], pending: [], dead: [], inboundSeen: [], outboundSeen: [] };
    if (
      state.version !== 1 ||
      ![state.links, state.pending, state.dead, state.inboundSeen, state.outboundSeen].every(Array.isArray)
    ) {
      throw new Error('Unsupported Rocket.Chat state; refusing to reset stored mappings');
    }
    // Additive migration of preview state. Old dead letters get a full retention window on first write.
    for (const dead of state.dead) {
      dead.failedAt ??= this.now();
      dead.visitorToken ??= state.links.find((link) => link.chatId === dead.chatId)?.token;
    }
    return state;
  }

  private pruneDead(state: State): number {
    const before = state.dead.length;
    state.dead = state.dead
      .filter((item) => (item.failedAt ?? this.now()) >= this.now() - DEAD_RETENTION_MS)
      .slice(-MAX_DEAD);
    return before - state.dead.length;
  }

  private mutate<T>(change: (state: State) => T): Promise<T> {
    return this.lock.run('state', async () => {
      this.assertCurrent();
      const state = await this.read();
      let removed = this.pruneDead(state);
      const result = change(state);
      removed += this.pruneDead(state);
      this.assertCurrent();
      await this.ctx.storage.set(this.key, state);
      if (removed) this.ctx.logger.warn(`Rocket.Chat dead-letter retention removed ${removed} expired/oldest item(s)`);
      return result;
    });
  }

  private pin(chatId: string): void {
    this.pins.set(chatId, (this.pins.get(chatId) ?? 0) + 1);
  }
  private unpin(chatId: string): void {
    const count = (this.pins.get(chatId) ?? 1) - 1;
    if (count) this.pins.set(chatId, count);
    else this.pins.delete(chatId);
  }

  private ensureLink(state: State, chatId: string, token?: string): ChatLink {
    let link = state.links.find((item) => item.chatId === chatId);
    if (link) {
      if (token && token !== link.token)
        throw new Error('A newer visitor mapping exists; old dead letter cannot be replayed automatically');
    } else {
      if (state.links.length >= MAX_CHATS) {
        const candidate = state.links
          .filter(
            (item) => !this.pins.has(item.chatId) && !state.pending.some((pending) => pending.chatId === item.chatId),
          )
          .sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0))[0];
        if (!candidate)
          throw new Error('Rocket.Chat mappings are all pinned by pending/in-flight work; retry after work completes');
        state.links = state.links.filter((item) => item !== candidate);
      }
      link = { chatId, token: token ?? randomBytes(32).toString('hex') };
      state.links.push(link);
    }
    link.lastUsedAt = this.now();
    return link;
  }

  async enqueue(message: IncomingMessage): Promise<void> {
    await this.mutate((state) => {
      if (
        state.inboundSeen.includes(messageKey(message)) ||
        [...state.pending, ...state.dead].some((item) => messageKey(item) === messageKey(message))
      )
        return;
      // Dead letters have their own bounded retention and never consume live queue capacity.
      if (state.pending.length >= MAX_PENDING)
        throw new Error('Rocket.Chat pending queue is full; inbound message was not queued');
      this.ensureLink(state, message.chatId);
      state.pending.push({
        id: message.id,
        chatId: message.chatId,
        text: message.body,
        name: String(message.contact?.pushName || message.contact?.name || 'WhatsApp visitor').slice(0, 100),
        attempts: 0,
        nextAt: 0,
      });
    });
  }

  /** A config request id makes a repeated save/boot idempotent. No network calls in maintenance. */
  async maintenance(action: 'replay' | 'clear', requestId: string): Promise<MaintenanceResult> {
    return this.mutate((state) => {
      if ((state.maintenanceIds ?? []).includes(requestId))
        return { replayed: 0, cleared: 0, remaining: state.dead.length };
      let replayed = 0;
      let cleared = 0;
      if (action === 'clear') {
        cleared = state.dead.length;
        state.dead = [];
      } else {
        const remaining: Pending[] = [];
        for (const dead of state.dead) {
          if (state.inboundSeen.includes(messageKey(dead))) {
            cleared++;
            continue;
          }
          if (
            state.pending.length >= MAX_PENDING ||
            state.pending.some((item) => messageKey(item) === messageKey(dead))
          ) {
            remaining.push(dead);
            continue;
          }
          const current = state.links.find((link) => link.chatId === dead.chatId);
          // Do not silently repoint a pinned, ambiguous delivery at a new visitor/room.
          if (
            (dead.roomId && !dead.visitorToken) ||
            (current && dead.visitorToken && current.token !== dead.visitorToken) ||
            (current && dead.roomId && current.roomId && current.roomId !== dead.roomId)
          ) {
            remaining.push(dead);
            continue;
          }
          try {
            const link = this.ensureLink(state, dead.chatId, dead.visitorToken);
            if (!link.roomId && dead.roomId) link.roomId = dead.roomId;
          } catch {
            remaining.push(dead);
            continue;
          }
          state.pending.push({ ...dead, attempts: 0, nextAt: 0, failedAt: undefined });
          replayed++;
        }
        state.dead = remaining;
      }
      state.maintenanceIds = [...(state.maintenanceIds ?? []), requestId].slice(-100);
      return { replayed, cleared, remaining: state.dead.length };
    });
  }

  /** Drain due work with bounded concurrency; FIFO within each chat, never across unrelated chats. */
  pump(): Promise<void> {
    if (!this.pumping)
      this.pumping = this.drain().finally(() => {
        this.pumping = undefined;
      });
    return this.pumping;
  }

  private async drain(): Promise<void> {
    const attempted = new Set<string>();
    let failed = false;
    const next = () =>
      this.lock.run('state', async () => {
        this.assertCurrent();
        if (attempted.size >= MAX_PENDING) return undefined;
        const state = await this.read();
        const firstChats = new Set<string>();
        for (const item of state.pending) {
          if (firstChats.has(item.chatId)) continue;
          firstChats.add(item.chatId);
          if (this.busyChats.has(item.chatId) || attempted.has(messageKey(item)) || item.nextAt > this.now()) continue;
          attempted.add(messageKey(item));
          this.busyChats.add(item.chatId);
          this.pin(item.chatId);
          return item.chatId;
        }
        return undefined;
      });
    const worker = async () => {
      for (;;) {
        const chatId = await next();
        if (!chatId) return;
        try {
          await this.deliver(chatId);
        } catch {
          failed = true;
        } finally {
          this.busyChats.delete(chatId);
          this.unpin(chatId);
        }
      }
    };
    const results = await Promise.allSettled(Array.from({ length: RELAY_CONCURRENCY }, worker));
    if (failed || results.some((result) => result.status === 'rejected'))
      throw new Error('Rocket.Chat relay failed; message retained in pending/dead-letter storage');
  }

  private async deliver(chatId: string): Promise<void> {
    const snapshot = await this.mutate((state) => {
      const pending = state.pending.find((item) => item.chatId === chatId);
      const link = state.links.find((item) => item.chatId === chatId);
      if (!pending || !link) throw new Error('Rocket.Chat pending message has no visitor mapping');
      link.lastUsedAt = this.now();
      return { pending: structuredClone(pending), link: structuredClone(link) };
    });
    const { pending, link } = snapshot;
    const externalId = `owa${digest(JSON.stringify([this.key, pending.chatId, pending.id])).slice(0, 24)}`;
    try {
      if (pending.roomId && (await this.client.contains(link.token, pending.roomId, externalId))) {
        await this.complete(pending);
        return;
      }
      await this.client.visitor(link.token, pending.name, await this.visitorPhone(chatId));
      const roomId = pending.roomId ?? (await this.client.room(link.token));
      await this.mutate((state) => {
        const current = state.pending.find((item) => messageKey(item) === messageKey(pending));
        const mapping = state.links.find((item) => item.chatId === chatId);
        if (!current || !mapping || mapping.token !== link.token)
          throw new Error('Rocket.Chat mapping changed during relay');
        current.roomId = roomId;
        mapping.roomId = roomId;
        mapping.lastUsedAt = this.now();
      });
      await this.client.message(link.token, roomId, externalId, pending.text);
      await this.complete(pending);
    } catch {
      await this.mutate((state) => {
        const current = state.pending.find((item) => messageKey(item) === messageKey(pending));
        if (!current) return;
        current.attempts++;
        current.nextAt = this.now() + RETRY_DELAY_MS * current.attempts;
        if (current.attempts >= MAX_ATTEMPTS) {
          state.pending = state.pending.filter((item) => messageKey(item) !== messageKey(current));
          state.dead.push({ ...current, failedAt: this.now(), visitorToken: link.token });
        }
      });
      throw new Error('Rocket.Chat relay failed; message retained');
    }
  }

  private async visitorPhone(chatId: string): Promise<string | undefined> {
    const direct = phoneFromChat(chatId);
    if (direct || !chatId.endsWith('@lid')) return direct;
    // Only authoritative phone JIDs are accepted. Contact.number may contain the LID digits.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const canonical = await this.ctx.engine.canonicalChatId(this.config.sessionId, chatId);
          const cached = phoneFromChat(canonical);
          if (cached) return cached;
          const contact = await this.ctx.engine.getContactById(this.config.sessionId, chatId);
          if (!contact || typeof contact !== 'object' || !('id' in contact)) return undefined;
          return typeof contact.id === 'string' ? phoneFromChat(contact.id) : undefined;
        })(),
        new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 1500); }),
      ]);
    } catch {
      return undefined; // An unavailable phone lookup must not interrupt text delivery.
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async complete(pending: Pending): Promise<void> {
    await this.mutate((state) => {
      state.pending = state.pending.filter((item) => messageKey(item) !== messageKey(pending));
      const id = messageKey(pending);
      state.inboundSeen = [...state.inboundSeen.filter((item) => item !== id), id].slice(-MAX_SEEN);
    });
  }

  async webhook(req: WebhookRequest): Promise<void> {
    if (!req.verified || req.sessionId !== this.config.sessionId)
      throw new Error('Webhook must be verified and bound to the configured session');
    const event = parseAgentEvent(req.body);
    if (!event || !event.messages.length) return;
    await this.lock.run(`outbound:${event.roomId}`, async () => {
      let pinned: string | undefined;
      try {
        const link = await this.lock.run('state', async () => {
          this.assertCurrent();
          const state = await this.read();
          const match = state.links.find((item) => item.roomId === event.roomId && item.token === event.visitorToken);
          if (!match) return null; // Workspace-level webhooks also contain widget/other-session rooms.
          pinned = match.chatId;
          this.pin(match.chatId);
          match.lastUsedAt = this.now();
          this.assertCurrent();
          await this.ctx.storage.set(this.key, state);
          return structuredClone(match);
        });
        if (!link) return;
        for (const message of event.messages) {
          const id = JSON.stringify([event.roomId, message.id]);
          const send = await this.lock.run('state', async () => {
            this.assertCurrent();
            const state = await this.read();
            return (
              !state.outboundSeen.includes(id) &&
              state.links.some(
                (item) => item.chatId === link.chatId && item.roomId === event.roomId && item.token === link.token,
              )
            );
          });
          if (!send) continue;
          this.assertCurrent();
          await this.ctx.conversations.send({
            sessionId: this.config.sessionId,
            chatId: link.chatId,
            type: 'text',
            text: message.text,
            source: { provider: 'rocketchat-adapter', externalConversationId: event.roomId },
          });
          await this.mutate((state) => {
            state.outboundSeen = [...state.outboundSeen, id].slice(-MAX_SEEN);
          });
        }
      } finally {
        if (pinned) this.unpin(pinned);
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
