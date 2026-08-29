/**
 * Runs pre-grouped work with one worker per group, at most `limit` groups at a time.
 * Items inside a group run in order; workers stop as soon as `shouldStop` turns true.
 */
export async function runGrouped<T>(
  groups: readonly T[][],
  limit: number,
  run: (item: T) => Promise<void>,
  shouldStop: () => boolean,
): Promise<void> {
  let nextGroup = 0;
  const worker = async () => {
    while (!shouldStop()) {
      const group = groups[nextGroup++];
      if (!group) return;
      for (const item of group) {
        if (shouldStop()) return;
        await run(item);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, groups.length) }, () => worker()));
}
