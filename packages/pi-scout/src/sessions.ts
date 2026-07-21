import { SessionManager } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { redact } from "./redact.ts";
import { capText } from "./result.ts";

export type SessionIntent = { query: string };
export type SessionEvidence = {
  corpus: string;
  excerptCount: number;
  scanned: number;
  redactionCount: number;
  truncated: boolean;
};

export function parseSessionIntent(text: string): SessionIntent | undefined {
  const match = text.match(/^\s*search my pi sessions?\b\s*(.*)$/i);
  if (!match) return undefined;
  const query = match[1].replace(/^(?:for|about|regarding)\b\s*/i, "").trim();
  return query ? { query } : undefined;
}

function terms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])];
}
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text")
    .map((part: any) => part.text)
    .join("\n");
}

export async function collectSessionEvidence(
  query: string,
  limit = 200,
  signal?: AbortSignal,
): Promise<SessionEvidence> {
  const wanted = terms(query);
  const listed = (await SessionManager.listAll()).slice(0, limit);
  const excerpts: string[] = [];
  const seen = new Set<string>();
  let redactionCount = 0;
  for (const info of listed) {
    if (signal?.aborted) throw new DOMException("Session search aborted", "AbortError");
    if (excerpts.length >= 12) break;
    let manager: SessionManager;
    try {
      manager = SessionManager.open(info.path);
    } catch {
      continue;
    }
    for (const entry of manager.getBranch()) {
      if (signal?.aborted) throw new DOMException("Session search aborted", "AbortError");
      if (
        entry.type !== "message" ||
        (entry.message.role !== "user" && entry.message.role !== "assistant")
      )
        continue;
      const text = textOf(entry.message.content);
      if (!text || !wanted.some((term) => text.toLowerCase().includes(term)))
        continue;
      const clean = redact(text);
      const identity = `${info.id}\0${entry.message.role}\0${clean.text.replace(/\r\n/g, "\n").trim()}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      redactionCount += clean.count;
      excerpts.push(
        `### Session ${info.id} (${info.modified.toISOString().slice(0, 10)})\nFile: ${basename(info.path)}\nRole: ${entry.message.role}\n${clean.text.slice(0, 1200)}`,
      );
      if (excerpts.length >= 12) break;
    }
  }
  const capped = capText(excerpts.join("\n\n---\n\n"));
  return {
    corpus: capped.text,
    excerptCount: excerpts.length,
    scanned: listed.length,
    redactionCount,
    truncated:
      capped.truncated || listed.length === limit || excerpts.length === 12,
  };
}
