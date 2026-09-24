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

// From host 0.23.2 a shared contact card carries its vCard as the body and a poll its question, so
// `body` alone no longer means the contact typed an answer. A vCard holding a bare in-range digit (a
// street number, an extension) would silently select a numbered choice.
test('a contact card or a poll prompts instead of answering the step', () => {
  const vcard = 'BEGIN:VCARD\nVERSION:3.0\nFN:Budi\nADR:;;2;Jakarta\nEND:VCARD';
  assert.deepEqual(
    mapReply(choice, msg({ body: '2', type: 'text' })),
    { kind: 'text', message: 'Support' },
    'guard rail: as text, a bare 2 does select the second option',
  );
  const card = mapReply(choice, msg({ body: vcard, type: 'contact' }));
  assert.equal(card.kind, 'fallback', 'a contact card must not advance the flow');
  const poll = mapReply(choice, msg({ body: 'Sales', type: 'poll' }));
  assert.equal(poll.kind, 'fallback', 'a poll must not advance the flow');
});

// From host 0.23.5 a Baileys catalog order carries its note (else its title) as the body, so an order
// noting a bare in-range digit would select a numbered choice.
test('an order prompts instead of answering the step', () => {
  const r = mapReply(choice, msg({ body: '2', type: 'order' }));
  assert.equal(r.kind, 'fallback', 'an order must not advance the flow');
});

// From host 0.23.5 a Baileys product card carries its text (else the product title) as the body, so on a
// multi-select step any in-range digit in a title would pick that item.
test('a product card prompts instead of answering the step', () => {
  const multi: Awaiting = { ...choice, multiple: true };
  const r = mapReply(multi, msg({ body: 'Kopi Gayo 1 kg', type: 'product' }));
  assert.equal(r.kind, 'fallback', 'a product card must not advance the flow');
});

test('a contact card at a file step keeps that step\'s own wording', () => {
  const file: Awaiting = { kind: 'file', blockId: 'b' };
  const r = mapReply(file, msg({ body: 'BEGIN:VCARD\nEND:VCARD', type: 'contact' }));
  assert.deepEqual(r, { kind: 'fallback', text: 'Please send a file or photo to continue.' });
});

test('typed/free-text and rating pass the raw text through', () => {
  const text: Awaiting = { kind: 'text', blockId: 'b', attachmentsEnabled: false };
  assert.deepEqual(mapReply(text, msg({ body: 'me@x.io' })), { kind: 'text', message: 'me@x.io' });
  const rating: Awaiting = { kind: 'rating', blockId: 'b', max: 5 };
  assert.deepEqual(mapReply(rating, msg({ body: '4' })), { kind: 'text', message: '4' });
});

test('an optional file step skips only on its skip label, and only when typed', () => {
  const optional: Awaiting = { kind: 'file', blockId: 'b', skipLabel: 'Lewati' };
  assert.deepEqual(mapReply(optional, msg({ body: ' LEWATI ', type: 'text' })), { kind: 'skip' });
  const other = mapReply(optional, msg({ body: 'sebentar ya' }));
  assert.equal(other.kind, 'fallback', 'any other text leaves the step where it is');
  assert.match(other.kind === 'fallback' ? other.text : '', /"Lewati"/);
  const photo = mapReply(optional, msg({ body: 'Lewati', media: { mimetype: 'image/png', filename: 'p.png', data: 'AAA' } }));
  assert.equal(photo.kind, 'file', 'a photo captioned with the word is the file');
  assert.equal(mapReply(optional, msg({ body: 'Lewati', type: 'contact' })).kind, 'fallback', 'a card never skips');
});

test('an attachment that did not come through at a file step does not invite typing', () => {
  const omitted = msg({ media: { mimetype: 'image/png', omitted: true } });
  const required = mapReply({ kind: 'file', blockId: 'b' }, omitted);
  assert.equal(required.kind, 'fallback');
  assert.doesNotMatch(required.kind === 'fallback' ? required.text : '', /type/);
  const optional = mapReply({ kind: 'file', blockId: 'b', skipLabel: 'Skip' }, omitted);
  assert.match(optional.kind === 'fallback' ? optional.text : '', /reply "Skip" to skip/);
  const text = mapReply({ kind: 'text', blockId: 'b', attachmentsEnabled: true }, omitted);
  assert.match(text.kind === 'fallback' ? text.text : '', /or type to continue/);
});
