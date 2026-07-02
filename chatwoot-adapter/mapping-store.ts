import type { PluginStorage, PluginMappingsCapability } from '../types/openwa';

export interface ChatLink {
  conversationId: number;
  contactId: number;
  sourceId: string;
  handoverState?: 'bot' | 'human' | 'closed';
}

// Single-document-per-chat mapping over ctx.storage, mirrored into the core ctx.mappings row so the
// session+chat handover gate and handover.set can resolve this chat. Forward `conv:{sessionId}:{chatId}`
// holds the full ChatLink; reverse `wa:{conversationId}` holds {sessionId, chatId}; both are written
// together in link() (called inside the per-chat lock, so the pair never diverges). `seen` is an
// idempotency check-and-set over `seen:{kind}:{id}` (mark-before-act; also inside the lock).
export class MappingStore {
  constructor(
    private readonly storage: PluginStorage,
    private readonly mappings: PluginMappingsCapability,
  ) {}

  private fwdKey(sessionId: string, chatId: string): string {
    return `conv:${sessionId}:${chatId}`;
  }
  private revKey(conversationId: number): string {
    return `wa:${conversationId}`;
  }

  getByChat(sessionId: string, chatId: string): Promise<ChatLink | null> {
    return this.storage.get<ChatLink>(this.fwdKey(sessionId, chatId));
  }

  getByConversation(conversationId: number): Promise<{ sessionId: string; chatId: string } | null> {
    return this.storage.get<{ sessionId: string; chatId: string }>(this.revKey(conversationId));
  }

  async link(sessionId: string, chatId: string, instanceId: string, link: ChatLink): Promise<void> {
    await this.storage.set(this.fwdKey(sessionId, chatId), link);
    await this.storage.set(this.revKey(link.conversationId), { sessionId, chatId });
    await this.mappings.upsert({ sessionId, chatId, instanceId }, String(link.conversationId));
  }

  async patch(sessionId: string, chatId: string, patch: Partial<ChatLink>): Promise<void> {
    const existing = await this.getByChat(sessionId, chatId);
    if (!existing) return;
    await this.storage.set(this.fwdKey(sessionId, chatId), { ...existing, ...patch });
  }

  // Returns true if (kind,id) was already seen; otherwise marks it and returns false.
  async seen(kind: 'wa' | 'cw', id: string): Promise<boolean> {
    const key = `seen:${kind}:${id}`;
    if (await this.storage.get(key)) return true;
    await this.storage.set(key, 1);
    return false;
  }
}
