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

  /**
   * Drop rows for conversations that were abandoned mid-flow. A completed flow clears its own row
   * (turn.ts), so only an abandoned one lingers — and it lingers forever, because nothing else ever
   * revisits that key. That matters beyond disk: the host re-measures its per-plugin storage quota on
   * EVERY write by stat-ing every key the plugin owns, so abandoned rows make each later turn slower,
   * permanently. Best-effort: a failure here must never affect a turn.
   */
  async pruneIdle(nowMs: number, idleMs: number): Promise<number> {
    let pruned = 0;
    // The host filters by prefix, but re-filter: a `list()` can also surface package-owned stems.
    const keys = (await this.storage.list('sess:')).filter(k => k.startsWith('sess:'));
    for (const key of keys) {
      const state = await this.storage.get<SessionState>(key);
      if (state && nowMs - state.lastActivity > idleMs) {
        await this.storage.delete(key);
        pruned++;
      }
    }
    return pruned;
  }
}
