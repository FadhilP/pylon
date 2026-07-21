const secretPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
  /\b(?:sk|pk)-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:ghp|github_pat|glpat)-[A-Za-z0-9_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi,
];

function redact(text: string): string {
  return secretPatterns.reduce((value, pattern) => value.replace(pattern, "[REDACTED]"), text);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n");
}

export function buildWorkerContext(
  entries: readonly any[],
  maxChars = 6000,
  maxItems = 10,
  pinnedTexts: readonly string[] = [],
): string {
  if (maxChars <= 0 || maxItems <= 0) return "";
  const normalize = (text: string) => redact(text).replace(/\r\n/g, "\n").trim();
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
    } else if ((entry?.type === "compaction" || entry?.type === "branch_summary") && entry.summary) {
      label = "Earlier context summary";
      content = entry.summary;
    }
    content = redact(content).trim();
    if (label && content && !pinned.has(normalize(content))) records.push(`${label}: ${content}`);
  }

  const selected: string[] = [];
  const seen = new Set<string>();
  let length = 0;
  for (let index = records.length - 1; index >= 0 && selected.length < maxItems; index--) {
    const record = records[index];
    const identity = normalize(record);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const separatorLength = selected.length ? 2 : 0;
    if (length + separatorLength + record.length > maxChars) continue;
    selected.push(record);
    length += separatorLength + record.length;
  }
  return selected.reverse().join("\n\n");
}
