import { randomBytes } from 'node:crypto';
import type { PluginNetRequestInit, PluginNetResponse } from '../types/openwa';
import type { TypebotConfig, NormalizedResponse, Bubble, InputSpec, ChoiceItem } from './typebot-types.ts';
import { buildMultipartBody } from './multipart.ts';

export type ContinueMessage = string | { type: 'text'; text: string; attachedFileUrls?: string[] };
type FetchFn = (url: string, init?: PluginNetRequestInit) => Promise<PluginNetResponse>;

export class TypebotHttpError extends Error {
  constructor(public readonly status: number, public readonly bodyText: string) {
    super(`Typebot HTTP ${status}`);
    this.name = 'TypebotHttpError';
  }
}

export class TypebotClient {
  constructor(private readonly fetchFn: FetchFn, private readonly cfg: TypebotConfig) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.cfg.apiToken) h['Authorization'] = `Bearer ${this.cfg.apiToken}`;
    return h;
  }

  private async postJson(url: string, payload: unknown): Promise<NormalizedResponse> {
    const res = await this.fetchFn(url, { method: 'POST', headers: this.headers(), body: JSON.stringify(payload) });
    if (!res.ok) throw new TypebotHttpError(res.status, res.body);
    return normalize(JSON.parse(res.body));
  }

  startChat(opts: { prefilledVariables?: Record<string, string> }): Promise<NormalizedResponse> {
    const url = `${this.cfg.apiHost}/api/v1/typebots/${encodeURIComponent(this.cfg.publicId)}/startChat`;
    return this.postJson(url, { isStreamEnabled: false, textBubbleContentFormat: 'markdown', prefilledVariables: opts.prefilledVariables });
  }

  continueChat(sessionId: string, message: ContinueMessage): Promise<NormalizedResponse> {
    const url = `${this.cfg.apiHost}/api/v1/sessions/${encodeURIComponent(sessionId)}/continueChat`;
    return this.postJson(url, { message, textBubbleContentFormat: 'markdown' });
  }

  // Answer a file-input block: get an upload URL, PUT/POST the bytes, return the final fileUrl.
  async uploadFile(sessionId: string, blockId: string, file: { mime: string; filename: string; data: string }): Promise<string> {
    const bytes = Buffer.from(file.data, 'base64');
    const gu = await this.fetchFn(`${this.cfg.apiHost}/api/v3/generate-upload-url`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ sessionId, blockId, fileName: file.filename, fileType: file.mime, fileSize: bytes.length }),
    });
    if (!gu.ok) throw new TypebotHttpError(gu.status, gu.body);
    const { presignedUrl, formData, fileUrl } = JSON.parse(gu.body) as { presignedUrl: string; formData?: Record<string, string>; fileUrl: string };

    const entries = Object.entries(formData ?? {});
    if (entries.length === 0) {
      // Typebot `main` proxy mode: same-origin signed PUT of the raw bytes.
      const put = await this.fetchFn(presignedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.mime, 'Cache-Control': 'public, max-age=86400' },
        body: bytes,
      });
      if (!put.ok) throw new TypebotHttpError(put.status, put.body);
    } else {
      // Older S3 presigned-POST: multipart form with the policy fields, then `file` LAST.
      const boundary = `----typebot${randomBytes(16).toString('hex')}`;
      const body = buildMultipartBody(
        boundary,
        entries.map(([name, value]) => ({ name, value })),
        [{ name: 'file', filename: file.filename, contentType: file.mime, data: bytes }],
      );
      const post = await this.fetchFn(presignedUrl, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body,
      });
      if (!post.ok) throw new TypebotHttpError(post.status, post.body);
    }
    return fileUrl;
  }
}

// ── normalization ─────────────────────────────────────────────────────────────────────
function normalize(raw: any): NormalizedResponse {
  const bubbles = (raw?.messages ?? []).map(normalizeBubble).filter((b: Bubble | null): b is Bubble => b !== null);
  const input = raw?.input ? normalizeInput(raw.input) : undefined;
  const redirect = (raw?.clientSideActions ?? []).find((a: any) => a?.redirect)?.redirect;
  return { sessionId: raw?.sessionId, bubbles, input, redirectUrl: redirect?.url };
}

function normalizeBubble(m: any): Bubble | null {
  switch (m?.type) {
    case 'text':
      return { kind: 'text', markdown: typeof m.content?.markdown === 'string' ? m.content.markdown : richToText(m.content?.richText) };
    case 'image':
      return m.content?.url ? { kind: 'image', url: m.content.url } : null;
    case 'audio':
      return m.content?.url ? { kind: 'audio', url: m.content.url } : null;
    case 'video':
      if (!m.content?.url) return null;
      return !m.content.type || m.content.type === 'url' ? { kind: 'video', url: m.content.url } : { kind: 'link', url: m.content.url };
    case 'embed':
    case 'custom-embed':
      return m.content?.url ? { kind: 'link', url: m.content.url } : null;
    default:
      return null;
  }
}

function richToText(rich: any[]): string {
  return (rich ?? []).map(n => (n?.children ?? []).map((c: any) => c?.text ?? '').join('')).join('\n');
}

function normalizeInput(inp: any): InputSpec {
  const blockId = String(inp?.id ?? '');
  switch (inp?.type) {
    case 'choice input':
    case 'picture choice input': {
      const items: ChoiceItem[] = (inp.items ?? []).map((it: any) => ({
        id: String(it?.id ?? ''),
        content: String(it?.content ?? it?.title ?? it?.value ?? ''),
      }));
      return { kind: 'choice', blockId, items, multiple: !!inp.options?.isMultipleChoice };
    }
    case 'rating input':
      return { kind: 'rating', blockId, max: typeof inp.options?.length === 'number' ? inp.options.length : undefined };
    case 'file input':
      return { kind: 'file', blockId };
    case 'text input':
      return {
        kind: 'text',
        blockId,
        placeholder: inp.options?.labels?.placeholder,
        attachmentsEnabled: !!(inp.options?.attachments?.isEnabled || inp.options?.audioClip?.isEnabled),
      };
    case 'number input':
    case 'email input':
    case 'url input':
    case 'date input':
    case 'time input':
    case 'phone number input':
      return { kind: 'text', blockId, placeholder: inp.options?.labels?.placeholder, attachmentsEnabled: false };
    default:
      return { kind: 'unsupported', blockId, typeLabel: String(inp?.type ?? 'unknown') };
  }
}
