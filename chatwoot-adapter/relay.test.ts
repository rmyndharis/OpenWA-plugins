import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePhone } from './relay.ts';
import type { IncomingMessage } from '../types/openwa';

test('group messages never get a phone, regardless of senderPhone or canonical', () => {
  assert.equal(resolvePhone({ isGroup: true, senderPhone: '+621' }, '621@c.us'), undefined);
  assert.equal(resolvePhone({ isGroup: true }, '120@g.us'), undefined);
});

test('senderPhone wins when set — normalized to +digits regardless of host-side formatting', () => {
  assert.equal(resolvePhone({ isGroup: false, senderPhone: '1234567890' }, '118367890123478@lid'), '+1234567890');
  assert.equal(resolvePhone({ isGroup: false, senderPhone: '+1234567890' }, '118367890123478@lid'), '+1234567890');
  // Separators / spaces / country-code prefixes the host might pass through.
  assert.equal(resolvePhone({ isGroup: false, senderPhone: '+1 123 456 7890' }, '118367890123478@lid'), '+11234567890');
  assert.equal(resolvePhone({ isGroup: false, senderPhone: '62-81-234-567' }, '6281234567@c.us'), '+6281234567');
});

test('senderPhone that strips to empty digits falls through to the canonical source', () => {
  // A malformed sender like '--' yields no digits; the helper must not emit a bare '+'.
  assert.equal(
    resolvePhone({ isGroup: false, senderPhone: '--' }, '1234567890@c.us'),
    '+1234567890',
  );
});

test('canonical `<digits>@c.us` is the phone when senderPhone is absent', () => {
  assert.equal(resolvePhone({ isGroup: false }, '1234567890@c.us'), '+1234567890');
  assert.equal(resolvePhone({ isGroup: false, senderPhone: null }, '6281234567@c.us'), '+6281234567');
  assert.equal(resolvePhone({ isGroup: false, senderPhone: undefined }, '6281234567@c.us'), '+6281234567');
  assert.equal(resolvePhone({ isGroup: false, senderPhone: '' }, '6281234567@c.us'), '+6281234567');
});

test('unresolved `@lid` (canonical stays `@lid`) yields no phone — pre-fix behavior preserved', () => {
  assert.equal(resolvePhone({ isGroup: false }, '118367890123478@lid'), undefined);
  assert.equal(resolvePhone({ isGroup: false, senderPhone: null }, '118367890123478@lid'), undefined);
});

test('groups (`@g.us`) and special channels (`@broadcast`, `@newsletter`) yield no phone', () => {
  assert.equal(resolvePhone({ isGroup: false }, '120363@g.us'), undefined);
  // Defensive: a chat-the-platform-doesn't-know should never produce a spurious +digits.
  assert.equal(resolvePhone({ isGroup: false }, 'newsletter@newsletter'), undefined);
  assert.equal(resolvePhone({ isGroup: false }, 'something@broadcast'), undefined);
  // A bare id (no @-suffixed domain, treated as `unknown` by the host's toNeutral) → no phone; the helper
  // does not guess at unrecognised formats, so a downstream createContact falls back to identifier-only.
  assert.equal(resolvePhone({ isGroup: false }, 'not-a-jid'), undefined);
});

test('`msg.contact?.number` is intentionally NOT consulted — it can carry lid digits for @lid senders', () => {
  // Even if the host happened to populate contact.number (= LID digits, never the real phone), the helper
  // drops it: using it would silently set a wrong phone on the contact and corrupt future merges.
  // We model the runtime shape (senderPhone undefined, contact.number the lid digits) and assert the
  // helper returns the canonical phone — which for an unresolved id is undefined, not the lid digits.
  const msgWithContact = {
    id: 'x', from: 'x', to: 'y', chatId: '118369936273478@lid', body: 'hi', type: 'chat',
    timestamp: 0, fromMe: false, isGroup: false,
    senderPhone: undefined, contact: { number: '118369936273478' },
  } as IncomingMessage;
  assert.equal(resolvePhone(msgWithContact, '118369936273478@lid'), undefined);
});
