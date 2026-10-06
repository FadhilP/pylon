/** Maps items with at most `limit` tasks in flight, keeping results in input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await task(items[index]!);
      }
    }),
  );
  return results;
}

/** Runs tasks one at a time in call order; a failed task does not block the next one. */
export function createSerialQueue() {
  let tail = Promise.resolve();
  return async <T>(task: () => T | Promise<T>): Promise<T> => {
    const previous = tail;
    let release = () => {};
    tail = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  };
}
