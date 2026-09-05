import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from '../types/openwa';
import { inScope, sessionKey } from './filters.ts';

const base = (over: Partial<IncomingMessage> = {}): IncomingMessage =>
  ({ id: 'm1', from: 'x', to: 'y', chatId: 'c@c.us', body: 'hi', type: 'chat', timestamp: 0,
     fromMe: false, isGroup: false, ...over }) as IncomingMessage;

test('inScope: only Engine, not fromMe, chatId present', () => {
  assert.equal(inScope(base(), 'Engine', true), true);
  assert.equal(inScope(base(), 'Webhook', true), false);
  assert.equal(inScope(base({ fromMe: true }), 'Engine', true), false);
  assert.equal(inScope(base({ chatId: '' }), 'Engine', true), false);
});

test('inScope: group toggle', () => {
  const g = base({ isGroup: true, chatId: 'g@g.us', author: '62811@c.us' });
  assert.equal(inScope(g, 'Engine', true), true);
  assert.equal(inScope(g, 'Engine', false), false);
});

test('sessionKey: 1:1 keyed by chat; group keyed by sender', () => {
  assert.equal(sessionKey('s1', base()), 's1:c@c.us');
  assert.equal(
    sessionKey('s1', base({ isGroup: true, chatId: 'g@g.us', author: 'a@c.us' })),
    's1:g@g.us:a@c.us',
  );
});

// A group message with no author cannot be attributed to a participant. Keying such messages to a shared
// 'unknown' row merged strangers' flows: one contact's answer would advance another contact's Typebot
// session. Skipping is the only safe option.
test('a group message with no author is out of scope', () => {
  assert.equal(inScope(base({ isGroup: true, chatId: 'g@g.us', author: '62811@c.us' }), 'Engine', true), true);
  assert.equal(inScope(base({ isGroup: true, chatId: 'g@g.us' }), 'Engine', true), false,
    'no author → not attributable → skip');
});

test('group session keys are per participant', () => {
  const a = sessionKey('s1', base({ isGroup: true, chatId: 'g@g.us', author: '62811@c.us' }));
  const b = sessionKey('s1', base({ isGroup: true, chatId: 'g@g.us', author: '62822@c.us' }));
  assert.notEqual(a, b, 'two participants must never share a flow row');
});

// The per-participant guarantee is the whole reason group support is safe; assert the key CONTAINS the
// sender, not merely that two senders differ (that also holds if the key were the raw chatId).
test('a group session key embeds the participant', () => {
  const k = sessionKey('s1', base({ isGroup: true, chatId: 'g@g.us', author: '62811@c.us' }));
  assert.ok(k.includes('62811@c.us'), `expected the participant in the key, got ${k}`);
  assert.ok(k.includes('g@g.us'), 'and the chat');
});

test('a channel or broadcast post is out of scope', () => {
  // A followed channel would otherwise start a real Typebot flow (an outbound call per post) and take
  // a durable session row per channel, for a chat the account can never answer in.
  for (const chatId of ['120363000000000000@newsletter', '628123-456@broadcast', 'status@broadcast']) {
    assert.equal(inScope(base({ chatId }), 'Engine', true), false, chatId);
  }
  assert.equal(inScope(base({ chatId: '628123456789@c.us' }), 'Engine', true), true);
});
