import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configUiMember, collectEntryFiles } from './entry-path.mjs';

test('a configUi entry resolves to the top-level name the packager archives', () => {
  assert.equal(configUiMember('editor.html'), 'editor.html');
  assert.equal(configUiMember('config/index.html'), 'config');
  assert.equal(configUiMember('config/assets/app.js'), 'config');
  assert.equal(configUiMember('.hidden'), '.hidden');
});

test('a configUi entry is normalised before it is judged, not rejected for spelling', () => {
  // These all name a real file inside the plugin, so refusing them would break a build over punctuation.
  // The packager archives the top-level name, which must come from the NORMALISED path: './config/x'
  // spelled literally would hand it '.', i.e. the whole plugin directory.
  assert.equal(configUiMember('./config/index.html'), 'config');
  assert.equal(configUiMember('config/'), 'config');
  assert.equal(configUiMember('config/./index.html'), 'config');
  assert.equal(configUiMember('config//assets/app.js'), 'config');
  assert.equal(configUiMember('config/sub/../index.html'), 'config');
});

test('a configUi entry that climbs out of the plugin directory is refused', () => {
  // The packager expands a directory entry recursively, so `..` reaches the repo root: an entry of
  // '../types/openwa.d.ts' archives every sibling plugin and all of node_modules.
  for (const escape of ['../types/openwa.d.ts', '..', 'config/../../secrets', '/etc/passwd', '/', '..\\secrets', '\\\\server\\share']) {
    assert.throws(() => configUiMember(escape), /must stay inside the plugin directory/, `expected "${escape}" to be refused`);
  }
});

test('a configUi entry naming the plugin directory itself is refused, and says so', () => {
  // The packager collects a directory entry recursively, so an entry that reduces to the plugin root
  // archives every source file, test and stray note in it. Verified before this guard existed: such an
  // entry produced a 10-member archive where 4 were expected. The message must not claim the path
  // escaped the directory — it did not, it named the directory.
  for (const root of ['.', './', 'config/..', '']) {
    assert.throws(() => configUiMember(root), /names the plugin directory itself/, `expected "${root}" to be refused`);
  }
});

test('a symlink inside the packaged tree is refused instead of followed out of the plugin', () => {
  // statSync follows links, so a directory link inside a plugin pulls whatever it points at into the
  // archive. Verified against the packager before this guard existed: a 'ui' link to a sibling
  // directory put that directory's files into the zip, contents and all, and the build reported success.
  const root = mkdtempSync(join(tmpdir(), 'entry-path-'));
  try {
    const plugin = join(root, 'plugin');
    mkdirSync(join(plugin, 'config'), { recursive: true });
    writeFileSync(join(plugin, 'config', 'index.html'), '<html></html>');
    mkdirSync(join(root, 'outside'), { recursive: true });
    writeFileSync(join(root, 'outside', 'keys.txt'), 'secret');

    // A real file inside the plugin is collected as before.
    assert.deepEqual(
      collectEntryFiles(plugin, 'config').map((f) => f.name),
      ['config/index.html'],
    );

    // A link that leaves the plugin, and a link that stays inside it: an archive member must be a real
    // file either way, because the zip stores contents and an extracted link would not survive.
    symlinkSync(join(root, 'outside'), join(plugin, 'ui'));
    symlinkSync(join(plugin, 'config'), join(plugin, 'alias'));
    for (const link of ['ui', 'alias']) {
      assert.throws(() => collectEntryFiles(plugin, link), /symlink/, `expected "${link}" to be refused`);
    }

    // And one nested a level down, where the entry itself is an ordinary directory.
    symlinkSync(join(root, 'outside'), join(plugin, 'config', 'nested'));
    assert.throws(() => collectEntryFiles(plugin, 'config'), /symlink/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
