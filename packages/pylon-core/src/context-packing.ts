/**
 * Budget packing for the bounded parent context handed to a delegated child agent.
 *
 * Only the packing is shared. *Which* transcript entries are worth sending differs
 * per package and stays with each caller; how many of them fit, and which duplicates
 * to drop, does not.
 */

/**
 * Selects the most recent records that fit, newest-first, then restores reading order.
 *
 * De-duplication is by `identity` rather than by raw text so that callers can ignore
 * whitespace or redaction differences. A record whose identity is empty is dropped.
 * A record that does not fit is skipped rather than ending the scan — a single large
 * record must not hide every older one that would still fit.
 */
export function packRecentRecords(
  records: readonly string[],
  options: {
    maxChars: number;
    maxItems: number;
    identity: (record: string) => string;
  },
): string {
  const { maxChars, maxItems, identity } = options;
  if (maxChars <= 0 || maxItems <= 0) return "";
  const separator = "\n\n";
  const selected: string[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (
    let index = records.length - 1;
    index >= 0 && selected.length < maxItems;
    index--
  ) {
    const record = records[index];
    const key = identity(record);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const size = record.length + (selected.length ? separator.length : 0);
    if (used + size > maxChars) continue;
    selected.push(record);
    used += size;
  }
  return selected.reverse().join(separator);
}
