// Generate the plugin catalog (plugins.json), the root README catalog table, and each plugin README's
// "Details" block — all from manifest.json + CHANGELOG.md (the single sources of truth). Run with
// `--check` to fail (exit 1) when committed files are stale or a manifest/changelog version drifts.
//
// Usage: node scripts/catalog.mjs [--check]
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const SKIP = new Set(['node_modules', 'scripts', 'docs', '.git', '.github', '.superpowers', 'dist', '.remember']);

const DETAILS_RE = /<!-- BEGIN DETAILS[\s\S]*?<!-- END DETAILS -->/;
const CATALOG_RE = /<!-- BEGIN PLUGIN CATALOG -->[\s\S]*?<!-- END PLUGIN CATALOG -->/;

function discoverPlugins() {
  return readdirSync(ROOT)
    .filter((name) => !SKIP.has(name) && !name.startsWith('.'))
    .filter((name) => statSync(join(ROOT, name)).isDirectory())
    .filter((name) => existsSync(join(ROOT, name, 'manifest.json')))
    .sort();
}

const SUPPORTED_LOCALES = ['en', 'es', 'fr', 'it', 'ar', 'he', 'te', 'zh-CN', 'zh-HK'];

// Every permission the host actually enforces (core `PluginCapabilityPermission`). Nothing else in the
// toolchain looked at these names: the array was passed straight through to plugins.json, which is what
// the in-dashboard marketplace reads, so an invented or misspelled one was published verbatim and only
// discovered when the capability it was meant to unlock silently failed at runtime.
//
// A closed list makes adopting a genuinely new permission a deliberate one-line edit here — which is the
// point. `storage:use` reached seven manifests without anything in this repo ever checking the name.
// The GitHub owners whose Releases this catalogue is allowed to point at. A plugin may credit any
// author; the ARTIFACT must come from a repo this project publishes.
const RELEASE_OWNERS = new Set(['rmyndharis']);

// Both taken verbatim from PLUGIN-STANDARD.md — the shape at its manifest example and the reserved
// list at its "Reserved ids" line. Neither was checked anywhere, so a plugin could take an id the
// standard forbids and the catalogue would publish it.
const ID_SHAPE = /^[a-z0-9][a-z0-9._-]*$/i;
const RESERVED_IDS = new Set(['whatsapp-web.js', 'baileys', 'auto-reply', 'translation']);

const HOST_PERMISSIONS = new Set([
  'messages:send',
  'engine:read',
  'net:fetch',
  'storage:use',
  'webhook:ingress',
  'conversation:send',
  'search:provide',
]);

