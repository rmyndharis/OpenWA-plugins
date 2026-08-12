// `manifest.hooks` tells an operator (and the dashboard) which events a plugin binds. Nothing compared
// it to the events the code actually registers, so it could drift in either direction: a hook added in
// code and not declared, or a declared hook the plugin no longer listens for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const pluginDirs = readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(ROOT, d.name, 'manifest.json')))
  .map((d) => d.name);

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

// The event a `registerHook` call binds. Both quote styles are in use — matching only one of them
// silently finds nothing, which reads exactly like a plugin that registers no hooks.
function registeredEvents(dir) {
  const found = new Set();
  for (const file of sourceFiles(join(ROOT, dir))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/registerHook\(\s*['"]([\w:]+)['"]/g)) found.add(m[1]);
    // gsheets-logger registers from a list rather than inline, so also take the typed event constants.
    for (const m of src.matchAll(/HookEvent\[\]\s*=\s*\[([^\]]*)\]/g)) {
      for (const e of m[1].matchAll(/['"]([\w:]+)['"]/g)) found.add(e[1]);
    }
  }
  return [...found].sort();
}

test('every plugin registers hooks and declares them', () => {
  // The precondition and the comparison in one: a plugin with neither is a plugin whose sources this
  // check failed to read, which would otherwise look like agreement.
  const withHooks = pluginDirs.filter((d) => registeredEvents(d).length > 0);
  assert.ok(withHooks.length >= pluginDirs.length - 1, `only ${withHooks.length} of ${pluginDirs.length} plugins appear to register a hook — the source scan is probably wrong`);

  const drift = [];
  for (const dir of pluginDirs) {
    const declared = [...(JSON.parse(readFileSync(join(ROOT, dir, 'manifest.json'), 'utf8')).hooks ?? [])].sort();
    const registered = registeredEvents(dir);
    if (JSON.stringify(declared) !== JSON.stringify(registered)) {
      drift.push(`${dir}: manifest declares [${declared}] but the code registers [${registered}]`);
    }
  }
  assert.deepEqual(drift, []);
});

test('a plugin directory is discoverable and readable', () => {
  assert.ok(pluginDirs.length > 0, `no plugin directories under ${ROOT}`);
  for (const dir of pluginDirs) {
    assert.ok(statSync(join(ROOT, dir, 'manifest.json')).size > 0, `${dir}: empty manifest`);
  }
});
