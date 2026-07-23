// Sum GitHub Release asset downloads per plugin and emit shields.io "endpoint" JSON files, one per
// plugin, so each plugin README can show a cumulative downloads badge (all versions of that plugin).
// Releases are tagged `<plugin-id>-vX.Y.Z` with a `<plugin-id>.zip` asset (see .github/workflows/release.yml).
//
// Usage: node scripts/download-badges.mjs [out-dir]   (default out-dir: .badges-out)
// Env:   GITHUB_TOKEN (optional, raises rate limit), GITHUB_REPOSITORY (owner/repo override)
import { readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(process.argv[2] ?? join(ROOT, '.badges-out'));
const REPO = process.env.GITHUB_REPOSITORY ?? 'rmyndharis/OpenWA-plugins';
const SKIP = new Set(['node_modules', 'scripts', 'docs', '.git', '.github', '.superpowers', 'dist', '.remember']);

const pluginIds = readdirSync(ROOT)
  .filter((name) => !SKIP.has(name) && !name.startsWith('.'))
  .filter((name) => statSync(join(ROOT, name)).isDirectory())
  .filter((name) => existsSync(join(ROOT, name, 'manifest.json')))
  .sort();

const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'openwa-plugins-download-badges' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

async function fetchAllReleases() {
  const releases = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`, { headers });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    const batch = await res.json();
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
}

// 1234 -> "1.2k", 1234567 -> "1.2M"
function formatCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

const totals = Object.fromEntries(pluginIds.map((id) => [id, 0]));
const TAG_RE = /^(.+)-v\d+\.\d+\.\d+$/;

for (const release of await fetchAllReleases()) {
  const id = release.tag_name?.match(TAG_RE)?.[1];
  if (!id || !(id in totals)) continue;
  for (const asset of release.assets ?? []) {
    if (asset.name === `${id}.zip`) totals[id] += asset.download_count;
  }
}

mkdirSync(OUT, { recursive: true });
for (const [id, count] of Object.entries(totals)) {
  const badge = { schemaVersion: 1, label: 'downloads', message: formatCount(count), color: 'blue' };
  writeFileSync(join(OUT, `${id}.json`), JSON.stringify(badge) + '\n');
  console.log(`${id}: ${count}`);
}