// Manifest hygiene gates (hard failures) and soft warnings. Keep these aligned with PLUGIN-STANDARD.md.
function validateManifest(id, manifest) {
  // `id` here is the DIRECTORY name, and it is what every path in this repo is built from — the plugin
  // folder, the zip name, the release tag. `manifest.id` is what the host installs under and what the
  // catalogue publishes. If the two disagree, the download URL points at one plugin and the installed
  // plugin calls itself another.
  // PLUGIN-STANDARD states an id shape and a reserved list; nothing checked either, so both could be
  // violated by a plugin that then took a path or a catalogue slot it should not have.
  if (!ID_SHAPE.test(manifest.id ?? '')) {
    throw new Error(`${id}: manifest.id "${manifest.id}" does not match ${ID_SHAPE} (PLUGIN-STANDARD.md)`);
  }
  if (RESERVED_IDS.has(manifest.id)) {
    throw new Error(`${id}: "${manifest.id}" is a reserved id`);
  }
  if (manifest.id !== id) {
    throw new Error(`${id}: manifest.id is "${manifest.id}" — it must match the directory name`);
  }
  // The download URL is derived from `repository`, so a foreign host there would have the catalogue
  // hand users an archive nobody in this repo built or checksummed.
  const owner = /^https:\/\/github\.com\/([\w.-]+)\//.exec(manifest.repository ?? '');
  if (!owner || !RELEASE_OWNERS.has(owner[1])) {
    throw new Error(
      `${id}: repository must be a github.com URL under ${[...RELEASE_OWNERS].join(' or ')} — ` +
        `the catalogue builds its download URLs from it (got ${manifest.repository ?? 'nothing'})`,
    );
  }
  if (manifest.sessionScoped === undefined) {
    throw new Error(`${id}: manifest.json must declare "sessionScoped" explicitly (true or false)`);
  }
  if (manifest.status === 'stable' && !manifest.testedOpenWAVersion) {
    throw new Error(`${id}: status "stable" requires testedOpenWAVersion (the newest host actually smoke-tested)`);
  }
  for (const p of manifest.permissions ?? []) {
    if (!HOST_PERMISSIONS.has(p)) {
      throw new Error(
        `${id}: unknown permission "${p}" — the host enforces only ${[...HOST_PERMISSIONS].join(', ')}. ` +
          `If OpenWA has added one, add it to HOST_PERMISSIONS in this file in the same change.`,
      );
    }
  }
  // An ingress route is a public endpoint once the host provisions it, and the host refuses to load a
  // plugin that declares one without the permission — but only at install, on the operator's gateway,
  // after the release is published. Catch it where the catalogue is built instead.
  if (Array.isArray(manifest.ingress) && manifest.ingress.length && !(manifest.permissions ?? []).includes('webhook:ingress')) {
    throw new Error(
      `${id}: declares ${manifest.ingress.length} ingress route(s) but not the "webhook:ingress" permission — ` +
        `the host refuses to load such a plugin`,
    );
  }
  // The host reads sdkVersion as a STRING: its ingress validation runs sdkVersion.split('.'), so a JSON
  // number throws at load and the whole plugin comes up ERROR. JSON makes string-vs-number invisible and
  // the host's validator only runs on the gateway, after the release is published — catch it here.
  if (
    manifest.sdkVersion !== undefined &&
    (typeof manifest.sdkVersion !== 'string' || !/^\d+(\.\d+)?$/.test(manifest.sdkVersion))
  ) {
    throw new Error(
      `${id}: manifest.json "sdkVersion" must be a string like "1" or "1.2" (got ${JSON.stringify(manifest.sdkVersion)}) — ` +
        `the host's load-time validation treats it as a string; a number throws and fails the whole plugin`,
    );
  }
  if (!manifest.i18n || Object.keys(manifest.i18n).length === 0) {
    console.warn(`⚠ ${id}: no i18n block — dashboard shows English only`);
  } else {
    const missing = SUPPORTED_LOCALES.filter((l) => l !== 'en' && !manifest.i18n[l]);
    if (missing.length) console.warn(`⚠ ${id}: i18n missing locale(s): ${missing.join(', ')}`);
  }
}

