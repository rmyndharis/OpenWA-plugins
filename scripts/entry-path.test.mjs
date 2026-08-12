import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configUiMember } from './entry-path.mjs';

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
