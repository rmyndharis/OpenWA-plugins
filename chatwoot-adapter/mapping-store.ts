import type { PluginStorage, PluginMappingsCapability } from '../types/openwa';

export interface ChatLink {
  conversationId: number;
  contactId: number;
  sourceId: string;
  handoverState?: 'bot' | 'human' | 'closed';
  // Last name synced to the Chatwoot contact. Lets inbound skip a redundant rename and detect when a real
  // pushName has arrived for a contact first seeded with a bare JID. Absent on pre-0.2.0 rows.
  name?: string;
}

// Single-document-per-chat mapping over ctx.storage, mirrored into the core ctx.mappings row so the
// session+chat handover gate and handover.set can resolve this chat. `ctx.storage` is plugin-GLOBAL
// (shared across every session/instance), and Chatwoot conversation + message ids are per-account
// autoincrement, so anything keyed by id alone collides across tenants. The reverse map and dedup markers
// are therefore scoped by the WA sessionId (the one identity both the inbound hook and the outbound
// ingress delivery share). A session-scoped legacy reverse key is ALSO written so a delivery that arrives
// without a session scope (or a pre-scope row) still resolves — unscoped, so single-tenant is unaffected.
export class MappingStore {
  constructor(
    private readonly storage: PluginStorage,
    private readonly mappings: PluginMappingsCapability,
  ) {}

  private fwdKey(sessionId: string, chatId: string): string {
    return `conv:${sessionId}:${chatId}`;
  }
  private revKey(sessionId: string, conversationId: number): string {
    return `wa:${sessionId}:${conversationId}`;
  }
  private legacyRevKey(conversationId: number): string {
    return `wa:${conversationId}`;
  }
  private seenKey(kind: 'wa' | 'cw', id: string, scope?: string): string {
    return scope ? `seen:${scope}:${kind}:${id}` : `seen:${kind}:${id}`;
  }

  getByChat(sessionId: string, chatId: string): Promise<ChatLink | null> {
    return this.storage.get<ChatLink>(this.fwdKey(sessionId, chatId));
  }

  // Resolve the WA chat for a Chatwoot conversation. With a `sessionId` (a delivery that carries its
  // session scope), the tenant-scoped key wins — isolating two accounts that share a conversation id.
  // Without one, fall back to the unscoped key (single-tenant / pre-scope data), same as before.
  async getByConversation(
    conversationId: number,
    sessionId?: string,
  ): Promise<{ sessionId: string; chatId: string } | null> {
    if (sessionId) {
      const scoped = await this.storage.get<{ sessionId: string; chatId: string }>(this.revKey(sessionId, conversationId));
      if (scoped) return scoped;
    }
    return this.storage.get<{ sessionId: string; chatId: string }>(this.legacyRevKey(conversationId));
  }

  async link(sessionId: string, chatId: string, instanceId: string, link: ChatLink): Promise<void> {
    await this.storage.set(this.fwdKey(sessionId, chatId), link);
    const rev = { sessionId, chatId };
    await this.storage.set(this.revKey(sessionId, link.conversationId), rev); // tenant-scoped lookup
    await this.storage.set(this.legacyRevKey(link.conversationId), rev); // back-compat for scope-less deliveries
    await this.mappings.upsert({ sessionId, chatId, instanceId }, String(link.conversationId));
  }

  async patch(sessionId: string, chatId: string, patch: Partial<ChatLink>): Promise<void> {
    const existing = await this.getByChat(sessionId, chatId);
    if (!existing) return;
    await this.storage.set(this.fwdKey(sessionId, chatId), { ...existing, ...patch });
  }

  // Idempotency markers, split so the caller controls WHEN the mark lands (outbound marks only AFTER a
  // successful send, so a transient failure retries instead of silently dropping the reply). `scope`
  // isolates a tenant's markers; both sides of a given `kind` must pass the same scope.
  async hasSeen(kind: 'wa' | 'cw', id: string, scope?: string): Promise<boolean> {
    return Boolean(await this.storage.get(this.seenKey(kind, id, scope)));
  }
  async markSeen(kind: 'wa' | 'cw', id: string, scope?: string): Promise<void> {
    await this.storage.set(this.seenKey(kind, id, scope), 1);
  }
}
