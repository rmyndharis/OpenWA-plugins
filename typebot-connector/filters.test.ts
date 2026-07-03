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
  const g = base({ isGroup: true, chatId: 'g@g.us' });
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
