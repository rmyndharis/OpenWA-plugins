import type { IPlugin, PluginContext, IncomingMessage } from '../types/openwa';
import { readConfig, stateKey, type Config } from './config.ts';
import { inboundText } from './protocol.ts';
import { Bridge } from './bridge.ts';

export const HOOK_PRIORITY = 20;

export default class RocketChatAdapter implements IPlugin {
  private timer: ReturnType<typeof setInterval> | undefined;
  private generation = 0;
  private active = false;
  private jobs = new Map<string, Bridge>();
  private failures = 0;

  async onEnable(ctx: PluginContext): Promise<void> {
    this.stop();
    const initialConfig = readConfig(ctx.config);
    this.active = true;
    this.failures = 0;
    if (initialConfig.deadLetterAction !== 'none' && initialConfig.deadLetterAction) {
      await this.maintain(ctx, this.bridge(ctx), initialConfig);
    }
    ctx.registerHook(
      'message:received',
      async (hook) => {
        const message = hook.data as IncomingMessage;
        if (hook.source !== 'Engine' || !inboundText(message)) return { continue: true };
        const generation = this.generation;
        try {
          const config = readConfig(ctx.config); // resolved for THIS dispatch, never cached as base config
          if (hook.sessionId !== config.sessionId) return { continue: true };
          const bridge = this.bridge(ctx);
          // Off the ~5-second hook path. The bounded persistent queue owns retries after enqueue.
          void this.maintain(ctx, bridge, config)
            .then(() => bridge.enqueue(message))
            .then(() => bridge.pump())
            .catch(() => this.failure(ctx, generation));
        } catch {
          this.failure(ctx, generation);
        }
        return { continue: true }; // observer; do not claim messages against sibling responders
      },
      HOOK_PRIORITY,
    );
    ctx.registerWebhook('omnichannel', async (req) => {
      const generation = this.generation;
      try {
        await this.bridge(ctx).webhook(req);
      } catch {
        this.failure(ctx, generation);
        throw new Error('Rocket.Chat agent relay failed; ingress may retry');
      }
    });
    this.timer = setInterval(() => {
      const generation = this.generation;
      for (const bridge of this.jobs.values()) void bridge.pump().catch(() => this.failure(ctx, generation));
    }, 10_000);
    this.timer.unref();
  }

  private bridge(ctx: PluginContext): Bridge {
    const config = readConfig(ctx.config);
    const key = stateKey(config);
    const existing = this.jobs.get(key);
    if (existing) return existing;
    if (this.jobs.size >= 32)
      throw new Error('Too many Rocket.Chat destinations; re-enable after reviewing configuration');
    const generation = this.generation;
    const bridge = new Bridge(ctx, config, () => {
      if (!this.active || generation !== this.generation) throw new Error('Rocket.Chat configuration changed');
    });
    this.jobs.set(key, bridge);
    return bridge;
  }
  private async maintain(ctx: PluginContext, bridge: Bridge, config: Config): Promise<void> {
    if (!config.deadLetterAction || config.deadLetterAction === 'none') return;
    const result = await bridge.maintenance(config.deadLetterAction, config.deadLetterActionId!);
    if (result.replayed || result.cleared) {
      ctx.logger.log(
        `Rocket.Chat maintenance: ${result.replayed} replayed, ${result.cleared} cleared, ${result.remaining} retained`,
      );
    }
  }
  private failure(ctx: PluginContext, generation = this.generation): void {
    if (!this.active || generation !== this.generation) return;
    this.failures++;
    ctx.logger.error(
      'Rocket.Chat relay failed; inspect plugin health and retained pending work (no message content logged)',
    );
  }
  private stop(): void {
    this.active = false;
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.jobs.clear();
  }
  async onConfigChange(ctx: PluginContext): Promise<void> {
    this.active = false;
    this.generation++;
    this.jobs.clear(); // retire old destinations even when the replacement config is invalid
    const config = readConfig(ctx.config);
    this.active = true;
    this.failures = 0;
    if (config.deadLetterAction && config.deadLetterAction !== 'none')
      await this.maintain(ctx, this.bridge(ctx), config);
  }
  async onDisable(): Promise<void> {
    this.stop();
  }
  async onUnload(): Promise<void> {
    this.stop();
  }
  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    const queues = await Promise.all([...this.jobs.values()].map((bridge) => bridge.status()));
    const dead = queues.reduce((count, queue) => count + queue.dead, 0);
    const pending = queues.reduce((count, queue) => count + queue.pending, 0);
    return {
      healthy: this.active && this.failures === 0 && dead === 0,
      message: this.failures
        ? `${this.failures} relay failure(s) since enable; inspect retained queues; re-enable after resolving`
        : this.active
          ? `Enabled; ${pending} pending, ${dead} dead letter(s); provider connectivity requires a live test`
          : 'Disabled or invalid configuration',
    };
  }
}
