// Guards the auto-discovery in scripts/run-tests.mjs: every plugin directory (a top-level dir with
// a manifest.json) must contain at least one test file, so a new plugin can never silently slip
// through untested the way the old hardcoded glob in package.json allowed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverPluginDirs } from './run-tests.mjs';

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
