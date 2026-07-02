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

test('strips CR/LF (and a quote) from an attacker-controlled filename/contentType', () => {
  // A WhatsApp sender controls the media filename + mimetype; a raw CRLF would break out of the part
  // headers and inject extra multipart parts into the upload to the Chatwoot API.
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
  // The security property: no CR/LF from the untrusted values reaches the headers, so nothing becomes a
  // NEW multipart part or header — the injected text is flattened harmlessly onto its own header line.
  assert.ok(!body.includes('\r\nContent-Disposition: form-data; name="evil"'), 'no injected part header');
  assert.ok(!body.includes('name="evil"'), 'the injected quoted name never appears (quote stripped)');
  assert.ok(body.includes('filename="aContent-Disposition: form-data; name=evilinjected"'), 'filename flattened onto one line');
  assert.ok(body.includes('Content-Type: image/pngX-Injected: 1\r\n\r\n'), 'contentType flattened; only the framing CRLF remains');
});
