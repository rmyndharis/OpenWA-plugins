import type { IPlugin, PluginContext } from '../types/openwa';
import { handleSendSms, readConfig } from './handler.ts';

/**
 * Supabase Send SMS Hook.
 *
 * Receives Supabase Auth's Send SMS hook on the ingress route "send-sms". The host verifies the
 * Standard Webhooks signature (manifest signature.scheme: 'standard-webhooks', secret = instance.secret)
 * and runs the `session-alive` preflight before dispatching this handler, so Supabase gets synchronous
 * feedback: 401 on a bad signature, 503 on a dead session, and 200 on accept. The ack BODY is the JSON
 * literal {"ok":true}; its CONTENT TYPE depends on the host. The manifest declares application/json,
 * which hosts below 0.20.0 return, but 0.20.0 and later force text/plain on every ingress response
 * (`res.type('text/plain')` after `res.set`, ingress.controller.ts) so a reflected body cannot be parsed
 * as HTML. The declaration is kept because it is still honored on the older hosts this plugin supports,
 * but nothing may depend on the ack's content type.
 *
 * This handler runs async from the ingress worker (retry + DLQ) and only parses the payload + fires the
 * WhatsApp send. It waits just long enough to catch a send that fails immediately, so the host retries
 * and dead-letters those, and leaves a slow one running in the background: an awaited slow send would
 * burn the worker's 5 s dispatch budget and retry into a duplicate OTP.
 */
export default class SupabaseSmsHook implements IPlugin {
  // Outcome of the most recent send, cleared by the next one that succeeds. A send that fails AFTER the
  // handler's fail-fast window has closed reaches nobody else: Supabase was acked 200 and the ingress
  // job already completed, so there is no retry and no dead-letter row. healthCheck is the only surface
  // the dashboard renders, so this is where such an OTP surfaces as lost.
  private lastSendError: string | null = null;

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
          onSendResult: error => {
            this.lastSendError = error;
          },
        },
        req,
      );
    });

    ctx.logger.log('supabase-otp-hook enabled');
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    if (!this.lastSendError) return { healthy: true };
    // Unhealthy while the last OTP is on record as undelivered. The plugin is up, but the one thing it
    // exists to do did not happen, and the host reporting a plugin without a health check as healthy is
    // what kept that invisible.
    return { healthy: false, message: `last OTP send failed: ${this.lastSendError.slice(0, 200)}` };
  }
}
