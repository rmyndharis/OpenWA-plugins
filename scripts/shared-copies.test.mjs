// Drift guard for intentionally duplicated helper files. Plugins ship as self-contained zips, so
// shared helpers are copied per plugin instead of imported from a shared package — the price of that
// self-containment is that a fix in one copy does not reach the others. This test fails the suite
// the moment copies drift, forcing the fix to be applied everywhere (or the group list to be updated
// deliberately).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const GROUPS = [
  ['chatwoot-adapter/chat-lock.ts', 'typebot-connector/chat-lock.ts'],
  ['chatwoot-adapter/multipart.ts', 'typebot-connector/multipart.ts', 'voice-transcription/multipart.ts'],
  ['after-hours/cooldown.ts', 'faq-bot/cooldown.ts', 'http-action/cooldown.ts'],
];

for (const group of GROUPS) {
  test(`shared copies stay in sync: ${group.join(', ')}`, () => {
    const [first, ...rest] = group.map((p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
    for (let i = 0; i < rest.length; i++) {
      assert.equal(rest[i], first, `${group[i + 1]} has drifted from ${group[0]} — apply the change to every copy`);
    }
  });
}
