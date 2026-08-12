import { randomBytes } from 'node:crypto';
import { buildMultipartBody } from './multipart.ts';

/**
 * A request URL with its query string dropped. These errors surface in `healthCheck`, which the
 * dashboard renders — and the contact-search URL carries the customer's phone number in `?q=`. The path
 * is all a diagnostic needs: it says which endpoint failed.
 */
function redactUrl(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : `${url.slice(0, q)}?…`;
}

export interface ChatwootConfig {
  baseUrl: string;
  apiToken: string;
  accountId: number;
  inboxId: number;
}

// Threading metadata for a relayed message. `sourceId` is the WhatsApp message id (so later replies can
// reference it); `inReplyToExternalId` is the quoted message's WA id when this message is a reply.
export interface MessagePostOptions {
  sourceId?: string;
  inReplyToExternalId?: string;
  // Chatwoot direction. Live inbound is always 'incoming'; history backfill posts business-side
  // (fromMe) messages as 'outgoing' so the reconstructed thread reads correctly. Default 'incoming'.
  messageType?: 'incoming' | 'outgoing';
}

// The slice of ctx.net.fetch this client needs (host-proxied, SSRF-guarded). Injectable for tests.
export type NetFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array },
) => Promise<{ ok: boolean; status: number; body: string }>;

// Chatwoot Application API client. Contacts are keyed on the WhatsApp JID (`identifier`), not phone, so
// matching is stable across WhatsApp's @lid migration; a 422 on create degrades to find-existing.
export class ChatwootClient {
  constructor(
    private readonly fetch: NetFetch,
    private readonly cfg: ChatwootConfig,
  ) {}

  private base(): string {
    return `${this.cfg.baseUrl.replace(/\/$/, '')}/api/v1/accounts/${this.cfg.accountId}`;
  }
  private headers(extra?: Record<string, string>): Record<string, string> {
    return { api_access_token: this.cfg.apiToken, ...extra };
  }
  private async json<T>(
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ status: number; data: T }> {
    const res = await this.fetch(url, { ...init, headers: this.headers({ 'Content-Type': 'application/json', ...init?.headers }) });
    if (!res.ok) {
      const e = new Error(`Chatwoot ${init?.method ?? 'GET'} ${redactUrl(url)} -> ${res.status}`) as Error & {
        status?: number;
      };
      e.status = res.status;
      throw e;
    }
    return { status: res.status, data: JSON.parse(res.body || '{}') as T };
  }

  async searchContact(identifier: string): Promise<{ id: number; sourceId?: string } | null> {
    const { data } = await this.json<{
      payload?: Array<{ id: number; identifier?: string; contact_inboxes?: Array<{ inbox?: { id?: number }; source_id?: string }> }>;
    }>(`${this.base()}/contacts/search?q=${encodeURIComponent(identifier)}`);
    const hit = (data.payload ?? []).find(c => c.identifier === identifier);
    if (!hit) return null;
    return { id: hit.id, sourceId: hit.contact_inboxes?.find(ci => ci.inbox?.id === this.cfg.inboxId)?.source_id };
  }

  async createContact(identifier: string, name: string, phone?: string): Promise<{ id: number; sourceId: string }> {
    try {
      const { data } = await this.json<{
        payload?: { contact?: { id: number; contact_inboxes?: Array<{ inbox?: { id?: number }; source_id?: string }> } };
      }>(`${this.base()}/contacts`, {
        method: 'POST',
        body: JSON.stringify({ inbox_id: this.cfg.inboxId, identifier, name, ...(phone ? { phone_number: phone } : {}) }),
      });
      const contact = data.payload?.contact;
      if (!contact) throw new Error('Chatwoot createContact: no contact in response');
      const src = contact.contact_inboxes?.find(ci => ci.inbox?.id === this.cfg.inboxId)?.source_id;
      return { id: contact.id, sourceId: src ?? (await this.ensureContactInbox(contact.id)) };
    } catch (err) {
      // 422 "already exists": Chatwoot enforces uniqueness on BOTH identifier and phone_number, account-wide.
      // Try the identifier first (the key this adapter owns), then the phone.
      if ((err as { status?: number }).status === 422) {
        const found = await this.searchContact(identifier);
        if (found) return { id: found.id, sourceId: found.sourceId ?? (await this.ensureContactInbox(found.id)) };
        // Identifier free, yet create still 422s: the phone belongs to a contact keyed under a DIFFERENT
        // identifier — created by hand, by another integration, or before this adapter took over the inbox.
        // Without this fallback the identifier search misses it on every delivery and each message from
        // the chat burns its whole retry budget into the dead-letter queue. Adopt that contact instead.
        const adopted = phone ? await this.adoptContactByPhone(phone, identifier) : null;
        if (adopted) return { id: adopted.id, sourceId: adopted.sourceId ?? (await this.ensureContactInbox(adopted.id)) };
      }
      throw err;
    }
  }

