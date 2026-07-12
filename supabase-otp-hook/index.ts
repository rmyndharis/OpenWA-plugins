import type { IPlugin, PluginContext } from '../types/openwa';
import { handleSendSms, readConfig } from './handler.ts';

/**
 * Supabase Send SMS Hook.
 *
 * Receives Supabase Auth's Send SMS hook on the ingress route "send-sms". The host verifies the
 * Standard Webhooks signature (manifest signature.scheme: 'standard-webhooks', secret = instance.secret)
 * and runs the `session-alive` preflight before dispatching this handler, so Supabase gets synchronous
 * feedback: 401 on a bad signature, 503 on a dead session, and 200 application/json on accept. This
 * handler runs async from the ingress worker (retry + DLQ) and only parses the payload + fires the
 * WhatsApp send. The send is fire-and-forget to stay within the worker's 5 s dispatch budget (an
 * awaited slow send would time out and retry into a duplicate OTP).
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
          log: (m, meta) => ctx.logger.warn(m, meta),
        },
        req,
      );
    });

    ctx.logger.log('supabase-otp-hook enabled');
  }
}
