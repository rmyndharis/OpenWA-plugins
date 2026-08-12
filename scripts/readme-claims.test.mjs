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

// The five permissions the host enforces at the capability boundary, plus `storage:use` — the sixth,
// added when OpenWA moved ctx.storage behind a declaration gate.
const PERMISSIONS = ['messages:send', 'engine:read', 'net:fetch', 'conversation:send', 'webhook:ingress', 'storage:use'];

// Prose wraps, so a claim and the permissions it names routinely straddle a newline: group-translate
// ends a line on "Declares" and opens the next with the list, and chat-flow splits `messages:send` from
// `storage:use` the same way. Anything matched across a claim has to be matched on flattened text.
const flatten = (text) => text.replace(/\s+/g, ' ');

// Classify every `permission` occurrence. A negation sitting directly in front of one ("…so no
// `engine:read`") is a claim too — the opposite one — so it is checked in the opposite direction rather
// than skipped. The adjacency is deliberately one word: widening it to a phrase would swallow the "no"
// in "makes no outbound network calls and declares only `messages:send`" and invert a true claim.
function mentionsOf(flat) {
  const positive = new Set();
  const negative = new Set();
  for (const p of PERMISSIONS) {
    for (const m of flat.matchAll(new RegExp('(\\S+ )?`' + p + '`', 'g'))) {
      const prev = (m[1] ?? '').toLowerCase().replace(/[^a-z]/g, '');
      (prev === 'no' || prev === 'not' || prev === 'never' ? negative : positive).add(p);
    }
  }
  return { positive, negative };
}

// Only a README that actually enumerates permissions is held to completeness. "declares" alone is far
// too common to use as the signal — across this repo it also introduces the OpenWA version floor, a
// hook that exists but never fires, and an allowlist host — so it counts only when a real permission
// follows close behind. http-action names `conversation:send` while explaining which release introduced
// the capabilities it uses; that is not an enumeration and must not be read as one.
function enumeratesPermissions(flat) {
  for (const m of flat.matchAll(/\b(declares?|declared|permissions:)\b/gi)) {
    const window = flat.slice(m.index, m.index + 120);
    if (PERMISSIONS.some((p) => window.includes('`' + p + '`'))) return true;
  }
  return false;
}

test("a README's permission claims match its manifest", () => {
  // Six plugin READMEs state the declared permissions in prose, and that sentence is the only place an
  // operator reads the list — plugins.json publishes the manifest array, but nobody browses it, and the
  // catalog gate never opens a README's prose. Adding `storage:use` to seven manifests falsified four of
  // those sentences at once. gsheets-logger's said "declares only `net:fetch`", which the new permission
  // turned from stale into false; chat-flow's Security section had been contradicting itself for longer
  // than that, claiming `messages:send` alone one sentence after describing flow state living in
  // ctx.storage. Nothing in the toolchain would have caught any of it.
  const problems = [];
  for (const dir of pluginDirs) {
    const readme = join(root, dir, 'README.md');
    if (!existsSync(readme)) continue;
    const flat = flatten(readFileSync(readme, 'utf8'));
    const declared = new Set(JSON.parse(readFileSync(join(root, dir, 'manifest.json'), 'utf8')).permissions ?? []);
    const { positive, negative } = mentionsOf(flat);

    // Both directions, for every README — a stale claim is wrong whether or not the doc enumerates.
    for (const p of positive) {
      if (!declared.has(p)) problems.push(`${dir}: README claims \`${p}\`, manifest does not declare it`);
    }
    for (const p of negative) {
      if (!positive.has(p) && declared.has(p)) {
        problems.push(`${dir}: README says it does NOT use \`${p}\`, manifest declares it`);
      }
    }

    // Completeness applies only where the README enumerates: a plugin is free not to list permissions
    // at all (chatwoot-adapter and voice-transcription don't), and requiring the section would make this
    // a documentation mandate rather than a drift guard.
    if (!enumeratesPermissions(flat)) continue;
    for (const p of declared) {
      if (!positive.has(p)) problems.push(`${dir}: manifest declares \`${p}\`, README's permission list omits it`);
    }
  }
  assert.deepEqual(problems, []);
});
