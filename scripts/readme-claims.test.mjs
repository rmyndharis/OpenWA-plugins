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

// Prose wraps, so a claim and the value it states routinely straddle a newline: group-translate ends a
// line on "Declares" and opens the next with the list, and gsheets-logger splits "Requires OpenWA" from
// "**≥ 0.7.0**" the same way. Anything matched across a claim has to be matched on flattened text.
const flatten = (text) => text.replace(/\s+/g, ' ');

// The placeholder hosts a README uses for the gateway itself. Anything else in these documents is a
// third-party backend — LibreTranslate, an ERP, a Speaches STT, an n8n webhook — and must not be held to
// the gateway's `/api` prefix. That is why loopback is listed WITH the gateway port: a bare 127.0.0.1
// would sweep in `http://127.0.0.1:8000` (STT) and `http://127.0.0.1:5678/webhook/transcript` (n8n).
const GATEWAY_HOSTS = /your-openwa-host|localhost:2785|127\.0\.0\.1:2785|<host>/;

// The PLUGIN-level OpenWA floors a README states. These READMEs also state per-feature floors —
// gsheets-logger's ack rows need 0.6.1, chatwoot-adapter's attachment backfill needs 0.8.6 — which are
// legitimately different numbers from the manifest, so comparing those would fail correct documentation.
//
// The corpus separates the two by capitalisation, consistently: a plugin-level claim opens a sentence
// ("Targets OpenWA…", "Requires OpenWA…", "Have OpenWA…") or heads a Compatibility bullet as bold
// **OpenWA**, while a per-feature floor sits mid-sentence behind a lowercase verb ("…rows** require
// OpenWA ≥ v0.6.1", "Needs OpenWA 0.8.6+"). The lead-ins are matched case-SENSITIVELY on purpose — the
// capital is the signal, not an accident of style.
//
// Shared with the precondition test, which asserts the result is non-empty. Without that, a README
// wording its floor in none of these shapes makes the comparison pass while comparing nothing.
function statedFloors(text) {
  const flat = flatten(text);
  const stated = new Set();
  for (const m of text.matchAll(/badge\/OpenWA-%E2%89%A5%20([0-9.]+)-/g)) stated.add(m[1]);
  for (const m of flat.matchAll(/(?:Targets|Requires|Have) OpenWA\s*\*\*≥\s*v?([0-9.]+)\*\*/g)) stated.add(m[1]);
  for (const m of flat.matchAll(/(?:Targets|Requires|Have) OpenWA\s+v?([0-9.]+)\+/g)) stated.add(m[1]);
  for (const m of flat.matchAll(/\*\*OpenWA\*\*\s*≥\s*v?([0-9.]+)/g)) stated.add(m[1]);
  return stated;
}

// The GitHub owners a README links this repository under. Matched case-INSENSITIVELY because GitHub
// repository names are: `someone/OpenWA-Plugins` resolves in a browser, so a case-sensitive match would
// let a fork link through by seeing nothing at all.
const repoOwnersIn = (text) => [...text.matchAll(/([\w.-]+)\/OpenWA-plugins/gi)].map((m) => m[1]);

