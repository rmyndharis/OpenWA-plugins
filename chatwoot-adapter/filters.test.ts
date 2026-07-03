import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRelayInbound, shouldRelayOutbound, shouldRelayOwn } from './filters.ts';

const base = {
  id: 'm1',
  from: 'x',
  to: 'y',
  chatId: 'c',
  body: 'hi',
  type: 'chat',
  timestamp: 0,
  fromMe: false,
  isGroup: false,
} as const;

test('inbound: Engine + not fromMe + has chatId; drops API, fromMe, and groups when relayGroups=false', () => {
  assert.equal(shouldRelayInbound(base, 'Engine', true), true);
  assert.equal(shouldRelayInbound({ ...base, fromMe: true }, 'Engine', true), false);
  assert.equal(shouldRelayInbound(base, 'API', true), false);
  assert.equal(shouldRelayInbound({ ...base, isGroup: true }, 'Engine', false), false);
  assert.equal(shouldRelayInbound({ ...base, isGroup: true }, 'Engine', true), true);
});

test('own-outbound: Engine + fromMe + has chatId; drops inbound, API source, empty chatId, and groups when relayGroups=false', () => {
  const own = { ...base, fromMe: true } as const;
  assert.equal(shouldRelayOwn(own, 'Engine', true), true);
  assert.equal(shouldRelayOwn({ ...own, fromMe: false }, 'Engine', true), false); // inbound is not an own send
  assert.equal(shouldRelayOwn(own, 'API', true), false); // only engine-delivered creates
  assert.equal(shouldRelayOwn({ ...own, chatId: '' }, 'Engine', true), false); // no target chat
  assert.equal(shouldRelayOwn({ ...own, isGroup: true }, 'Engine', false), false);
  assert.equal(shouldRelayOwn({ ...own, isGroup: true }, 'Engine', true), true);
});

test('outbound: strict private — relay only outgoing + private===false in the configured inbox', () => {
  const ok = { message_type: 'outgoing', private: false, inbox: { id: 7 }, conversation: { id: 1 }, content: 'r' };
  assert.equal(shouldRelayOutbound(ok, 7), true);
  assert.equal(shouldRelayOutbound({ ...ok, message_type: 'incoming' }, 7), false); // echo
  assert.equal(shouldRelayOutbound({ ...ok, private: true }, 7), false); // private note
  assert.equal(shouldRelayOutbound({ ...ok, private: undefined }, 7), false); // absent → drop (fail-closed)
  assert.equal(shouldRelayOutbound({ ...ok, inbox: { id: 9 } }, 7), false); // foreign inbox
});
