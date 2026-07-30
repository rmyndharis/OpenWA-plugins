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
  async pruneIdle(nowMs: number, idleMs: number, sessionId: string): Promise<number> {
    let pruned = 0;
    // Scoped to ONE WhatsApp session on purpose. `idleMs` comes from the config resolved for the session
    // whose message triggered the sweep, and `sessionTimeoutMinutes` is overridable per session — so an
    // unscoped sweep would apply one session's (possibly 5-minute) threshold to every other session's
    // rows and delete flows that are still live under their own, longer, timeout. A contact halfway
    // through a long form would silently restart at question one.
    const prefix = `${this.k('')}${sessionId}:`;
    const keys = (await this.storage.list(prefix)).filter(k => k.startsWith(prefix));
    for (const key of keys) {
      // Per-key isolation: one unreadable row must not abandon the rest of the sweep, because the
      // caller has already advanced its throttle and would not retry for another hour.
      try {
        const state = await this.storage.get<SessionState>(key);
        if (state && nowMs - state.lastActivity > idleMs) {
          await this.storage.delete(key);
          pruned++;
        }
      } catch {
        /* skip this row; the next sweep tries again */
      }
    }
    return pruned;
  }
}
