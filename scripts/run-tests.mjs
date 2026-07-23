// Test runner with auto-discovery: finds every plugin directory (any top-level dir with a
// manifest.json — the same rule as scripts/catalog.mjs) plus scripts/, collects their
// *.test.ts / *.test.mjs files recursively, and runs them with `node --import tsx --test`.
// Extra CLI args are forwarded to the test runner (e.g. `node scripts/run-tests.mjs
// --experimental-test-coverage`). Adding a plugin no longer requires editing package.json.
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', 'scripts', 'docs', '.git', '.github', '.superpowers', 'dist', '.remember']);

export function discoverPluginDirs(root = ROOT) {
  return readdirSync(root)
    .filter((name) => !SKIP.has(name) && !name.startsWith('.'))
    .filter((name) => statSync(join(root, name)).isDirectory())
    .filter((name) => existsSync(join(root, name, 'manifest.json')))
    .sort();
}

function collectTests(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collectTests(path, out);
    else if (/\.test\.(ts|mjs)$/.test(entry.name)) out.push(path);
  }
  return out;
}

// Only run when invoked directly (the discovery helpers are imported by scripts/run-tests.test.mjs).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dirs = [...discoverPluginDirs(), 'scripts'];
  const files = dirs.flatMap((d) => collectTests(join(ROOT, d))).sort();
  if (files.length === 0) {
    console.error('No test files found.');
    process.exit(1);
  }
  console.log(`Running ${files.length} test file(s) from ${dirs.length} director(ies): ${dirs.join(', ')}`);

  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', ...process.argv.slice(2), ...files.map((f) => relative(ROOT, f))],
    { cwd: ROOT, stdio: 'inherit' },
  );
  process.exit(result.status ?? 1);
}