test('every plugin supplies what the checks below need', () => {
  // Three checks below opt a plugin out when an input they need is absent: no README, no `repository`
  // to take an owner from, no `minOpenWAVersion` to compare. Those are quiet `continue`s, and a quiet
  // skip is indistinguishable from a pass — the suite stays green while checking nothing, which is the
  // exact failure mode the rest of this file exists to catch.
  //
  // Asserting the precondition once is better than counting units inside each check: while this passes,
  // none of those five skips can fire, and when a plugin arrives without one of these inputs THIS test
  // names the missing input instead of the plugin quietly dropping out of three other tests. Deliberate
  // narrowing is left alone — the `/api` check ignores third-party hosts and the completeness check
  // ignores a README that does not enumerate, both because that is the correct scope, not an accident.
  // Discovery itself is the widest version of the problem: `pluginDirs` is derived from this file's own
  // location, so moving the file or restructuring the repo empties it and EVERY check below passes
  // having examined nothing at all.
  assert.ok(pluginDirs.length > 0, `no plugin directories discovered under ${root}`);

  const missing = [];
  // The root README is prepended to the /api check by hand and dropped by a silent `.filter(existsSync)`;
  // after this test it is the only entry that filter can still remove, and it carries gateway URLs.
  if (!existsSync(join(root, 'README.md'))) missing.push('root README.md is absent — the /api check would skip it');

  for (const dir of pluginDirs) {
    const readme = join(root, dir, 'README.md');
    if (!existsSync(readme)) {
      missing.push(`${dir}: no README.md — three checks would skip it`);
      continue; // the per-README assertions below cannot run, and would only repeat this
    }
    const text = readFileSync(readme, 'utf8');
    const m = JSON.parse(readFileSync(join(root, dir, 'manifest.json'), 'utf8'));

    // Both halves of each comparison, not just the manifest half. A missing input on the README side
    // does not skip the loop — it lets the loop run and compare an empty set, which is the same green
    // for a different reason, and the README side is the half that actually goes missing.
    if (!m.minOpenWAVersion) missing.push(`${dir}: no minOpenWAVersion — the version-floor check would skip it`);
    if (statedFloors(text).size === 0) missing.push(`${dir}: README states no OpenWA floor — the version-floor check would compare nothing`);
    if (!/github\.com\/[\w.-]+\//.test(m.repository ?? '')) {
      missing.push(`${dir}: repository is absent or not a github.com URL — the repository-link check would skip it`);
    }
    if (repoOwnersIn(text).length === 0) missing.push(`${dir}: README links no <owner>/OpenWA-plugins — the repository-link check would compare nothing`);
  }
  assert.deepEqual(missing, []);
});

