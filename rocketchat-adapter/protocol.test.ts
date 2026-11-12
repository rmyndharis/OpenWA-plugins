import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from '../types/openwa';
import { inboundText, parseAgentEvent } from './protocol.ts';
import { readConfig, stateKey } from './config.ts';

const message = {
  id: 'wa1',
  chatId: '15550001111@c.us',
  body: 'hello',
  fromMe: false,
  type: 'text',
} as IncomingMessage;
test('accepts direct text and lid ids but rejects groups, media, products, broadcasts and own sends', () => {
  assert.equal(inboundText(message), true);
  assert.equal(inboundText({ ...message, chatId: '123456@lid' }), true);
  for (const override of [
    { fromMe: true },
    { type: 'image' },
    { type: 'contact' },
    { type: 'product' },
    { chatId: '123@g.us' },
    { chatId: '123@newsletter' },
    { isStatusBroadcast: true },
    { body: ' ' },
    { body: 'x'.repeat(4097) },
  ]) {
    assert.equal(inboundText({ ...message, ...override }), false);
  }
});

test('only authentic agent plain text is selected, never notes, files, edits or system messages', () => {
  const valid = { _id: 'm1', agentId: 'a1', msg: 'hello' };
  const messages = [
    valid,
    { ...valid, agentId: undefined },
    { ...valid, private: true },
    { ...valid, internal: true },
    { ...valid, files: [{}] },
    { ...valid, editedAt: 'now' },
    { ...valid, t: 'uj' },
    { ...valid, msg: 'x'.repeat(4097) },
  ];
  assert.deepEqual(
    parseAgentEvent(JSON.stringify({ type: 'Message', _id: 'room', visitor: { token: 'secret' }, messages }))?.messages,
    [{ id: 'm1', text: 'hello' }],
  );
  assert.equal(parseAgentEvent(JSON.stringify({ type: 'LivechatSession' })), null);
});

test('invalid webhook shapes fail explicitly', () => {
  for (const body of ['not json', '[]', 'null', '{"type":"Message"}']) assert.throws(() => parseAgentEvent(body));
});

test('configuration validates origin and required session and never permits arbitrary HTTP', () => {
  assert.equal(
    readConfig({ baseUrl: 'https://rocket.example', sessionId: 'session' }).baseUrl,
    'https://rocket.example',
  );
  for (const baseUrl of [
    'http://localhost:3000',
    'http://rocketchat:3000',
    'https://user:secret@rocket.example',
    'https://rocket.example/admin',
    'https://rocket.example?secret=x',
    'ftp://rocket.example',
    'https://*.example',
  ]) {
    assert.throws(() => readConfig({ baseUrl, sessionId: 'session' }));
  }
  assert.throws(() => readConfig({ baseUrl: 'https://rocket.example', sessionId: '' }));
});

test('state namespaces isolate origin, session and department, and normalize origin slashes', () => {
  const a = readConfig({ baseUrl: 'https://rocket.example', sessionId: 's1' });
  assert.equal(stateKey(a), stateKey(readConfig({ baseUrl: 'https://rocket.example/', sessionId: 's1' })));
  for (const override of [{ baseUrl: 'https://other.example' }, { sessionId: 's2' }, { department: 'support' }]) {
    assert.notEqual(stateKey(a), stateKey({ ...a, ...override }));
  }
});

test('empty attachment arrays on plain text do not hide an agent reply', () => {
  const body = JSON.stringify({
    type: 'Message',
    _id: 'room',
    visitor: { token: 'token' },
    messages: [{ _id: 'reply', agentId: 'agent', msg: 'text', files: [], attachments: [] }],
  });
  assert.deepEqual(parseAgentEvent(body)?.messages, [{ id: 'reply', text: 'text' }]);
});

test('maintenance requires a fresh syntactically valid action id', () => {
  const base = { baseUrl: 'https://rocket.example', sessionId: 's1' };
  assert.throws(() => readConfig({ ...base, deadLetterAction: 'clear' }));
  assert.throws(() => readConfig({ ...base, deadLetterAction: 'other' }));
  assert.doesNotThrow(() => readConfig({ ...base, deadLetterAction: 'replay', deadLetterActionId: 'retry-1' }));
});