  // Find the contact that owns `phone` and re-key it to our JID `identifier`, so every future
  // searchContact() resolves it directly. The re-key is best-effort: if it fails (e.g. a conflicting
  // identifier elsewhere), the phone match alone still threads this message — next delivery just takes
  // this fallback again instead of dead-lettering.
  private async adoptContactByPhone(phone: string, identifier: string): Promise<{ id: number; sourceId?: string } | null> {
    const { data } = await this.json<{
      payload?: Array<{
        id: number;
        identifier?: string;
        phone_number?: string;
        contact_inboxes?: Array<{ inbox?: { id?: number }; source_id?: string }>;
      }>;
    }>(`${this.base()}/contacts/search?q=${encodeURIComponent(phone)}`);
    const hit = (data.payload ?? []).find(c => c.phone_number === phone);
    if (!hit) return null;
    // Only re-key a contact that isn't already keyed to a WhatsApp JID. A contact holding one — @lid vs
    // @c.us for the same person, say — was minted by this adapter, and overwriting it would flip the
    // contact between the two forms on every mapping-loss event. Adopting it is still correct.
    if (!/@(c\.us|lid|g\.us)$/.test(hit.identifier ?? '')) {
      try {
        await this.json(`${this.base()}/contacts/${hit.id}`, { method: 'PUT', body: JSON.stringify({ identifier }) });
      } catch {
        // Keep the match — adoption is an optimization, not a requirement for delivering this message.
      }
    }
    return { id: hit.id, sourceId: hit.contact_inboxes?.find(ci => ci.inbox?.id === this.cfg.inboxId)?.source_id };
  }

  async ensureContactInbox(contactId: number): Promise<string> {
    const { data } = await this.json<{ payload?: { source_id?: string }; source_id?: string }>(
      `${this.base()}/contacts/${contactId}/contact_inboxes`,
      { method: 'POST', body: JSON.stringify({ inbox_id: this.cfg.inboxId }) },
    );
    const src = data.source_id ?? data.payload?.source_id;
    if (!src) throw new Error('Chatwoot ensureContactInbox: no source_id');
    return src;
  }

  async updateContact(contactId: number, name: string): Promise<void> {
    await this.json(`${this.base()}/contacts/${contactId}`, { method: 'PUT', body: JSON.stringify({ name }) });
  }

  async findOpenConversation(contactId: number): Promise<number | null> {
    const { data } = await this.json<{ payload?: Array<{ id: number; inbox_id?: number; status?: string }> }>(
      `${this.base()}/contacts/${contactId}/conversations`,
    );
    const c = (data.payload ?? []).find(x => x.inbox_id === this.cfg.inboxId && (x.status === 'open' || x.status === 'pending'));
    return c ? c.id : null;
  }

  async createConversation(contactId: number, sourceId: string): Promise<number> {
    const { data } = await this.json<{ id: number }>(`${this.base()}/conversations`, {
      method: 'POST',
      body: JSON.stringify({ source_id: sourceId, inbox_id: this.cfg.inboxId, contact_id: contactId, status: 'open' }),
    });
    return data.id;
  }

  async postText(conversationId: number, content: string, opts: MessagePostOptions = {}): Promise<{ id: number }> {
    const payload: Record<string, unknown> = { content, message_type: opts.messageType ?? 'incoming', private: false };
    if (opts.sourceId) payload.source_id = opts.sourceId;
    if (opts.inReplyToExternalId) payload.content_attributes = { in_reply_to_external_id: opts.inReplyToExternalId };
    const { data } = await this.json<{ id: number }>(`${this.base()}/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return data;
  }

  async postMedia(
    conversationId: number,
    content: string,
    file: { filename: string; contentType: string; data: Uint8Array },
    opts: MessagePostOptions & { isVoiceMessage?: boolean } = {},
  ): Promise<{ id: number }> {
    // Random, not derived: the media bytes are attacker-controlled, and a boundary they can predict is a
    // boundary they can embed to forge extra parts. Matches typebot-connector's producer.
    const boundary = `----cw${randomBytes(16).toString('hex')}`;
    const fields = [
      { name: 'content', value: content },
      { name: 'message_type', value: opts.messageType ?? 'incoming' },
    ];
    // Rails parses bracket notation into nested params; source_id + in_reply_to_external_id give Chatwoot
    // the threading it uses for the native WhatsApp integration, is_voice_message renders a voice bubble.
    if (opts.sourceId) fields.push({ name: 'source_id', value: opts.sourceId });
    if (opts.inReplyToExternalId)
      fields.push({ name: 'content_attributes[in_reply_to_external_id]', value: opts.inReplyToExternalId });
    if (opts.isVoiceMessage) fields.push({ name: 'is_voice_message', value: 'true' });
    const body = buildMultipartBody(
      boundary,
      fields,
      [{ name: 'attachments[]', filename: file.filename, contentType: file.contentType, data: file.data }],
    );
    const res = await this.fetch(`${this.base()}/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': `multipart/form-data; boundary=${boundary}` }),
      body,
    });
    if (!res.ok) {
      // Mirror json(): attach err.status so the caller (inbound/sent recovery) can branch on the HTTP
      // code (the 404 mapping-rebuild path needs this — the bare Error below would otherwise be invisible
      // to the `err.status === 404` check and a media 404 would dead-letter instead of recover).
      const e = new Error(`Chatwoot postMedia -> ${res.status}`) as Error & { status?: number };
      e.status = res.status;
      throw e;
    }
    return JSON.parse(res.body || '{}') as { id: number };
  }

  async toggleStatusOpen(conversationId: number): Promise<void> {
    await this.json(`${this.base()}/conversations/${conversationId}/toggle_status`, {
      method: 'POST',
      body: JSON.stringify({ status: 'open' }),
    });
  }
}
