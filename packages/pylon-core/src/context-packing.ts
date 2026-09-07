/**
 * Pack caller-selected context newest-first, then restore reading order.
 * Deduplicate by caller-defined identity, dropping empty identities.
 * Skip non-fitting records so older records can still fit.
 */
export function packRecentRecords(
  records: readonly string[],
  options: { maxChars: number; maxItems: number; identity: (record: string) => string },
): string {
  const { maxChars, maxItems, identity } = options;
  if (maxChars <= 0 || maxItems <= 0) return "";
  const separator = "\n\n";
  const selected: string[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (let index = records.length - 1; index >= 0 && selected.length < maxItems; index--) {
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