// Top released CHANGELOG heading: `## [x.y.z] — YYYY-MM-DD` (skips `## [Unreleased]`).
function readChangelogTop(id) {
  const path = join(ROOT, id, 'CHANGELOG.md');
  if (!existsSync(path)) throw new Error(`${id}: missing CHANGELOG.md`);
  const m = readFileSync(path, 'utf8').match(/^##\s*\[(\d+\.\d+\.\d+)\]\s*[—–-]\s*(\d{4}-\d{2}-\d{2})/m);
  if (!m) throw new Error(`${id}: CHANGELOG.md has no released "## [x.y.z] — YYYY-MM-DD" heading`);
  return { version: m[1], date: m[2] };
}

// The digest pinned to each catalog download URL. OpenWA ≥ 0.20.0 refuses an install from an unpinned
// URL in production (fail-closed integrity for third-party code), so the catalog itself must carry the
// `#sha256=` fragment: the dashboard passes this URL verbatim to install-url. The digest is computed
// from a fresh package.mjs build (byte-deterministic: verified that a local build equals the GitHub
// Release asset for the same tree), and the release workflow re-checks the published artifact against
// this pin before creating the Release, so a diverging build fails loudly instead of shipping a
// catalog whose pin can never verify.
function packagedSha256(id) {
  execFileSync(process.execPath, ['package.mjs', id], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
  return createHash('sha256').update(readFileSync(join(ROOT, `${id}.zip`))).digest('hex');
}

function buildEntry(id) {
  const manifest = JSON.parse(readFileSync(join(ROOT, id, 'manifest.json'), 'utf8'));
  const changelog = readChangelogTop(id);
  if (manifest.version !== changelog.version) {
    throw new Error(
      `${id}: version drift — manifest.json is ${manifest.version} but the top CHANGELOG entry is ${changelog.version}`,
    );
  }
  validateManifest(id, manifest);
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    type: manifest.type,
    status: manifest.status ?? 'development',
    description: manifest.description ?? '',
    author: manifest.author ?? '',
    license: manifest.license ?? '',
    keywords: manifest.keywords ?? [],
    minOpenWAVersion: manifest.minOpenWAVersion ?? null,
    testedOpenWAVersion: manifest.testedOpenWAVersion ?? null,
    releasedAt: changelog.date,
    repoPath: manifest.id,
    repoUrl: manifest.repository ?? null,
    homepage: manifest.homepage ?? null,
    download: manifest.repository
      ? `${manifest.repository}/releases/download/${manifest.id}-v${manifest.version}/${manifest.id}.zip#sha256=${packagedSha256(id)}`
      : null,
    // What the plugin DECLARES it binds. Published so a reader can compare a plugin's stated purpose
    // against the host capabilities it asks for — a mismatch there is a real signal.
    //
    // NOT a security boundary, and must never be presented as one. docs/30-plugin-sandboxing.md is
    // explicit: a worker_thread is not an OS-level sandbox, and a plugin keeps `require('fs')`,
    // `process` and raw sockets whatever it declares here. `net.allow` gates the host-mediated
    // `ctx.net.fetch`, not the plugin's own outbound traffic. These fields describe intent and the
    // mediated surface; they do not constrain a malicious plugin.
    permissions: manifest.permissions ?? [],
    net: manifest.net ?? null,
    // Route shapes only — an ingress route is a @Public() endpoint once provisioned, so which routes a
    // plugin opens is worth seeing before installing it.
    ingress: Array.isArray(manifest.ingress)
      ? manifest.ingress.map((r) => ({
          route: r.route,
          signature: r.signature?.scheme ?? null,
        }))
      : null,
    // No default: validateManifest has already refused a manifest that omits this, and the host reads
    // it as global only when it is explicitly false — so a default here could only disagree with both.
    sessionScoped: manifest.sessionScoped,
    ...(manifest.i18n ? { i18n: manifest.i18n } : {}),
  };
}

const authorName = (author) => author.replace(/\s*<[^>]*>\s*/, '').trim();

function detailsBlock(e) {
  return [
    '<!-- BEGIN DETAILS (generated by scripts/catalog.mjs — do not edit by hand) -->',
    '| Field | Value |',
    '| ----- | ----- |',
    `| **Identifier** | \`${e.id}\` |`,
    `| **Version** | ${e.version} |`,
    `| **Released** | ${e.releasedAt} |`,
    `| **Status** | ${e.status} |`,
    `| **Author** | ${authorName(e.author)} |`,
    `| **License** | ${e.license} |`,
    `| **Type** | \`${e.type}\` |`,
    `| **Requires OpenWA** | ≥ ${e.minOpenWAVersion} ${e.testedOpenWAVersion ? `(tested ${e.testedOpenWAVersion})` : '(not yet smoke-tested)'} |`,
    `| **Keywords** | ${e.keywords.join(', ')} |`,
    `| **Repository** | [OpenWA-plugins/${e.id}](${e.homepage}) |`,
    '<!-- END DETAILS -->',
  ].join('\n');
}

function catalogTable(entries) {
  const rows = entries.map((e) => `| [\`${e.id}\`](./${e.repoPath}) | ${e.description} | ${e.version} | ${e.status} |`);
  return [
    '<!-- BEGIN PLUGIN CATALOG -->',
    '| Plugin | Description | Version | Status |',
    '| ------ | ----------- | ------- | ------ |',
    ...rows,
    '<!-- END PLUGIN CATALOG -->',
  ].join('\n');
}

// Returns the would-be content for a file with one marker region replaced; throws if the marker is absent.
function replaceRegion(path, regex, replacement, label) {
  const current = readFileSync(path, 'utf8');
  if (!regex.test(current)) throw new Error(`${path}: missing ${label} markers`);
  return current.replace(regex, replacement);
}

const entries = discoverPlugins().map(buildEntry);

const targets = [
  { path: join(ROOT, 'plugins.json'), next: JSON.stringify(entries, null, 2) + '\n' },
  { path: join(ROOT, 'README.md'), next: replaceRegion(join(ROOT, 'README.md'), CATALOG_RE, catalogTable(entries), 'PLUGIN CATALOG') },
  ...entries.map((e) => {
    const path = join(ROOT, e.id, 'README.md');
    return { path, next: replaceRegion(path, DETAILS_RE, detailsBlock(e), 'DETAILS') };
  }),
];

const stale = targets.filter((t) => !existsSync(t.path) || readFileSync(t.path, 'utf8') !== t.next);

if (CHECK) {
  if (stale.length) {
    console.error('Catalog is out of date. Run `npm run catalog` and commit:');
    for (const t of stale) console.error(`  - ${t.path.replace(ROOT + '/', '')}`);
    process.exit(1);
  }
  console.log(`Catalog up to date (${entries.length} plugin(s)).`);
} else {
  for (const t of stale) writeFileSync(t.path, t.next);
  console.log(`Catalog written (${entries.length} plugin(s)); updated ${stale.length} file(s).`);
}
