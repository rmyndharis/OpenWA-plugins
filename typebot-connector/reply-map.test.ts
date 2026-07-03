import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from '../types/openwa';
import type { Awaiting } from './typebot-types.ts';
import { mapReply } from './reply-map.ts';

const msg = (over: Partial<IncomingMessage> = {}): IncomingMessage =>
  ({ id: 'm', from: 'x', to: 'y', chatId: 'c', body: '', type: 'chat', timestamp: 0,
     fromMe: false, isGroup: false, ...over }) as IncomingMessage;

const choice: Awaiting = { kind: 'choice', blockId: 'b', multiple: false, items: [
  { id: '1', content: 'Sales' }, { id: '2', content: 'Support' },
] };

test('numeric choice maps to the item content; out-of-range/non-numeric passes raw text', () => {
  assert.deepEqual(mapReply(choice, msg({ body: '2' })), { kind: 'text', message: 'Support' });
  assert.deepEqual(mapReply(choice, msg({ body: '9' })), { kind: 'text', message: '9' });
  assert.deepEqual(mapReply(choice, msg({ body: 'sales please' })), { kind: 'text', message: 'sales please' });
});

test('multi-choice joins picked contents', () => {
  const multi: Awaiting = { ...choice, multiple: true };
  assert.deepEqual(mapReply(multi, msg({ body: '1, 2' })), { kind: 'text', message: 'Sales, Support' });
});

test('file input: media uploads; omitted media falls back; no media prompts', () => {
  const file: Awaiting = { kind: 'file', blockId: 'b' };
  assert.deepEqual(
    mapReply(file, msg({ media: { mimetype: 'image/png', filename: 'p.png', data: 'AAA' } })),
    { kind: 'file', mime: 'image/png', filename: 'p.png', data: 'AAA' },
  );
  assert.equal(mapReply(file, msg({ media: { mimetype: 'image/png', omitted: true } })).kind, 'fallback');
  assert.equal(mapReply(file, msg({ body: 'skip' })).kind, 'fallback');
});

test('typed/free-text and rating pass the raw text through', () => {
  const text: Awaiting = { kind: 'text', blockId: 'b', attachmentsEnabled: false };
  assert.deepEqual(mapReply(text, msg({ body: 'me@x.io' })), { kind: 'text', message: 'me@x.io' });
  const rating: Awaiting = { kind: 'rating', blockId: 'b', max: 5 };
  assert.deepEqual(mapReply(rating, msg({ body: '4' })), { kind: 'text', message: '4' });
});
