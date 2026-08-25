import { build } from 'esbuild';
import { readFileSync, existsSync } from 'node:fs';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { zipStore } from './scripts/zip-store.mjs';
import { configUiMember, collectMembers } from './scripts/entry-path.mjs';

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

// Warn on unsupported i18n locale codes
const SUPPORTED_LOCALES = ['en', 'es', 'fr', 'it', 'ar', 'he', 'te', 'zh-CN', 'zh-HK'];
if (manifest.i18n && typeof manifest.i18n === 'object') {
  for (const code of Object.keys(manifest.i18n)) {
    if (!SUPPORTED_LOCALES.includes(code)) console.warn(`⚠ ${plugin}: i18n locale "${code}" is not a dashboard-supported code`);
  }
}

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
const entries = ['manifest.json', 'dist/index.js', 'dist/package.json'];
// A configUi plugin ships a static editor bundle the host serves in a sandboxed iframe — include it.
if (manifest.configUi?.entry) {
  const ui = manifest.configUi.entry;
  let member;
  try {
    member = configUiMember(ui);
  } catch (e) {
    fail(e.message);
  }
  if (!existsSync(join(dir, ui))) fail(`configUi.entry "${ui}" not found`);
  entries.push(member);
}

let result;
try {
  result = collectMembers(dir, entries);
} catch (e) {
  fail(e.message);
}

// The archive members are chosen here, not read from the manifest, so a `main` pointing anywhere else
// produces a package every gate in this repo accepts and the host refuses: it rejects an archive whose
// `main` is not among its entries, at install, after the release is already tagged and published.
const mainInZip = join('.', manifest.main).split('\\').join('/');
if (!result.some((f) => f.name === mainInZip)) {
  fail(`manifest main "${manifest.main}" is not in the package (members: ${result.map((f) => f.name).join(', ')})`);
}

// ── Report size + sha256 (release artifacts — surfaced here and in the GitHub Release) ──
// Size is checked before the write, not after: an oversized archive that fails the limit used to be
// left behind on disk anyway.
// The host caps a package at 200 members as well as 5 MB, and refuses the whole install on either.
// A configUi entry is expanded recursively, so a static editor bundle reaches the file count long
// before the byte count, and that refusal would land at install, after the release is published.
if (result.length > 200) fail(`package has ${result.length} files, over the 200-file install limit`);
const zip = zipStore(result);
const kb = (zip.length / 1024).toFixed(1);
if (zip.length > 5 * 1024 * 1024) fail(`package is ${kb} KB, over the 5 MB install limit`);
await writeFile(zipPath, zip);

const sha256 = createHash('sha256').update(zip).digest('hex');
console.log(`✓ Packaged ${plugin} v${manifest.version} → ${zipName}  (${kb} KB)`);
console.log(`  sha256: ${sha256}`);
