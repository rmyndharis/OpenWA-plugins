import { build } from 'esbuild';
import { readFileSync, existsSync } from 'node:fs';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const plugin = process.argv[2];
if (!plugin) {
  console.error('Usage: node package.mjs <plugin-dir>');
  process.exit(1);
}

const root = process.cwd();
const dir = join(root, plugin);

const fail = (msg) => {
  console.error(`✗ ${plugin}: ${msg}`);
  process.exit(1);
};

// ── Validate manifest ──────────────────────────────────────────────────────
if (!existsSync(join(dir, 'manifest.json'))) fail('no manifest.json');
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));

const missing = ['id', 'name', 'version', 'type', 'main'].filter((f) => !manifest[f]);
if (missing.length) fail(`manifest.json missing required field(s): ${missing.join(', ')}`);
if (manifest.type !== 'extension') fail(`type must be "extension" to be installable (got "${manifest.type}")`);

// version must match the top released CHANGELOG heading (single source of release truth)
if (!existsSync(join(dir, 'CHANGELOG.md'))) fail('missing CHANGELOG.md');
const top = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8').match(/^##\s*\[(\d+\.\d+\.\d+)\]\s*[—–-]\s*\d{4}-\d{2}-\d{2}/m);
if (!top) fail('CHANGELOG.md has no released "## [x.y.z] — YYYY-MM-DD" heading');
if (top[1] !== manifest.version) fail(`version drift: manifest is ${manifest.version} but CHANGELOG top is ${top[1]}`);

// ── Build ───────────────────────────────────────────────────────────────────
await mkdir(join(dir, 'dist'), { recursive: true });
// A package.json in dist/ pins CommonJS so Node loads the CJS bundle even when the repo root is ESM.
await writeFile(join(dir, 'dist', 'package.json'), JSON.stringify({ type: 'commonjs' }));
await build({
  entryPoints: [join(dir, 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: join(dir, 'dist', 'index.js'),
  // Bake the manifest version into the bundle (single source of truth = manifest.json) so the plugin
  // can report its own version at runtime — the sandbox does not pass `manifest` into ctx.
  define: { __PLUGIN_VERSION__: JSON.stringify(manifest.version) },
});

// ── Package ───────────────────────────────────────────────────────────────────
const zipName = `${plugin}.zip`;
const zipPath = join(root, zipName);
await rm(zipPath, { force: true });
const result = spawnSync('zip', ['-r', zipPath, 'manifest.json', 'dist/index.js', 'dist/package.json'], {
  cwd: dir,
  stdio: 'inherit',
});
if (result.status !== 0) fail('zip failed (is the `zip` CLI installed?)');

// ── Report size + sha256 (release artifacts — surfaced here and in the GitHub Release) ──
const buf = readFileSync(zipPath);
const sha256 = createHash('sha256').update(buf).digest('hex');
const kb = (buf.length / 1024).toFixed(1);
if (buf.length > 5 * 1024 * 1024) fail(`package is ${kb} KB, over the 5 MB install limit`);
console.log(`✓ Packaged ${plugin} v${manifest.version} → ${zipName}  (${kb} KB)`);
console.log(`  sha256: ${sha256}`);
