import type { IPlugin, PluginContext, HookContext, HookResult, IncomingMessage } from '../types/openwa';
import { FlowEngine, FlowNode, SessionFlow } from './flow-engine.ts';

export interface MenuNode {
  key: string;
  text: string;
  options?: MenuNode[];
}

export interface ChatFlowConfig {
  flow: SessionFlow;
  respondInGroups: boolean;
}

/** Convert the config's array-of-nodes (editor-friendly) into the engine's keyed FlowNode map. */
export function toFlowNodes(nodes: unknown): Record<string, FlowNode> | undefined {
  if (!Array.isArray(nodes) || nodes.length === 0) return undefined;
  const out: Record<string, FlowNode> = {};
  for (const raw of nodes) {
    if (!raw || typeof raw !== 'object') throw new Error('chat-flow: each option must be an object');
    const n = raw as Record<string, unknown>;
    const key = String(n.key ?? '').trim();
    const text = String(n.text ?? '');
    if (!key) throw new Error('chat-flow: each option needs a non-empty "key"');
    if (!text) throw new Error(`chat-flow: option "${key}" needs "text"`);
    if (out[key]) throw new Error(`chat-flow: duplicate option key "${key}"`);
    out[key] = { text, options: toFlowNodes(n.options) };
  }
  return out;
}

export function parseConfig(raw: Record<string, unknown>): ChatFlowConfig {
  const greeting = String(raw.greeting ?? '');
  if (!greeting) throw new Error('chat-flow: greeting is required');
  const options = toFlowNodes(raw.options);
  if (!options) throw new Error('chat-flow: at least one menu option is required');
  const trigger = String(raw.trigger ?? '').trim();
  return { flow: { trigger, greeting, options }, respondInGroups: raw.respondInGroups === true };
}

export default class ChatFlow implements IPlugin {
  private config: ChatFlowConfig | null = null;

  async onEnable(ctx: PluginContext): Promise<void> {
    this.config = parseConfig(ctx.config);
    ctx.registerHook('message:received', hook =>
      this.onMessage(ctx, hook as HookContext<IncomingMessage>),
    );
  }

  // The platform passes the new config as the 2nd arg, but for a sessionScoped plugin ctx.config is already
  // the resolved per-session slice — read that (re-parsing _newConfig would lose the per-session merge).
  async onConfigChange(ctx: PluginContext, _newConfig: Record<string, unknown>): Promise<void> {
    this.config = parseConfig(ctx.config);
  }

  private async onMessage(ctx: PluginContext, hook: HookContext<IncomingMessage>): Promise<HookResult> {
    const cfg = this.config;
    if (!cfg || hook.source !== 'Engine' || !hook.sessionId) return { continue: true };
    const m = hook.data;
    if (m.fromMe || typeof m.body !== 'string' || !m.chatId || !m.id) return { continue: true };
    if (m.isGroup && !cfg.respondInGroups) return { continue: true };
    try {
      const handled = await FlowEngine.processMessage(ctx, cfg.flow, hook.sessionId, m.chatId, m.body, m.id);
      return { continue: !handled };
    } catch (err) {
      ctx.logger.error('chat-flow: flow processing failed', err);
      return { continue: true };
    }
  }
}
