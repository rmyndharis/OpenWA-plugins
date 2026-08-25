// Supabase Send SMS hook → WhatsApp. Pure handler, unit-testable without a PluginContext.
//
// Runs ASYNC. The host verifies the Standard Webhooks signature (manifest signature.scheme:
// 'standard-webhooks') and runs the `session-alive` preflight BEFORE dispatching this handler, then
// fast-acks Supabase (200) and enqueues this handler from the ingress worker (BullMQ, retry + DLQ). So
// by the time we run, the request is authentic and the sending session is live; this handler only
// parses the payload and fires the WhatsApp send.
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
// - sendText failure            → throw if it lands inside the fail-fast window, so the host retries the
//   delivery and finally dead-letters it. A send that is only SLOW is left running in the background:
//   the worker dispatch has a 5 s budget, and an overrun is a retry → DUPLICATE OTP.

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
  /** The send's outcome (null = delivered), reported even after the fail-fast window closed and this
   *  handler returned. index.ts keeps the last one for healthCheck. */
  onSendResult?: (error: string | null) => void;
  /** Fail-fast window override in ms; defaults to SEND_FAILFAST_MS. Tests shorten it. */
  failFastMs?: number;
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
/**
 * A chat id reduced to what a diagnostic actually needs: enough to correlate two lines about the same
 * chat, not enough to identify its owner. Debug output is what gets pasted into a support thread or
 * shipped to a log collector, and a WhatsApp id is a phone number.
 */
export function maskChatId(chatId: string): string {
  const [local, domain = 'c.us'] = chatId.split('@');
  return local.length <= 4 ? `***@${domain}` : `***${local.slice(-4)}@${domain}`;
}

export function composeMessage(template: string, otp: string, appName: string): string {
  return template.replace(/\{appName\}|\{otp\}/g, token => (token === '{appName}' ? appName : otp));
}

/**
 * How long the handler waits for the send to fail before leaving it to finish in the background. Long
 * enough for the capability round trip that carries an instant rejection (plugin not activated for the
 * session, session has no live engine, at the concurrent-capability limit), and far short of the host's
 * 5 s dispatch budget, whose overrun is reported as a failed delivery and retried into a duplicate OTP.
 */
const SEND_FAILFAST_MS = 1500;

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
      chatId: maskChatId(targetChatId),
    });
  }

  const text = composeMessage(cfg.messageTemplate, otp, cfg.appName);
  // Never the code itself: it is a live credential, and debug is on exactly when output is being shared.
  if (cfg.debug) deps.log('supabase-otp-hook: sending OTP', { debug: true, sessionId, chatId: maskChatId(targetChatId), textLength: text.length });

  // The send is raced against a short deadline rather than fired and forgotten. The two failure modes
  // pull in opposite directions and both are real:
  //
  //  - A send that is only SLOW must outlive this handler. The worker dispatch is bounded to 5 s
  //    (INGRESS_DISPATCH_TIMEOUT_MS) and an overrun reaches the host as a failed delivery, which retries
  //    the job and sends the contact a DUPLICATE OTP.
  //  - A send that has ALREADY FAILED must not be swallowed. The capability layer rejects instantly when
  //    the plugin is not activated for the session, when the session has no live engine, and when the
  //    plugin is at its concurrent-capability limit. Supabase was acked 200 before this handler ran and
  //    never retries such a delivery itself, so backgrounding it lost the code outright, with one warn
  //    line to show for it.
  //
  // Throwing inside the window hands the delivery back to the host, which retries it with backoff and
  // writes a dead-letter row for redrive once the attempts are spent. Nothing was delivered in that
  // case, so a retry cannot duplicate anything.
  const settled = deps.messages.sendText(sessionId, targetChatId, text).then(
    () => {
      if (cfg.debug) deps.log('supabase-otp-hook: sendText ok', { debug: true, sessionId, chatId: maskChatId(targetChatId) });
      deps.onSendResult?.(null);
      return null;
    },
    (err: unknown) => {
      const error = err instanceof Error ? err.message : String(err);
      deps.log('supabase-otp-hook: sendText failed', {
        sessionId, chatId: maskChatId(targetChatId), error,
      });
      deps.onSendResult?.(error);
      return error;
    },
  );

  const failFastMs = deps.failFastMs ?? SEND_FAILFAST_MS;
  // A sentinel rather than a rejection, so a slow send is not mistaken for a failed one.
  const pending = Symbol('pending');
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Deliberately NOT unref'd: this timer is the only thing that can end the race when the send neither
  // resolves nor rejects, and an unref'd one lets the loop drain first, leaving the handler hanging
  // until the host's dispatch budget kills it. It is cleared the moment the race settles, so it holds
  // the loop for at most one window, while an OTP delivery is genuinely in flight.
  const deadline = new Promise<typeof pending>(resolve => {
    timer = setTimeout(() => resolve(pending), failFastMs);
  });
  const outcome = await Promise.race([settled, deadline]);
  clearTimeout(timer);
  if (outcome !== pending && outcome !== null) {
    throw new Error(`supabase-otp-hook: WhatsApp send failed: ${outcome}`);
  }
}
