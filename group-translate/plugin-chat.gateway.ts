import { ChatGateway } from './core/ports';
import type { PluginMessagingCapability, PluginEngineReadCapability } from '../types/openwa';

/**
 * ChatGateway backed by the Tier-2 plugin capability surface: writes go through
 * `ctx.messages` (routed via MessageService, so persistence is preserved), and group-admin
 * reads through `ctx.engine`. It implements the same port the translation core already
 * depends on, so the coordinator/parser/formatter are reused unchanged.
 */
export class PluginChatGateway implements ChatGateway {
  constructor(
    private readonly messages: PluginMessagingCapability,
    private readonly engine: PluginEngineReadCapability,
  ) {}

  // Whatever the translation backend returned is forwarded straight through, and an empty result is a
  // real possibility (a backend that answers 200 with a blank translation). The host now rejects an
  // empty positional argument outright — "argument 2 must be a non-empty string" — so an empty
  // translation stopped being a blank WhatsApp bubble and became a thrown capability error, swallowed by
  // the coordinator's catch. Dropping it here keeps the failure quiet either way, but says why.
  async sendText(sessionId: string, chatId: string, text: string): Promise<void> {
    if (!text.trim()) return;
    await this.messages.sendText(sessionId, chatId, text);
  }

  async sendCombinedReply(sessionId: string, chatId: string, quotedMessageId: string, text: string): Promise<void> {
    if (!text.trim()) return;
    await this.messages.reply(sessionId, chatId, quotedMessageId, text);
  }

  async getGroupAdmins(sessionId: string, chatId: string): Promise<string[]> {
    interface GroupInfoLike {
      participants?: Array<{ id?: string; isAdmin?: boolean; isSuperAdmin?: boolean }>;
      owner?: string;
    }
    const info = (await this.engine.getGroupInfo(sessionId, chatId)) as GroupInfoLike | null | undefined;
    if (!info || !Array.isArray(info.participants)) return [];
    const admins = info.participants
      .filter(p => p?.isAdmin || p?.isSuperAdmin)
      .map(p => p?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    // Participant ids can be @c.us while authors arrive @lid; the group `owner` is in the author's scheme,
    // so include it to recognize the creator across that split.
    if (typeof info.owner === 'string' && info.owner) admins.push(info.owner);
    return [...new Set(admins)];
  }

  /**
   * `getContactById` is the bridge across the @lid/@c.us split: handed a `@lid`, the engine looks the
   * contact up in its own store and returns the SAME contact keyed by its canonical `<phone>@c.us` id.
   * (Its `number` field is not that — for a lid contact it is the lid's user part, which is exactly the
   * value that cannot be compared with a participant list.) Read-only and permission-gated by
   * `engine:read`, which this plugin already declares for the admin lookup above.
   *
   * Best-effort by contract: an unknown contact, a slow engine or a torn-down session all resolve to
   * null, and the caller falls back to the direct comparison rather than failing the command.
   */
  async resolveCanonicalWid(sessionId: string, wid: string): Promise<string | null> {
    try {
      const contact = (await this.engine.getContactById(sessionId, wid)) as { id?: unknown } | null | undefined;
      const id = contact?.id;
      return typeof id === 'string' && id.length > 0 ? id : null;
    } catch {
      return null;
    }
  }
}
