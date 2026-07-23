// Round-trip test for the in-house STORE zip writer: parses the produced archive back
// (central directory + local headers) and asserts entry names, CRC-32, and payload bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, zipStore } from './zip-store.mjs';

function parseZip(buf) {
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'starts with a local file header');
  // EOCD is the last 22 bytes (we never write a comment).
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50, 'ends with EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0, p = cdOffset; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central directory entry signature');
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    // Read the payload via the local header.
    assert.equal(buf.readUInt32LE(localOffset), 0x04034b50, 'local header signature');
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + size);
    entries.push({ name, crc, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

test('crc32 matches the well-known check value', () => {
  // The canonical CRC-32 check value: crc32("123456789") = 0xCBF43926.
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('zipStore round-trips entry names and bytes', () => {
  const input = [
    { name: 'manifest.json', data: Buffer.from('{"id":"x"}', 'utf8') },
    { name: 'dist/index.js', data: Buffer.from('console.log(1);\n', 'utf8') },
    { name: 'config/index.html', data: Buffer.from('<html>\u00e9</html>', 'utf8') },
  ];
  const parsed = parseZip(zipStore(input));
  assert.deepEqual(parsed.map((e) => e.name), input.map((e) => e.name));
  for (let i = 0; i < input.length; i++) {
    assert.deepEqual(parsed[i].data, input[i].data, `${input[i].name} payload`);
    assert.equal(parsed[i].crc, crc32(input[i].data), `${input[i].name} crc`);
  }
});

test('zipStore handles binary payloads with NUL bytes', () => {
  const bin = Buffer.from([0, 1, 2, 255, 0, 254]);
  const [entry] = parseZip(zipStore([{ name: 'bin.dat', data: bin }]));
  assert.deepEqual(entry.data, bin);
});
