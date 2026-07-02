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
    if (key === '__proto__') throw new Error('chat-flow: option key "__proto__" is not allowed');
    if (!text) throw new Error(`chat-flow: option "${key}" needs "text"`);
    // Object.hasOwn (not a bare `out[key]`): an operator may name a key "toString"/"constructor"/etc.,
    // which would hit the inherited Object.prototype member and throw a spurious "duplicate".
    if (Object.hasOwn(out, key)) throw new Error(`chat-flow: duplicate option key "${key}"`);
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

/** How often to sweep abandoned flow states from storage (state TTL is 15 min). */
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

export default class ChatFlow implements IPlugin {
  private config: ChatFlowConfig | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  async onEnable(ctx: PluginContext): Promise<void> {
    this.config = parseConfig(ctx.config);
    ctx.registerHook('message:received', hook =>
      this.onMessage(ctx, hook as HookContext<IncomingMessage>),
    );
    // Reclaim states abandoned before this enable, then keep sweeping — lazy per-key expiry only fires
    // when a conversation messages again, so an abandoned flow would otherwise linger in storage forever.
    void FlowEngine.sweepExpired(ctx).catch(() => {});
    this.sweepTimer = setInterval(() => void FlowEngine.sweepExpired(ctx).catch(() => {}), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  // The platform passes the new config as the 2nd arg, but for a sessionScoped plugin ctx.config is already
  // the resolved per-session slice — read that (re-parsing _newConfig would lose the per-session merge).
  async onConfigChange(ctx: PluginContext, _newConfig: Record<string, unknown>): Promise<void> {
    this.config = parseConfig(ctx.config);
  }

  async onDisable(): Promise<void> {
    this.stopSweep();
  }

  async onUnload(): Promise<void> {
    this.stopSweep();
  }

  private stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private async onMessage(ctx: PluginContext, hook: HookContext<IncomingMessage>): Promise<HookResult> {
    const cfg = this.config;
    if (!cfg || hook.source !== 'Engine' || !hook.sessionId) return { continue: true };
    const m = hook.data;
    if (m.fromMe || typeof m.body !== 'string' || !m.chatId || !m.id) return { continue: true };
    if (m.isGroup && !cfg.respondInGroups) return { continue: true };
    try {
      // In a group, scope flow state to the sender so members don't clobber each other's menu position.
      const actor = m.isGroup ? m.author : undefined;
      const handled = await FlowEngine.processMessage(ctx, cfg.flow, hook.sessionId, m.chatId, m.body, m.id, actor);
      return { continue: !handled };
    } catch (err) {
      ctx.logger.error('chat-flow: flow processing failed', err);
      return { continue: true };
    }
  }
}
