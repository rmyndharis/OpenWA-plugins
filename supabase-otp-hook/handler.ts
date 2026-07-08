// Supabase Send SMS hook → WhatsApp. Pure handler, unit-testable without a PluginContext.
//
// Runs in `sync-reply` mode so the HTTP response returned to Supabase reflects the actual outcome.
//
// Failure semantics:
// - Signature/replay failure    → 401 (permanent; don't retry).
// - Missing/malformed phone/otp → 400 (permanent client error; don't retry).
// - No session to send from     → 500 (operator config error; won't fix itself).
// - Session not live            → 503 (permanent; retry won't revive a dead session).
// - sendText failure (slow)     → fire-and-forget; logged (warn), not surfaced via the response.
// - Timeout                     → 504 (host returns this when the handler exceeds the budget).

import type { WebhookRequest, WebhookResponse, PluginMessagingCapability, PluginEngineReadCapability } from '../types/openwa';
import { verifyStandardWebhooks } from './verify.ts';

function jsonResponse(status: number, body: Record<string, unknown>): WebhookResponse {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

export interface SupabaseSmsConfig {
  appName: string;
  webhookSecret: string;
  messageTemplate: string;
  fallbackSessionId?: string;
  debug: boolean;
}

export interface HandlerDeps {
  config: SupabaseSmsConfig;
  messages: Pick<PluginMessagingCapability, 'sendText'>;
  engine: Pick<PluginEngineReadCapability, 'canonicalChatId'>;
  log: (message: string, meta?: Record<string, unknown>) => void;
  now: () => number; // ms epoch (injected for deterministic replay tests)
}

interface SupabaseSmsPayload {
  user?: { phone?: unknown };
  sms?: { otp?: unknown };
}

/** Validate operator config defensively (host form is advisory, not enforced). */
export function readConfig(raw: Record<string, unknown>): SupabaseSmsConfig {
  const appName = String(raw.appName ?? '').trim();
  if (!appName) throw new Error('supabase-otp-hook: appName is required');
  const webhookSecret = String(raw.webhookSecret ?? '').trim();
  if (!webhookSecret) throw new Error('supabase-otp-hook: webhookSecret is required');
  if (webhookSecret.length < 16) throw new Error('supabase-otp-hook: webhookSecret must be at least 16 characters');
  const messageTemplate = String(raw.messageTemplate ?? '{appName} | Your verification code is {otp}');
  const fallbackSessionId = raw.fallbackSessionId ? String(raw.fallbackSessionId) : undefined;
  const debug = raw.debug === true || raw.debug === 'true';
  return { appName, webhookSecret, messageTemplate, fallbackSessionId, debug };
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
 * Handle one verified Supabase Send SMS delivery. See file header for failure semantics.
 */
export async function handleSendSms(deps: HandlerDeps, req: WebhookRequest): Promise<WebhookResponse> {
  const cfg = deps.config;

  const verdict = verifyStandardWebhooks({
    rawBody: req.rawBody,
    headers: req.headers,
    secret: cfg.webhookSecret,
    now: deps.now(),
  });
  if (cfg.debug) {
    // Redact the signature value but keep prefix + length so an operator can see it's shaped right.
    const sigHeader = req.headers['webhook-signature'];
    const redactedSig = sigHeader ? `${sigHeader.slice(0, 3)}…(${sigHeader.length} chars)` : '(absent)';
    deps.log('supabase-otp-hook: inbound delivery', {
      debug: true,
      instanceId: req.instanceId,
      deliveryId: req.deliveryId,
      sessionId: req.sessionId,
      fallbackSessionId: cfg.fallbackSessionId,
      signature: { ok: verdict.ok, reason: verdict.reason, header: redactedSig },
      headers: req.headers,
      rawBody: req.rawBody,
    });
  }
  if (!verdict.ok) {
    deps.log('supabase-otp-hook: signature verification failed', { reason: verdict.reason });
    return jsonResponse(401, { ok: false, error: verdict.reason ?? 'signature verification failed' });
  }

  let payload: SupabaseSmsPayload;
  try {
    payload = JSON.parse(req.body) as SupabaseSmsPayload;
  } catch {
    deps.log('supabase-otp-hook: malformed JSON body; returning 400 to avoid retry loop');
    return jsonResponse(400, { ok: false, error: 'malformed JSON body' });
  }

  const chatId = phoneToChatId(payload?.user?.phone);
  const otp = typeof payload?.sms?.otp === 'string' ? payload.sms.otp : undefined;
  if (!chatId || !otp) {
    deps.log('supabase-otp-hook: missing phone or otp; returning 400', { hasPhone: !!chatId, hasOtp: !!otp });
    return jsonResponse(400, { ok: false, error: 'missing phone or otp' });
  }

  const sessionId = req.sessionId ?? cfg.fallbackSessionId;
  if (!sessionId) {
    deps.log('supabase-otp-hook: no session to send from');
    return jsonResponse(500, { ok: false, error: 'no session to send from' });
  }

  // Liveness probe: canonicalChatId is a host-side lookup (no WA network call) that throws when the
  // session has no active engine.
  try {
    await deps.engine.canonicalChatId(sessionId, chatId);
  } catch (err) {
    deps.log('supabase-otp-hook: session not live; returning 503', {
      sessionId, chatId, error: err instanceof Error ? err.message : String(err),
    });
    return jsonResponse(503, { ok: false, error: 'session not live' });
  }

  const text = composeMessage(cfg.messageTemplate, otp, cfg.appName);
  if (cfg.debug) deps.log('supabase-otp-hook: sending OTP', { debug: true, sessionId, chatId, text });

  void deps.messages.sendText(sessionId, chatId, text).then(
    () => { if (cfg.debug) deps.log('supabase-otp-hook: sendText ok', { debug: true, sessionId, chatId }); },
    (err: unknown) => {
      deps.log('supabase-otp-hook: sendText failed (background)', {
        sessionId, chatId, error: err instanceof Error ? err.message : String(err),
      });
    },
  );
  return jsonResponse(200, { ok: true });
}
