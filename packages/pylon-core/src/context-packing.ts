import type { SessionEntry, SessionProjection } from "@earendil-works/pi-coding-agent";

/** Preserve source metadata while handing off only the canonical, edited model context. */
export function projectedContextEntries(projection: SessionProjection): SessionEntry[] {
  return projection.entries.flatMap(({ sourceEntry, messages }): SessionEntry[] => {
    if (sourceEntry.type === "message") return messages.map(message => ({ ...sourceEntry, message }));
    if (sourceEntry.type === "custom_message")
      return messages.flatMap(message =>
        message.role === "custom" ? [{ ...sourceEntry, content: message.content }] : [],
      );
    if (sourceEntry.type === "compaction" && !messages.length) return [];
    return [sourceEntry];
  });
}

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
