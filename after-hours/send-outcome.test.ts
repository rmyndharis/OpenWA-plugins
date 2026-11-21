import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendOutcomeUnknown } from './send-outcome.ts';

// The texts below are the literals OpenWA v0.31.0 sends (PAGE_RELOADED_DURING_SEND_MESSAGE in
// wwebjs-messaging.ts, CONNECTION_LOST_DURING_SEND_MESSAGE in baileys-messaging.ts, the capability timeout in
// plugin-worker-host.ts). The identical copies of this helper in faq-bot and chatwoot-adapter are kept in sync
// by scripts/shared-copies.test.mjs, so this is the one place that pins its wording.
const PAGE_RELOADED_DURING_SEND =
  'WhatsApp Web reloaded its page while the message was being sent, and it may or may not have been sent. ' +
  'Check the chat before sending it again.';
const CONNECTION_LOST_DURING_SEND =
  'The WhatsApp connection was replaced or stopped while the message was being sent, and it may or may not have ' +
  'been sent. Check the chat before sending it again.';

test('a send cut short by a page reload or a lost connection has an unknown outcome', () => {
  assert.equal(sendOutcomeUnknown(new Error(PAGE_RELOADED_DURING_SEND)), true);
  assert.equal(sendOutcomeUnknown(new Error(CONNECTION_LOST_DURING_SEND)), true);
  assert.equal(sendOutcomeUnknown(PAGE_RELOADED_DURING_SEND), true);
});

test("a send verb that timed out on the host may still land", () => {
  assert.equal(sendOutcomeUnknown(new Error("capability 'messages.reply' timed out after 120000ms")), true);
});

test('a refusal that sent nothing is safe to repeat', () => {
  const refusals = [
    // The reload refusal of a request that sent nothing tells the client to ask again.
    'WhatsApp Web is reloading its page and the session is re-injecting. Retry every few seconds: this can last a few minutes.',
    'Session is not connected. The WhatsApp client is not ready.',
    'Message 3EB0A1 not found',
    'Message 3EB0A1 not found in chat 628111@c.us',
    'blocked by plugin',
    'capability call rejected: too many unanswered capability calls (limit 64) before the hook handler that made this messages.reply call returned',
  ];
  for (const text of refusals) assert.equal(sendOutcomeUnknown(new Error(text)), false, text);
  assert.equal(sendOutcomeUnknown(undefined), false);
  assert.equal(sendOutcomeUnknown(null), false);
});