test('every gateway URL in a README carries the /api prefix', () => {
  // The gateway mounts a global `/api` prefix, so `<host>/plugins/...` answers 404. 27 copy-pasteable
  // curl commands addressed it without the prefix.
  const offenders = [];
  for (const file of readmes) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/https?:\/\/[^\s'"`)]+/g)) {
      const url = m[0];
      if (!GATEWAY_HOSTS.test(url)) continue;
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      if (path && path !== '/' && !path.startsWith('/api/')) offenders.push(`${file.replace(root + '/', '')}: ${url}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("a plugin README links the repository its manifest names", () => {
  // supabase-otp-hook was contributed from another account, and its Install section pointed at that
  // account's fork for the download. PR #54 corrected `repository` in the manifest — which is what the
  // catalog derives release URLs from — but the README sentence was missed, so the documented path stayed
  // a fork with zero releases: a page that opens, looks right, and offers nothing. That is the same shape
  // as the permission drift this file already guards, and the second time here that a manifest was fixed
  // while the prose describing it was not.
  //
  // `author` deliberately keeps the original contributor and is not a URL, so it is untouched by this.
  const wrong = [];
  for (const dir of pluginDirs) {
    const readme = join(root, dir, 'README.md');
    if (!existsSync(readme)) continue;
    const repo = JSON.parse(readFileSync(join(root, dir, 'manifest.json'), 'utf8')).repository;
    const owner = repo?.match(/github\.com\/([\w.-]+)\//)?.[1];
    if (!owner) continue;
    for (const linked of repoOwnersIn(readFileSync(readme, 'utf8'))) {
      if (linked.toLowerCase() !== owner.toLowerCase()) {
        wrong.push(`${dir}: README links ${linked}/OpenWA-plugins, manifest repository is ${owner}`);
      }
    }
  }
  assert.deepEqual([...new Set(wrong)], []);
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
    for (const v of statedFloors(readFileSync(readme, 'utf8'))) {
      if (v !== declared) mismatches.push(`${dir}: README says ${v}, manifest says ${declared}`);
    }
  }
  assert.deepEqual(mismatches, []);
});

// The five permissions the host enforces at the capability boundary, plus `storage:use` (added when
// OpenWA moved ctx.storage behind a declaration gate) and `search:provide` (required by core since
// 0.12.2). No plugin here declares `search:provide`, which is exactly why it belongs in this floor
// rather than only in the manifest-derived union below: the union can only see names some manifest
// already declares, so without this entry a README claiming `search:provide` — over-declaring a
// capability the plugin does not have — would be invisible to the check written to catch that.
const KNOWN_PERMISSIONS = [
  'messages:send', 'engine:read', 'net:fetch', 'conversation:send', 'webhook:ingress', 'storage:use', 'search:provide',
];

// The vocabulary must include anything a manifest actually declares, not just the names known when this
// was written. Hardcoding the list alone fails in both directions the moment a plugin adopts a newer
// permission — `search:provide` is the one waiting to happen, required by core since 0.12.2. A README
// claiming an unlisted permission would go unseen, and worse, declaring one would report "README's
// permission list omits it" even when the README lists it plainly, because the scan could not see the
// name it was looking for. That failure has no fix except deleting the documentation, which is the
// opposite of the point. Keep the known names as a floor so a permission NOBODY declares can still be
// recognised when a README negates it.
const PERMISSIONS = [
  ...new Set([
    ...KNOWN_PERMISSIONS,
    ...pluginDirs.flatMap((d) => JSON.parse(readFileSync(join(root, d, 'manifest.json'), 'utf8')).permissions ?? []),
  ]),
];

// Classify every `permission` occurrence. A negation sitting directly in front of one ("…so no
// `engine:read`") is a claim too — the opposite one — so it is checked in the opposite direction rather
// than skipped. The adjacency is deliberately one word: widening it to a phrase would swallow the "no"
// in "makes no outbound network calls and declares only `messages:send`" and invert a true claim. The
// preceding token may not carry sentence-ending punctuation, so a question answered "No." before a
// positive mention is not read as negating it.
function mentionsOf(flat) {
  const positive = new Set();
  const negative = new Set();
  for (const p of PERMISSIONS) {
    for (const m of flat.matchAll(new RegExp('([^\\s.!?;:]+ )?`' + p + '`', 'g'))) {
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
//
// The `permissions:` marker must NOT carry a trailing \b. A word boundary after the colon needs a word
// character next, and every real heading writes "Permissions: `webhook:ingress`" with a space — so the
// alternative matched nothing but the impossible "permissions:x". supabase-otp-hook is the only plugin
// that heads its list this way and uses no form of "declare", so it was the one README silently exempt
// from the completeness check this function exists to apply.
function enumeratesPermissions(flat) {
  for (const m of flat.matchAll(/\b(?:declares?|declared)\b|\bpermissions?\s*:/gi)) {
    const window = flat.slice(m.index, m.index + 120);
    if (PERMISSIONS.some((p) => window.includes('`' + p + '`'))) return true;
  }
  return false;
}

test("a README's permission claims match its manifest", () => {
  // Seven plugin READMEs state the declared permissions in prose, and that sentence is the only place an
  // operator reads the list — plugins.json publishes the manifest array, but nobody browses it, and the
  // catalog gate never opens a README's prose. Adding `storage:use` to seven manifests falsified four of
  // those sentences at once. gsheets-logger's said "declares only `net:fetch`", which the new permission
  // turned from stale into false; chat-flow's Security section had been contradicting itself for longer
  // than that, claiming `messages:send` alone one sentence after describing flow state living in
  // ctx.storage. Nothing in the toolchain would have caught any of it.
  //
  // Known limits, so the next reader knows where the edge is rather than trusting past it. This matches
  // prose, and only prose that names a permission in backticks: an enumeration written as a table, or
  // one whose permissions sit more than ~120 characters from the word that introduces them, is not
  // recognised as an enumeration and escapes the completeness direction. Completeness is also measured
  // against the whole file, so a closed "declares only X" sentence can go stale while passing, if the
  // missing permission happens to be named elsewhere in the same README. Widening any of these means
  // parsing English, which costs more than the drift it would catch — but none of them is a reason to
  // read a green run as "every sentence in this README is true".
  const problems = [];
  for (const dir of pluginDirs) {
    const readme = join(root, dir, 'README.md');
    if (!existsSync(readme)) continue;
    const flat = flatten(readFileSync(readme, 'utf8'));
    const declared = new Set(JSON.parse(readFileSync(join(root, dir, 'manifest.json'), 'utf8')).permissions ?? []);
    const { positive, negative } = mentionsOf(flat);

    // Both directions, for every README — a stale claim is wrong whether or not the doc enumerates.
    // The message names the second possible cause on purpose: an unrecognised negation surfaces here,
    // and "README claims X" alone would read as an instruction to add X to the manifest, which is the
    // one repair that turns a documentation slip into a real over-declaration.
    for (const p of positive) {
      if (!declared.has(p)) {
        problems.push(
          `${dir}: README names \`${p}\` as a permission this plugin has, but the manifest does not ` +
            `declare it — either the claim is stale, or it is a denial phrased in a way this check does ` +
            `not recognise (it reads only "no"/"not"/"never" immediately before the name)`,
        );
      }
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
