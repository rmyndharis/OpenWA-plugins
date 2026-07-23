// In-worker per-key async mutex: run(key, fn) chains on the key's tail so critical sections for the same
// key run one at a time, while different keys run concurrently. A rejecting section is isolated (the chain
// recovers), and the map entry is dropped once its tail settles. Pure — no ctx.
// NOTE: intentionally duplicated per plugin (plugins ship as self-contained zips) — keep all copies in
// sync; scripts/shared-copies.test.mjs fails the build when they drift.
export class KeyedAsyncLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.tails.set(key, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.tails.get(key) === next) this.tails.delete(key);
      });
    return next;
  }
}
