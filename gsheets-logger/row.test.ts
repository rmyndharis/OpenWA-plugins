import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRow, COLUMNS } from './row.ts';

const T = new Date('2026-06-22T10:00:00.000Z');

test('received maps to an in row with sender name', () => {
  const row = buildRow({
    event: 'message:received', sessionId: 's1', timestamp: T, source: 'Engine',
    data: {
      id: 'M1', from: '62811@c.us', to: 'me', chatId: '62811@c.us', body: 'hi',
      type: 'text', fromMe: false, isGroup: false, contact: { pushName: 'Budi' },
    },
  });
  assert.equal(row.length, COLUMNS.length);
  assert.deepEqual(row, [
    '2026-06-22T10:00:00.000Z', 's1', 'message:received', 'in', '62811@c.us',
    '62811@c.us', 'me', 'Budi', 'false', 'text', 'hi', 'M1', '', '',
  ]);
});

test('sent maps to an out row', () => {
  const row = buildRow({
    event: 'message:sent', sessionId: 's1', timestamp: T, source: 'Engine',
    data: { id: 'M2', from: 'me', to: '62811@c.us', chatId: '62811@c.us', body: 'yo', type: 'text', fromMe: true, isGroup: false },
  });
  assert.equal(row[3], 'out');
  assert.equal(row[11], 'M2');
  assert.equal(row[7], ''); // no contact -> empty senderName
});

test('failed maps error and input fields, no message id', () => {
  const row = buildRow({
    event: 'message:failed', sessionId: 's1', timestamp: T, source: 'MessageService',
    data: { sessionId: 's1', error: 'boom', input: { chatId: '62811@c.us', text: 'bye' } },
  });
  assert.equal(row[3], 'out');
  assert.equal(row[4], '62811@c.us'); // chatId from input
  assert.equal(row[6], '62811@c.us'); // to mirrors chatId for a failed send
  assert.equal(row[10], 'bye');        // body from input.text
  assert.equal(row[13], 'boom');       // error
  assert.equal(row[11], '');           // no messageId
});

test('absent fields degrade to empty strings', () => {
  const row = buildRow({ event: 'message:received', sessionId: undefined, timestamp: T, source: 'Engine', data: {} });
  assert.equal(row.length, COLUMNS.length);
  assert.equal(row[1], '');  // sessionId
  assert.equal(row[10], ''); // body
});

test('sanitizes formula-injection in attacker-controlled cells', () => {
  const row = buildRow({
    event: 'message:received', sessionId: 's1', timestamp: T, source: 'Engine',
    data: { id: 'M9', from: '62811@c.us', to: 'me', chatId: '62811@c.us',
            body: '=HYPERLINK("http://evil","x")', type: 'text', fromMe: false, isGroup: false,
            contact: { pushName: '=1+1' } },
  });
  assert.equal(row[10], `'=HYPERLINK("http://evil","x")`); // body neutralized
  assert.equal(row[7], `'=1+1`);                            // senderName neutralized
  assert.equal(row[5], '62811@c.us');                       // benign value untouched
});

test('free-text quotes a formula-like leading +/- but preserves a phone/number; id fields stay fully guarded', () => {
  const row = buildRow({
    event: 'message:received', sessionId: 's1', timestamp: T, source: 'Engine',
    data: { id: 'M9', from: '+62811@c.us', to: 'me', chatId: '62811@c.us',
            body: '+62812 call me', type: 'text', fromMe: false, isGroup: false,
            contact: { pushName: '-IMPORTXML("http://evil")' } },
  });
  assert.equal(row[10], '+62812 call me');            // body: '+' before a digit = phone number, NOT quoted
  assert.equal(row[7], `'-IMPORTXML("http://evil")`); // senderName: '-' before a letter = formula, quoted
  assert.equal(row[5], `'+62811@c.us`);               // from: id field, '+' STILL quoted (full guard)
  assert.equal(row[6], 'me');                         // benign id untouched
});

test('free-text keeps a negative number but quotes plus-then-space-then-formula', () => {
  const row = buildRow({
    event: 'message:received', sessionId: 's1', timestamp: T, source: 'Engine',
    data: { id: 'M9', from: 'x', to: 'y', chatId: 'c', type: 'text', fromMe: false, isGroup: false,
            body: '-5 degrees today', contact: { pushName: '+ IMPORTXML("http://evil")' } },
  });
  assert.equal(row[10], '-5 degrees today');            // '-5' is a number → NOT quoted
  assert.equal(row[7], `'+ IMPORTXML("http://evil")`);  // '+ ' (space after) is not a number → quoted
});

test('caps an oversized free-text cell to the Google Sheets 50000-char limit', () => {
  const big = 'a'.repeat(60000);
  const row = buildRow({
    event: 'message:received', sessionId: 's1', timestamp: T, source: 'Engine',
    data: { id: 'M9', from: 'x', to: 'y', chatId: 'c', body: big, type: 'text', fromMe: false, isGroup: false },
  });
  // A single over-limit cell would 400 the whole append batch and stall all logging; cap it so it can't.
  assert.equal(row[10].length, 50000);
});
