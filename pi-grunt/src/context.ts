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

export function buildWorkerContext(entries: readonly any[], maxChars = 6000, maxItems = 10): string {
  const items: string[] = [];
  for (const entry of entries) {
    if (entry?.type === "message") {
      const message = entry.message;
      if (message?.role === "user") {
        const text = contentText(message.content);
        if (text) items.push(`User: ${text}`);
      } else if (message?.role === "assistant") {
        const text = contentText(message.content);
        if (text) items.push(`Main assistant: ${text}`);
      }
    } else if ((entry?.type === "compaction" || entry?.type === "branch_summary") && entry.summary) {
      items.push(`Earlier context summary: ${entry.summary}`);
    }
  }
  return redact(items.slice(-maxItems).map((item) => item.slice(0, 1200)).join("\n\n")).slice(0, maxChars);
}
