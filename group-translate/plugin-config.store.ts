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
    return `group:${sessionId}:${chatId}`;
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
