import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertLoadable } from './loader-check.mjs';

test('a bundle that default-exports a usable plugin class passes', () => {
  class Good {
    async onEnable() {}
  }
  assert.doesNotThrow(() => assertLoadable({ default: Good }, 'good-plugin'));
});

test('a bundle the host could not instantiate is refused, and the message names the plugin', () => {
  // Each of these produces an archive package.mjs accepts — `main` is present as a member — and that the
  // host then rejects at install, after the tag and the GitHub Release are already published.
  const broken = [
    [{}, 'no default export at all'],
    [{ default: {} }, 'default export is not constructible'],
    [{ default: 42 }, 'default export is a primitive'],
    [{ default: class NoHooks {} }, 'instance has no onEnable()'],
    [
      {
        default: class Throws {
          constructor() {
            throw new Error('missing dependency');
          }
        },
      },
      'constructor throws',
    ],
  ];

  for (const [mod, why] of broken) {
    assert.throws(() => assertLoadable(mod, 'bad-plugin'), /bad-plugin/, `expected a refusal naming the plugin: ${why}`);
  }
});
