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
  await store.set('sessA:abandoned', st(0));
  await store.set('sessA:active', st(9_000));
  const pruned = await store.pruneIdle(10_000, 1_000, 'sessA');
  assert.equal(pruned, 1);
  assert.equal(await store.get('sessA:abandoned'), null);
  assert.ok(await store.get('sessA:active'));
});

test('pruneIdle ignores keys that are not session rows', async () => {
  const storage = fakeStorage();
  const store = new SessionStore(storage);
  await storage.set('manifest', { not: 'a session' }); // a package-owned stem a bare list() can surface
  await store.set('sessA:live', { sessionId: 'S', awaiting: { kind: 'text', blockId: 'b', attachmentsEnabled: false }, lastActivity: 9_000 });
  assert.equal(await store.pruneIdle(10_000, 1_000, 'sessA'), 0);
  assert.deepEqual(await storage.get('manifest'), { not: 'a session' });
});

// Regression: the sweep threshold comes from the config resolved for the session whose message
// triggered it, and sessionTimeoutMinutes is overridable per session. An unscoped sweep therefore
// applied one session's (possibly 5-minute) timeout to every other session's rows and deleted flows
// that were still live under their own, longer, timeout — a contact halfway through a long form
// silently restarts at question one.
test('pruneIdle never touches another session rows', async () => {
  const store = new SessionStore(fakeStorage());
  const st = (lastActivity: number): SessionState =>
    ({ sessionId: 'S', awaiting: { kind: 'text', blockId: 'b', attachmentsEnabled: false }, lastActivity });
  await store.set('support:62811@c.us', st(0));       // idle 10s, support timeout is 1s
  await store.set('sales:62822@c.us', st(0));         // equally idle, but sales' own timeout is 1 day
  const pruned = await store.pruneIdle(10_000, 1_000, 'support');
  assert.equal(pruned, 1);
  assert.equal(await store.get('support:62811@c.us'), null, 'the triggering session is swept');
  assert.ok(await store.get('sales:62822@c.us'), 'another session mid-flow row must survive');
});
