// Test runner with auto-discovery: walks the repository for *.test.ts / *.test.mjs files and runs
// them with `node --import tsx --test`. Extra CLI args are forwarded to the test runner (e.g.
// `node scripts/run-tests.mjs --experimental-test-coverage`). Adding a plugin, or a test file that
// lives outside a plugin directory, requires no edit here or in package.json.
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

// Directories the walk never descends into: installed packages, build output, and the two gitignored
// notes trees. A separate set from SKIP, because SKIP excludes 'scripts' and the test walk must
// include it.
const WALK_SKIP = new Set(['node_modules', 'dist', 'docs', '_docs']);

// Walked from the repository root rather than from a computed list of directories. Discovery used to
// be plugin dirs plus scripts/, so a test file anywhere else (a package.test.mjs at the root next to
// package.mjs, or one under types/) would sit on disk and never run, which reads exactly like a test
// that passes.
export function collectTests(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (WALK_SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collectTests(path, out);
    else if (/\.test\.(ts|mjs)$/.test(entry.name)) out.push(path);
  }
  return out;
}

// Only run when invoked directly (the discovery helpers are imported by scripts/run-tests.test.mjs).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = collectTests(ROOT).sort();
  if (files.length === 0) {
    console.error('No test files found.');
    process.exit(1);
  }
  console.log(`Running ${files.length} test file(s) discovered under the repository root`);

  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', ...process.argv.slice(2), ...files.map((f) => relative(ROOT, f))],
    { cwd: ROOT, stdio: 'inherit' },
  );
  process.exit(result.status ?? 1);
}
