import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PluginConfigStore } from './plugin-config.store';
import type { GroupState } from './core/ports';

function makeStorage() {
  const data = new Map<string, unknown>();
  const calls: Record<string, unknown[][]> = { get: [], set: [], delete: [], list: [] };
  return {
    get: async (k: string) => {
      calls.get.push([k]);
      return data.has(k) ? (data.get(k) as unknown) : null;
    },
    set: async (k: string, v: unknown) => {
      calls.set.push([k, v]);
      data.set(k, v);
    },
    delete: async (k: string) => {
      calls.delete.push([k]);
      data.delete(k);
    },
    list: async () => {
      calls.list.push([]);
      return [...data.keys()];
    },
    calls,
  };
}

test('returns a default inactive state for an unknown group', async () => {
  const store = new PluginConfigStore(makeStorage() as never);
  const state = await store.load('s', 'g@g.us');
  assert.equal(state.sessionId, 's');
  assert.equal(state.chatId, 'g@g.us');
  assert.equal(state.active, false);
  assert.equal(state.announced, false);
  assert.deepEqual(state.participants, {});
  assert.deepEqual(state.delegatedControllers, []);
});

test('round-trips a saved state under a per-group key', async () => {
  const storage = makeStorage();
  const store = new PluginConfigStore(storage as never);
  const state: GroupState = {
    sessionId: 's',
    chatId: 'g@g.us',
    active: true,
    participants: { '111@lid': { lang: 'en', source: 'pinned', enabled: true, samples: 1, updatedAt: 'x' } },
    delegatedControllers: ['222@lid'],
    announced: true,
  };
  await store.save(state);
  assert.deepEqual(storage.calls.set[0], ['group:s:g@g.us', state]);
  assert.deepEqual(await store.load('s', 'g@g.us'), state);
});
