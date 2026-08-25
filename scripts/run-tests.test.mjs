// Guards the auto-discovery in scripts/run-tests.mjs: every plugin directory (a top-level dir with
// a manifest.json) must contain at least one test file, so a new plugin can never silently slip
// through untested the way the old hardcoded glob in package.json allowed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectTests, discoverPluginDirs } from './run-tests.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function hasTestFile(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    if (/\.test\.(ts|mjs)$/.test(entry.name)) return true;
  }
  return false;
}

test('every discovered plugin directory contains at least one test file', () => {
  const dirs = discoverPluginDirs(ROOT);
  assert.ok(dirs.length > 0, 'expected to discover at least one plugin');
  for (const id of dirs) {
    assert.ok(hasTestFile(join(ROOT, id)), `${id}: plugin directory has no *.test.ts — add tests`);
  }
});

// Discovery used to be "plugin directories plus scripts/", so a test file anywhere else sat on disk
// and never ran, which is indistinguishable from a test that passes. The walk now starts at the root.
test('a test file outside a plugin directory is discovered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openwa-discovery-'));
  try {
    mkdirSync(join(dir, 'types'), { recursive: true });
    mkdirSync(join(dir, 'a-plugin'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(dir, 'a-plugin', 'dist'), { recursive: true });
    writeFileSync(join(dir, 'root-level.test.mjs'), '');
    writeFileSync(join(dir, 'types', 'contract.test.ts'), '');
    writeFileSync(join(dir, 'a-plugin', 'index.test.ts'), '');
    writeFileSync(join(dir, 'node_modules', 'pkg', 'vendor.test.mjs'), '');
    writeFileSync(join(dir, 'a-plugin', 'dist', 'bundled.test.mjs'), '');

    const found = collectTests(dir).map((p) => p.slice(dir.length + 1)).sort();
    assert.deepEqual(found, ['a-plugin/index.test.ts', 'root-level.test.mjs', 'types/contract.test.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
