import { ConfigStore, GroupState } from './core/ports';
import type { PluginStorage } from '../types/openwa';

/**
 * ConfigStore backed by the plugin's KV storage (`ctx.storage`). Persists one GroupState
 * JSON document per (sessionId, chatId) and returns a default inactive state for groups the
 * bot hasn't met yet. Replaces the TypeORM entity/migration the core-module version used —
 * a plugin owns its own state via the capability surface.
 */
export class PluginConfigStore implements ConfigStore {
  constructor(private readonly storage: PluginStorage) {}

  private key(sessionId: string, chatId: string): string {
    const raw = `group:${sessionId}:${chatId}`;
    if (Buffer.byteLength(raw, 'utf8') <= 184) return raw;
    let h1 = 0x811c9dc5, h2 = 0xdeadbeef;
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193);
      h2 = Math.imul(h2 ^ c, 0x85ebca6b);
    }
    const suffix = `:${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
    let prefix = raw.slice(0, 184 - suffix.length).replace(/[\ud800-\udbff]$/, '');
    while (Buffer.byteLength(prefix, 'utf8') > 184 - suffix.length) prefix = prefix.slice(0, -1).replace(/[\ud800-\udbff]$/, '');
    return `${prefix}${suffix}`;
  }

  async load(sessionId: string, chatId: string): Promise<GroupState> {
    const stored = await this.storage.get<GroupState>(this.key(sessionId, chatId));
    return (
      stored ?? {
        sessionId,
        chatId,
        active: false,
        participants: {},
        delegatedControllers: [],
        announced: false,
      }
    );
  }

  async save(state: GroupState): Promise<void> {
    await this.storage.set(this.key(state.sessionId, state.chatId), state);
  }
}
