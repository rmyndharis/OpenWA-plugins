// OpenWA 0.28.0+ rejects ctx.storage.set keys above 184 UTF-8 bytes (`key-<b64>.json` <= 255 bytes).
// Keep every copy identical; scripts/shared-copies.test.mjs fails the build when copies drift.
export function boundStorageKey(key: string, sep: ':' | '_' = ':'): string {
  if (Buffer.byteLength(key, 'utf8') <= 184) return key;
  let h1 = 0x811c9dc5;
  let h2 = 0xdeadbeef;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
  }
  const suffix = `${sep}${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
  let prefix = key.slice(0, 184 - suffix.length).replace(/[\ud800-\udbff]$/, '');
  while (Buffer.byteLength(prefix, 'utf8') > 184 - suffix.length) {
    prefix = prefix.slice(0, -1).replace(/[\ud800-\udbff]$/, '');
  }
  return `${prefix}${suffix}`;
}
