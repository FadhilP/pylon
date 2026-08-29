import { packRecentRecords } from "pylon-core/context-packing";
import {
  redact as redactText,
  sanitizeFailureMessage,
} from "pylon-core/redact";

export { sanitizeFailureMessage };

// Parent context is prose the worker must reason about, so long identifiers — commit
// hashes, digests, base64 blobs — are left intact; only provider-shaped secrets go.
const redact = (text: string) => redactText(text, { broadTokens: false }).text;

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text")
    .map((part: any) => part.text)
    .join("\n");
}

export function buildWorkerContext(
  entries: readonly any[],
  maxChars = 6000,
  maxItems = 10,
  pinnedTexts: readonly string[] = [],
): string {
  if (maxChars <= 0 || maxItems <= 0) return "";
  const normalize = (text: string) =>
    redact(text).replace(/\r\n/g, "\n").trim();
  const pinned = new Set(pinnedTexts.map(normalize).filter(Boolean));
  const records: string[] = [];
  for (const entry of entries) {
    let label = "";
    let content = "";
    if (entry?.type === "message") {
      const message = entry.message;
      if (message?.role === "user") {
        label = "User";
        content = contentText(message.content);
      } else if (message?.role === "assistant") {
        label = "Main assistant";
        content = contentText(message.content);
      }
    } else if (
      (entry?.type === "compaction" || entry?.type === "branch_summary") &&
      entry.summary
    ) {
      label = "Earlier context summary";
      content = entry.summary;
    }
    content = redact(content).trim();
    if (label && content && !pinned.has(normalize(content)))
      records.push(`${label}: ${content}`);
  }

  return packRecentRecords(records, {
    maxChars,
    maxItems,
    identity: normalize,
  });
}
