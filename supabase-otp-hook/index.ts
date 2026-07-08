import type { IPlugin, PluginContext } from '../types/openwa';
import { handleSendSms, readConfig } from './handler.ts';

/**
 * Supabase Send SMS Hook.
 *
 * Receives Supabase Auth's Send SMS hook on the ingress route "send-sms". The host skips signature
 * verification (manifest signature.scheme: 'none'); this plugin self-verifies the Standard Webhooks
 * signature in the handler using node:crypto.
 *
 * Runs in `sync-reply` mode so the HTTP response returned to Supabase reflects the actual outcome:
 * 200 application/json after the liveness probe, 400/401 for client errors, 500 for
 * misconfiguration, 503 for a dead session, and 504 if the host timeout is exceeded. The WhatsApp
 * send is fire-and-forget because Supabase has a 5 s hook timeout and does not retry.
 */
export default class SupabaseSmsHook implements IPlugin {
  async onEnable(ctx: PluginContext): Promise<void> {
    // Fail fast at enable time on the base config so a missing secret surfaces in the dashboard
    // instead of failing per-delivery. Per-instance config is re-read in the handler via ctx.config.
    readConfig(ctx.config);

    ctx.registerWebhook('send-sms', async req => {
      // Re-read config per delivery so edits (secret rotation, template tweak) apply live.
      const config = readConfig(ctx.config);
      return handleSendSms(
        {
          config,
          messages: ctx.messages,
          engine: ctx.engine,
          log: (m, meta) => ctx.logger.warn(m, meta),
          now: () => Date.now(),
        },
        req,
      );
    });

    ctx.logger.log('supabase-otp-hook enabled');
  }
}
