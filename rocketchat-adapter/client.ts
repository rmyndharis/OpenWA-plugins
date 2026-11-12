import type { PluginContext } from '../types/openwa';
import type { Config } from './config.ts';

export type NetFetch = PluginContext['net']['fetch'];

export class RocketClient {
  constructor(
    private readonly fetch: NetFetch,
    private readonly config: Config,
  ) {}

  private async request(path: string, data?: unknown): Promise<Record<string, unknown>> {
    const response = await this.fetch(`${this.config.baseUrl}/api/v1/${path}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      timeoutMs: 3500,
    });
    // Never include response bodies or query strings in exceptions: they can contain visitor credentials.
    if (!response.ok) throw new Error(`Rocket.Chat request failed (HTTP ${response.status})`);
    let result: Record<string, unknown>;
    try {
      result = JSON.parse(response.body);
    } catch {
      throw new Error('Rocket.Chat returned invalid JSON');
    }
    if (!result || typeof result !== 'object' || Array.isArray(result) || result.success !== true) {
      throw new Error('Rocket.Chat rejected the request');
    }
    return result;
  }

  async visitor(token: string, name: string, phone?: string): Promise<void> {
    await this.request('livechat/visitor', {
      visitor: {
        token,
        name,
        ...(phone ? { phone } : {}),
        ...(this.config.department ? { department: this.config.department } : {}),
      },
    });
  }

  async room(token: string): Promise<string> {
    const result = await this.request(`livechat/room?${new URLSearchParams({ token })}`);
    const room = result.room as { _id?: unknown } | undefined;
    if (!room || typeof room._id !== 'string' || !room._id) throw new Error('Rocket.Chat returned no room');
    return room._id;
  }

  async message(token: string, rid: string, id: string, text: string): Promise<void> {
    await this.request('livechat/message', { token, rid, _id: id, msg: text });
  }

  async contains(token: string, rid: string, id: string): Promise<boolean> {
    const result = await this.request(
      `livechat/messages.history/${encodeURIComponent(rid)}?${new URLSearchParams({ token, limit: '100' })}`,
    );
    if (!Array.isArray(result.messages)) throw new Error('Rocket.Chat returned no message history');
    return result.messages.some((message: unknown) =>
      Boolean(message && typeof message === 'object' && '_id' in message && message._id === id),
    );
  }
}
