#!/usr/bin/env node
// Fetch every `download` URL in plugins.json and verify the bytes against the `#sha256=` pin.
//
// `catalog:check` only proves plugins.json can be REGENERATED from the working tree. It says nothing
// about whether the releases it points at exist. Those are two different failure modes and both have
// shipped:
//
//   1. Versions are bumped, the catalog is regenerated and merged, and the tags are never pushed.
//      Every entry then names a release that does not exist and the host, which defaults
//      PLUGIN_CATALOG_URL to this file on `main`, fails every install with a bare 404 (the download
//      is fetched before the pin is consulted, so the operator gets no hint about the cause).
//   2. A plugin's source is edited without a version bump. The catalog regenerates the pin from the
//      new bytes while the URL still names the old tag, and installs fail on a sha256 mismatch.
//
// Neither is visible to any other check in this repo, and both are invisible until a user tries to
// install. No token: these are public release assets.
//
// Wired to run nightly and on demand (.github/workflows/catalog-live.yml), NOT on push. A release
// lands as merge-then-tag, so a push-triggered run is red by construction in the window between the
// two, and a gate that is routinely red for a benign reason gets ignored. Run it by hand right after
// pushing a set of release tags, which is exactly when the answer is wanted.
//
// Usage:  node scripts/catalog-live-check.mjs [path/to/plugins.json]
// Exit 0 when every entry resolves and matches; exit 1 listing each entry that does not.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const CATALOG = process.argv[2] ?? new URL('../plugins.json', import.meta.url).pathname;
const TIMEOUT_MS = 30_000;

/** Split "https://host/x.zip#sha256=abc..." into its parts. The pin is what the host verifies. */
function parseDownload(raw) {
  const hash = raw.indexOf('#');
  if (hash < 0) return { url: raw, pin: null };
  const url = raw.slice(0, hash);
  const m = /^#sha256=([0-9a-f]{64})$/.exec(raw.slice(hash));
  return { url, pin: m ? m[1] : null };
}

async function checkEntry(entry) {
  const label = `${entry.id} v${entry.version}`;
  if (typeof entry.download !== 'string' || !entry.download) {
    return `${label}: no download URL`;
  }
  const { url, pin } = parseDownload(entry.download);
  if (!pin) return `${label}: download URL carries no valid #sha256= pin`;

  let res;
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    return `${label}: ${url} did not respond (${e.name === 'TimeoutError' ? `no answer in ${TIMEOUT_MS} ms` : e.message})`;
  }
  if (!res.ok) {
    const why = res.status === 404 ? ' (the release or its asset does not exist; was the tag pushed?)' : '';
    return `${label}: ${url} answered ${res.status}${why}`;
  }

  const actual = createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex');
  if (actual !== pin) {
    return `${label}: sha256 mismatch\n    pinned  ${pin}\n    served  ${actual}\n    the published asset is not the artifact this catalog was generated from`;
  }
  return null;
}

const catalog = JSON.parse(await readFile(CATALOG, 'utf8'));
const entries = Array.isArray(catalog) ? catalog : catalog.plugins;
if (!Array.isArray(entries) || entries.length === 0) {
  console.error(`No plugin entries found in ${CATALOG}`);
  process.exit(1);
}

const failures = (await Promise.all(entries.map(checkEntry))).filter(Boolean);

if (failures.length > 0) {
  console.error(`Catalog is not installable (${failures.length} of ${entries.length} entries):\n`);
  for (const f of failures) console.error(`  ${f}`);
  console.error('\nEvery entry above fails a real install from the dashboard.');
  process.exit(1);
}

console.log(`Catalog is live and installable (${entries.length} plugin(s) fetched, every sha256 pin matches).`);
