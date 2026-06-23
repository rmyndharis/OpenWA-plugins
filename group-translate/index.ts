/**
 * Group auto-translation extension plugin.
 *
 * Ports the former core `translation` module onto the Tier-2 capability layer (#294): the
 * framework-agnostic `core/` (coordinator, parser, formatter, ports) is reused unchanged, with
 * `ChatGateway`/`ConfigStore` implemented over `ctx.messages`/`ctx.engine`/`ctx.storage`.
 * Registered DISABLED by default — enable via `POST /plugins/translation/enable`.
 */
import type { PluginContext, IPlugin, HookContext, HookResult, IncomingMessage } from '../types/openwa';
import { TranslationCoordinator, CoordinatorOptions } from './core/translation.coordinator';
import { InboundMessage, TranslationLogger } from './core/ports';
import { LibreTranslateClient } from './libretranslate.client';
import { PluginChatGateway } from './plugin-chat.gateway';
import { PluginConfigStore } from './plugin-config.store';

function readString(cfg: Record<string, unknown>, key: string, fallback: string): string {
  const v = cfg[key];
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}
function readOptionalString(cfg: Record<string, unknown>, key: string): string | undefined {
  const v = cfg[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function readNumber(cfg: Record<string, unknown>, key: string, fallback: number): number {
  const v = cfg[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function readBool(cfg: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = cfg[key];
  return typeof v === 'boolean' ? v : fallback;
}

export class TranslationPlugin implements IPlugin {
  private coordinator: TranslationCoordinator | null = null;

  onEnable(context: PluginContext): Promise<void> {
    this.coordinator = this.buildCoordinator(context);
    context.registerHook('message:received', ctx => this.onMessage(context, ctx as HookContext<IncomingMessage>));
    context.logger.log('Translation plugin enabled', { action: 'translation_enabled' });
    return Promise.resolve();
  }

  onConfigChange(context: PluginContext): Promise<void> {
    // Rebuild the coordinator so a config edit (e.g. a new LibreTranslate URL/key saved from the
    // dashboard) takes effect immediately, without a disable/enable cycle.
    this.coordinator = this.buildCoordinator(context);
    context.logger.log('Translation plugin config updated', { action: 'translation_config_changed' });
    return Promise.resolve();
  }

  private buildCoordinator(context: PluginContext): TranslationCoordinator {
    const cfg = context.config;
    const logger: TranslationLogger = {
      debug: (m, meta) => context.logger.debug(m, meta),
      info: (m, meta) => context.logger.log(m, meta),
      warn: (m, meta) => context.logger.warn(m, meta),
    };
    const translator = new LibreTranslateClient({
      url: readString(cfg, 'libretranslateUrl', 'http://localhost:7001'),
      apiKey: readOptionalString(cfg, 'libretranslateApiKey'),
      timeoutMs: readNumber(cfg, 'timeoutMs', 4000),
      net: context.net,
      logger,
    });
    const store = new PluginConfigStore(context.storage);
    const gateway = new PluginChatGateway(context.messages, context.engine);
    const opts: CoordinatorOptions = {
      prefix: readString(cfg, 'commandPrefix', '/tr'),
      minLength: readNumber(cfg, 'minLength', 2),
      maxLength: readNumber(cfg, 'maxLength', 2000),
      denyReply: readBool(cfg, 'denyReply', false),
    };
    return new TranslationCoordinator(translator, store, gateway, opts, logger);
  }

  onDisable(context: PluginContext): Promise<void> {
    // The loader unregisters this plugin's hooks on disable; drop the coordinator too.
    this.coordinator = null;
    context.logger.log('Translation plugin disabled', { action: 'translation_disabled' });
    return Promise.resolve();
  }

  private async onMessage(context: PluginContext, ctx: HookContext<IncomingMessage>): Promise<HookResult> {
    const msg = ctx.data;
    // Only act on engine-originated inbound messages for a known session. The bot's own sends are
    // `fromMe` and route through `message:sent`, so they never reach here (no translation loop).
    if (!this.coordinator || ctx.source !== 'Engine' || !ctx.sessionId) {
      return { continue: true };
    }
    try {
      const inbound: InboundMessage = {
        id: msg.id,
        chatId: msg.chatId,
        body: msg.body,
        author: msg.author ?? '',
        isGroup: msg.isGroup,
        fromMe: msg.fromMe,
        mentionedIds: msg.mentionedIds ?? [],
        pushName: msg.contact?.pushName,
      };
      const { swallow } = await this.coordinator.handleMessage(ctx.sessionId, inbound);
      return { continue: !swallow };
    } catch (error) {
      context.logger.error('Translation hook failed', error, {
        sessionId: ctx.sessionId,
        action: 'translation_hook_error',
      });
      return { continue: true };
    }
  }
}

export default TranslationPlugin;
