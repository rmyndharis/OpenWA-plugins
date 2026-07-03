import type { PluginStorage } from '../types/openwa';
import type { SessionState } from './typebot-types.ts';

// Thin per-key wrapper over ctx.storage. One document per session key; the idle-timeout and start-vs-continue
// decisions live in turn.ts (they need the config clock).
export class SessionStore {
  constructor(private readonly storage: PluginStorage) {}
  private k(key: string): string {
    return `sess:${key}`;
  }
  get(key: string): Promise<SessionState | null> {
    return this.storage.get<SessionState>(this.k(key));
  }
  set(key: string, state: SessionState): Promise<void> {
    return this.storage.set(this.k(key), state);
  }
  clear(key: string): Promise<void> {
    return this.storage.delete(this.k(key));
  }
}
