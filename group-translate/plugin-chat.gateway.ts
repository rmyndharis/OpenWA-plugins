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

  async sendText(sessionId: string, chatId: string, text: string): Promise<void> {
    await this.messages.sendText(sessionId, chatId, text);
  }

  async sendCombinedReply(sessionId: string, chatId: string, quotedMessageId: string, text: string): Promise<void> {
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
}
