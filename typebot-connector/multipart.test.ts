import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMultipartBody } from './multipart.ts';

test('assembles fields + a binary file, preserving raw bytes (no UTF-8 mangling)', () => {
  const bytes = Uint8Array.from([0x00, 0x80, 0xff]);
  const body = buildMultipartBody(
    'BOUNDARY',
    [{ name: 'content', value: 'hi' }],
    [{ name: 'attachments[]', filename: 'f.bin', contentType: 'application/octet-stream', data: bytes }],
  );
  const asText = body.toString('latin1');
  assert.ok(asText.includes('Content-Disposition: form-data; name="content"'));
  assert.ok(asText.includes('filename="f.bin"'));
  assert.ok(asText.includes('Content-Type: application/octet-stream'));
  assert.ok(asText.includes('--BOUNDARY--'));
  assert.ok(body.includes(Buffer.from(bytes)));
});

test('strips CR/LF (and a quote) from an attacker-controlled filename/contentType', () => {
  const body = buildMultipartBody(
    'B',
    [],
    [{
      name: 'attachments[]',
      filename: 'a"\r\nContent-Disposition: form-data; name="evil"\r\n\r\ninjected',
      contentType: 'image/png\r\nX-Injected: 1',
      data: Uint8Array.from([1]),
    }],
  ).toString('latin1');
  assert.ok(!body.includes('\r\nContent-Disposition: form-data; name="evil"'), 'no injected part header');
  assert.ok(!body.includes('name="evil"'), 'the injected quoted name never appears (quote stripped)');
  assert.ok(body.includes('filename="aContent-Disposition: form-data; name=evilinjected"'), 'filename flattened onto one line');
  assert.ok(body.includes('Content-Type: image/pngX-Injected: 1\r\n\r\n'), 'contentType flattened; only the framing CRLF remains');
});
