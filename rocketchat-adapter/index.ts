import type { IPlugin, PluginContext, IncomingMessage } from '../types/openwa';
import { readConfig, stateKey } from './config.ts';
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
    readConfig(ctx.config);
    this.active = true;
    this.failures = 0;
    ctx.registerHook(
      'message:received',
      async (hook) => {
        const message = hook.data as IncomingMessage;
        if (hook.source !== 'Engine' || !inboundText(message)) return { continue: true };
        try {
          const config = readConfig(ctx.config); // resolved for THIS dispatch, never cached as base config
          if (hook.sessionId !== config.sessionId) return { continue: true };
          const bridge = this.bridge(ctx);
          // Off the ~5-second hook path. The bounded persistent queue owns retries after enqueue.
          void bridge
            .enqueue(message)
            .then(() => bridge.pump())
            .catch(() => this.failure(ctx));
        } catch {
          this.failure(ctx);
        }
        return { continue: true }; // observer; do not claim messages against sibling responders
      },
      HOOK_PRIORITY,
    );
    ctx.registerWebhook('omnichannel', async (req) => {
      try {
        const work = this.bridge(ctx).webhook(req);
        // Host ingress retries must see a failure within the worker's hook budget. The underlying
        // serialized operation keeps running, so a later retry waits for its dedup marker.
        await deadline(work);
      } catch {
        this.failure(ctx);
        throw new Error('Rocket.Chat agent relay failed; ingress may retry');
      }
    });
    this.timer = setInterval(() => {
      for (const bridge of this.jobs.values()) void bridge.pump().catch(() => this.failure(ctx));
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
  private failure(ctx: PluginContext): void {
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
    readConfig(ctx.config);
    this.active = true;
  }
  async onDisable(): Promise<void> {
    this.stop();
  }
  async onUnload(): Promise<void> {
    this.stop();
  }
  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    return {
      healthy: this.active && this.failures === 0,
      message: this.failures
        ? `${this.failures} relay failure(s) since enable; inspect retained queues; re-enable after resolving`
        : this.active
          ? 'Enabled; provider connectivity and WhatsApp delivery require a live test'
          : 'Disabled or invalid configuration',
    };
  }
}

function deadline(work: Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Agent relay exceeded worker deadline')), 4000);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
