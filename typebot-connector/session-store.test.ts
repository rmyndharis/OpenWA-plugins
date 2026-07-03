import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginStorage } from '../types/openwa';
import type { SessionState } from './typebot-types.ts';
import { SessionStore } from './session-store.ts';

function fakeStorage(): PluginStorage {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => (m.has(k) ? (m.get(k) as T) : null),
    set: async (k, v) => void m.set(k, v),
    delete: async k => void m.delete(k),
    list: async (p = '') => [...m.keys()].filter(k => k.startsWith(p)),
  };
}

test('set then get round-trips; clear removes', async () => {
  const store = new SessionStore(fakeStorage());
  const state: SessionState = { sessionId: 'S', awaiting: { kind: 'text', blockId: 'b', attachmentsEnabled: false }, lastActivity: 5 };
  assert.equal(await store.get('k'), null);
  await store.set('k', state);
  assert.deepEqual(await store.get('k'), state);
  await store.clear('k');
  assert.equal(await store.get('k'), null);
});
