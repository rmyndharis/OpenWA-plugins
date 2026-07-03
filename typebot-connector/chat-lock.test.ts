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
  assert.deepEqual(order, ['a', 'b']);

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
  assert.equal(max, 2);
});

test('a rejecting critical section does not wedge the key', async () => {
  const lock = new KeyedAsyncLock();
  await assert.rejects(lock.run('K', async () => Promise.reject(new Error('boom'))));
  assert.equal(await lock.run('K', async () => 42), 42);
});
