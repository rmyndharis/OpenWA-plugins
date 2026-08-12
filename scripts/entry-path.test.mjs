import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configUiMember } from './entry-path.mjs';

test('a configUi entry resolves to the top-level name the packager archives', () => {
  assert.equal(configUiMember('editor.html'), 'editor.html');
  assert.equal(configUiMember('config/index.html'), 'config');
  assert.equal(configUiMember('config/assets/app.js'), 'config');
});

test('a configUi entry that climbs out of the plugin directory is refused', () => {
  // The packager expands a directory entry recursively, so `..` reaches the repo root: an entry of
  // '../types/openwa.d.ts' archives every sibling plugin and all of node_modules.
  for (const escape of ['../types/openwa.d.ts', '..', 'config/../../secrets', '/etc/passwd', '/', '']) {
    assert.throws(() => configUiMember(escape), /inside the plugin directory/, `expected "${escape}" to be refused`);
  }
});
