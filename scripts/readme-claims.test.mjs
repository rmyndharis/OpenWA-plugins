// README claims that can silently contradict the manifest or the gateway.
//
// Each of these drifted at least once. A README is the only place most users read a version floor or
// a curl command, and nothing else in the toolchain looks at either — the catalog gate compares
// manifests to plugins.json and never opens a README.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const pluginDirs = readdirSync(root, { withFileTypes: true })
  .filter(d => d.isDirectory() && existsSync(join(root, d.name, 'manifest.json')))
  .map(d => d.name);

const readmes = [join(root, 'README.md'), ...pluginDirs.map(d => join(root, d, 'README.md'))].filter(existsSync);

test('every gateway URL in a README carries the /api prefix', () => {
  // The gateway mounts a global `/api` prefix, so `<host>/plugins/...` answers 404. 27 copy-pasteable
  // curl commands addressed it without the prefix.
  const offenders = [];
  for (const file of readmes) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/https?:\/\/[^\s'"`)]+/g)) {
      const url = m[0];
      if (!/your-openwa-host|localhost:2785/.test(url)) continue;
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      if (path && path !== '/' && !path.startsWith('/api/')) offenders.push(`${file.replace(root + '/', '')}: ${url}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("each plugin README's stated OpenWA floor matches its manifest", () => {
  // after-hours carried a hand-maintained badge and two prose mentions saying 0.6.2 while the manifest
  // declared 0.7.0 — three numbers, one of them the one the catalog actually publishes.
  const mismatches = [];
  for (const dir of pluginDirs) {
    const readme = join(root, dir, 'README.md');
    if (!existsSync(readme)) continue;
    const declared = JSON.parse(readFileSync(join(root, dir, 'manifest.json'), 'utf8')).minOpenWAVersion;
    if (!declared) continue;
    const text = readFileSync(readme, 'utf8');
    const stated = new Set();
    for (const m of text.matchAll(/badge\/OpenWA-%E2%89%A5%20([0-9.]+)-/g)) stated.add(m[1]);
    for (const m of text.matchAll(/OpenWA\s*\*\*≥\s*([0-9.]+)\*\*/g)) stated.add(m[1]);
    for (const v of stated) if (v !== declared) mismatches.push(`${dir}: README says ${v}, manifest says ${declared}`);
  }
  assert.deepEqual(mismatches, []);
});
