// Supabase Send SMS hook → WhatsApp. Pure handler, unit-testable without a PluginContext.
//
// Runs ASYNC. The host verifies the Standard Webhooks signature (manifest signature.scheme:
// 'standard-webhooks') and runs the `session-alive` preflight BEFORE dispatching this handler, then
// fast-acks Supabase (200 application/json) and enqueues this handler from the ingress worker (BullMQ,
// retry + DLQ). So by the time we run, the request is authentic and the sending session is live; this
// handler only parses the payload and fires the WhatsApp send.
//
// The return value is ignored — only whether this handler THROWS matters: a throw makes the host retry
// (3×, backoff) then DLQ for redrive. Returning completes the JOB, but that is not quite "no retry":
// delivery is at-least-once. If the outcome is never recorded (a crash between dispatch and the write),
// the ingress row stays 'pending' and the host's reconciler re-dispatches it, running this handler a
// second time. The replay carries the SAME payload, so the contact receives the SAME code again — noisy,
// not a security problem. That is why there is no per-delivery dedup store here: it would add an
// unbounded key-per-delivery to the OTP critical path to suppress a duplicate of an identical message.
//
// Failure handling:
// - Missing/malformed phone/otp → return (permanent client error; a retry won't fix a bad payload).
// - No session to send from     → return (operator config error; won't self-heal in the retry window).
// - sendText failure            → fire-and-forget: the worker dispatch has a 5 s budget, so awaiting a
//   slow send risks a 504 → retry → DUPLICATE OTP. Background it; log failures.

import type { WebhookRequest, PluginMessagingCapability } from '../types/openwa';

export interface SupabaseSmsConfig {
  appName: string;
  messageTemplate: string;
  fallbackSessionId?: string;
  debug: boolean;
}

export interface HandlerDeps {
  config: SupabaseSmsConfig;
  messages: Pick<PluginMessagingCapability, 'sendText'>;
  log: (message: string, meta?: Record<string, unknown>) => void;
}

interface SupabaseSmsPayload {
  user?: { phone?: unknown };
  sms?: { otp?: unknown };
}

/** Validate operator config defensively (host form is advisory, not enforced). */
export function readConfig(raw: Record<string, unknown>): SupabaseSmsConfig {
  const appName = String(raw.appName ?? '').trim();
  if (!appName) throw new Error('supabase-otp-hook: appName is required');
  const messageTemplate = String(raw.messageTemplate ?? '{appName} | Your verification code is {otp}');
  const fallbackSessionId = raw.fallbackSessionId ? String(raw.fallbackSessionId) : undefined;
  const debug = raw.debug === true || raw.debug === 'true';
  return { appName, messageTemplate, fallbackSessionId, debug };
}

/**
 * Normalize an E.164 phone to a WhatsApp chat id "<digits>@c.us". Returns undefined when no digits.
 */
export function phoneToChatId(phone: unknown): string | undefined {
  if (typeof phone !== 'string') return undefined;
  const digits = phone.replace(/[^\d]/g, '');
  return digits.length > 0 ? `${digits}@c.us` : undefined;
}

/** Substitute {appName} and {otp} into the template in a single pass. */
export function composeMessage(template: string, otp: string, appName: string): string {
  return template.replace(/\{appName\}|\{otp\}/g, token => (token === '{appName}' ? appName : otp));
}

/**
 * Handle one Supabase Send SMS delivery. The host has already verified the signature and confirmed the
 * session is live; this parses the payload and fires the WhatsApp send. See the file header.
 */
export async function handleSendSms(deps: HandlerDeps, req: WebhookRequest): Promise<void> {
  const cfg = deps.config;

  let payload: SupabaseSmsPayload;
  try {
    payload = JSON.parse(req.body) as SupabaseSmsPayload;
  } catch {
    deps.log('supabase-otp-hook: malformed JSON body; not retrying');
    return;
  }

  const chatId = phoneToChatId(payload?.user?.phone);
  const otp = typeof payload?.sms?.otp === 'string' ? payload.sms.otp : undefined;
  if (!chatId || !otp) {
    deps.log('supabase-otp-hook: missing phone or otp; not retrying', { hasPhone: !!chatId, hasOtp: !!otp });
    return;
  }

  const sessionId = req.sessionId ?? cfg.fallbackSessionId;
  if (!sessionId) {
    deps.log('supabase-otp-hook: no session to send from');
    return;
  }

  // There is deliberately NO canonicalChatId call here. It looked like it protected an OTP addressed to
  // a `@lid` contact, but it cannot: `phoneToChatId` always yields `<digits>@c.us`, and the host's
  // resolver returns a `user`-kind jid unchanged (`toNeutralJid`, engine/identity/wa-id.ts) — so the
  // call was a guaranteed round-trip to the same string. It cost a 2 s race, the `engine:read`
  // permission, and a live-engine dependency on the OTP critical path, all for nothing.
  const targetChatId = chatId;

  if (cfg.debug) {
    deps.log('supabase-otp-hook: inbound delivery', {
      debug: true,
      instanceId: req.instanceId,
      deliveryId: req.deliveryId,
      sessionId,
      chatId: targetChatId,
    });
  }

  const text = composeMessage(cfg.messageTemplate, otp, cfg.appName);
  if (cfg.debug) deps.log('supabase-otp-hook: sending OTP', { debug: true, sessionId, chatId: targetChatId, text });

  // Fire-and-forget: the worker dispatch is bounded to 5 s (INGRESS_DISPATCH_TIMEOUT_MS), so awaiting a
  // slow send risks a 504 → retry → DUPLICATE OTP. Background it; failures are logged, not retried.
  void deps.messages.sendText(sessionId, targetChatId, text).then(
    () => { if (cfg.debug) deps.log('supabase-otp-hook: sendText ok', { debug: true, sessionId, chatId: targetChatId }); },
    (err: unknown) => {
      deps.log('supabase-otp-hook: sendText failed (background)', {
        sessionId, chatId: targetChatId, error: err instanceof Error ? err.message : String(err),
      });
    },
  );
}
