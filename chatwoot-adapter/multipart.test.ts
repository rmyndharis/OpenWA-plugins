import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMultipartBody } from './multipart.ts';

test('assembles fields + a binary file, preserving raw bytes (no UTF-8 mangling)', () => {
  const bytes = Uint8Array.from([0x00, 0x80, 0xff]); // non-UTF-8 bytes that a string body would corrupt
  const body = buildMultipartBody(
    'BOUNDARY',
    [{ name: 'content', value: 'hi' }],
    [{ name: 'attachments[]', filename: 'f.bin', contentType: 'application/octet-stream', data: bytes }],
  );
  const asText = body.toString('latin1');
  assert.ok(asText.includes('Content-Disposition: form-data; name="content"'));
  assert.ok(asText.includes('filename="f.bin"'));
  assert.ok(asText.includes('Content-Type: application/octet-stream'));
  assert.ok(asText.includes('--BOUNDARY--')); // closing delimiter
  assert.ok(body.includes(Buffer.from(bytes))); // the raw bytes survive intact
});
