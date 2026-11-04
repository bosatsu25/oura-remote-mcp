/**
 * Minimal async mutex. Inside a Durable Object we additionally rely on
 * `blockConcurrencyWhile`, but the core logic is written against this
 * interface so it can be tested in plain Node.
 */

export interface AsyncLock {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createPromiseLock(): AsyncLock {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const next = tail.then(fn, fn);
      // Keep the chain alive even if `fn` rejects.
      tail = next.catch(() => undefined);
      return next;
    },
  };
}
