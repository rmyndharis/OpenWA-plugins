import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMultipartBody } from './multipart.ts';

test('assembles a text field followed by a binary file part, bytes intact', () => {
  const boundary = 'X-BOUND-123';
  // Includes 0x00, 0x80 and 0xff — the bytes a UTF-8 string body would corrupt.
  const audio = Uint8Array.from([0x00, 0x80, 0xff, 0x4f, 0x67, 0x67]);

  const body = buildMultipartBody(
    boundary,
    [{ name: 'model', value: 'small' }],
    [{ name: 'file', filename: 'voice.ogg', contentType: 'audio/ogg', data: audio }],
  );

  const expected = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nsmall\r\n`),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.ogg"\r\n` +
        `Content-Type: audio/ogg\r\n\r\n`,
    ),
    Buffer.from(audio),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  assert.deepEqual(body, expected);
});

test('preserves high bytes (no UTF-8 expansion) — the load-bearing property', () => {
  const audio = Uint8Array.from([0x80, 0xff, 0xfe]); // each would become 2 bytes if UTF-8 encoded
  const body = buildMultipartBody(
    'b',
    [],
    [{ name: 'file', filename: 'v.ogg', contentType: 'audio/ogg', data: audio }],
  );
  // The three raw bytes appear contiguously and unexpanded.
  assert.ok(body.includes(Buffer.from(audio)));
});

test('a file-only body (no fields) is well-formed', () => {
  const body = buildMultipartBody(
    'b',
    [],
    [{ name: 'file', filename: 'v.ogg', contentType: 'audio/ogg', data: Uint8Array.from([1, 2]) }],
  );
  const expected = Buffer.concat([
    Buffer.from('--b\r\nContent-Disposition: form-data; name="file"; filename="v.ogg"\r\nContent-Type: audio/ogg\r\n\r\n'),
    Buffer.from(Uint8Array.from([1, 2])),
    Buffer.from('\r\n--b--\r\n'),
  ]);
  assert.deepEqual(body, expected);
});
