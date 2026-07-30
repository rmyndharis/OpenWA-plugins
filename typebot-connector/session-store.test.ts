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

// A completed flow clears its own row; an abandoned one would otherwise sit there for the life of the
// install, and the host stats every stored key on every write — so it taxes every later turn.
test('pruneIdle drops abandoned rows and keeps live ones', async () => {
  const storage = fakeStorage();
  const store = new SessionStore(storage);
  const st = (lastActivity: number): SessionState =>
    ({ sessionId: 'S', awaiting: { kind: 'text', blockId: 'b', attachmentsEnabled: false }, lastActivity });
  await store.set('abandoned', st(0));
  await store.set('active', st(9_000));
  const pruned = await store.pruneIdle(10_000, 1_000);
  assert.equal(pruned, 1);
  assert.equal(await store.get('abandoned'), null);
  assert.ok(await store.get('active'));
});

test('pruneIdle ignores keys that are not session rows', async () => {
  const storage = fakeStorage();
  const store = new SessionStore(storage);
  await storage.set('manifest', { not: 'a session' }); // a package-owned stem a bare list() can surface
  await store.set('live', { sessionId: 'S', awaiting: { kind: 'text', blockId: 'b', attachmentsEnabled: false }, lastActivity: 9_000 });
  assert.equal(await store.pruneIdle(10_000, 1_000), 0);
  assert.deepEqual(await storage.get('manifest'), { not: 'a session' });
});
