import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyedAsyncLock } from './chat-lock.ts';

test('same key serializes; different keys overlap', async () => {
  const lock = new KeyedAsyncLock();
  const order: string[] = [];
  const slow = (tag: string, ms: number) =>
    lock.run('K', async () => {
      await new Promise(r => setTimeout(r, ms));
      order.push(tag);
    });
  await Promise.all([slow('a', 20), slow('b', 1)]);
  assert.deepEqual(order, ['a', 'b']); // b waited for a despite being faster (serialized on the same key)

  let concurrent = 0;
  let max = 0;
  const track = (k: string) =>
    lock.run(k, async () => {
      concurrent++;
      max = Math.max(max, concurrent);
      await new Promise(r => setTimeout(r, 5));
      concurrent--;
    });
  await Promise.all([track('X'), track('Y')]);
  assert.equal(max, 2); // independent keys run together
});

test('a rejecting critical section does not wedge the key', async () => {
  const lock = new KeyedAsyncLock();
  await assert.rejects(lock.run('K', async () => Promise.reject(new Error('boom'))));
  // The next run on the same key must still execute (the tail recovered from the rejection).
  assert.equal(await lock.run('K', async () => 42), 42);
});
