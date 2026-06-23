// Catalog passthrough test: verifies that plugins.json carries i18n blocks for any plugin whose
// manifest.json has an `i18n` field. Run after `npm run catalog` (Task 6 adds the blocks and
// regenerates; until then `withI18n` is empty and the assertion at line 14 will fail as expected).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('plugins.json carries i18n for a plugin whose manifest has it', () => {
  const catalog = JSON.parse(readFileSync(new URL('../plugins.json', import.meta.url), 'utf8'));
  const entries = catalog.plugins ?? catalog;
  const withI18n = entries.filter(e => e.i18n);
  // After Task 6 every plugin has i18n; assert at least one and that it has locale keys.
  assert.ok(withI18n.length > 0, 'expected at least one plugin entry with i18n');
  for (const e of withI18n) assert.ok(e.i18n.es && e.i18n['zh-CN'], `${e.id} i18n should include es + zh-CN`);
});
