import { packRecentRecords } from "pylon-core/context-packing";
import { redact } from "pylon-core/redact";

const MAX_ITEM_CHARS = 1200;

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text")
    .map((part: any) => part.text)
    .join("\n");
}

export function buildParentContext(
  entries: readonly any[],
  maxChars = 6000,
  maxItems = 10,
): string {
  if (maxChars <= 0 || maxItems <= 0) return "";
  const items: string[] = [];
  for (const entry of entries) {
    if (entry?.type === "message") {
      const message = entry.message;
      if (message?.role === "user") {
        const text = contentText(message.content);
        if (text) items.push(`User: ${text}`);
      } else if (
        message?.role === "assistant" &&
        Array.isArray(message.content)
      ) {
        const text = contentText(message.content);
        if (text) items.push(`Main assistant: ${text}`);
        for (const part of message.content) {
          if (part?.type !== "toolCall" || part.name === "repo_scout") continue;
          let args = "";
          try {
            args = JSON.stringify(part.arguments ?? {});
          } catch {
            args = "[unserializable arguments]";
          }
          items.push(`Main assistant tool intent (${part.name}): ${args}`);
        }
      }
    } else if (entry?.type === "compaction" && entry.summary) {
      items.push(`Earlier context summary: ${entry.summary}`);
    } else if (entry?.type === "branch_summary" && entry.summary) {
      items.push(`Branch summary: ${entry.summary}`);
    } else if (
      entry?.type === "custom" &&
      ["pi-prompt-checkpoint", "pi-verify-result"].includes(entry.customType)
    ) {
      try {
        const data = { ...entry.data };
        delete data.worktreeRef;
        delete data.indexRef;
        items.push(
          `Repository state (${entry.customType}): ${JSON.stringify(data)}`,
        );
      } catch {
        items.push(`Repository state (${entry.customType}): [unserializable]`);
      }
    }
  }

  // Redact and clip each candidate before packing, so the budget reflects what is actually sent.
  const bounded = items.map((item) =>
    redact(item).text.slice(0, MAX_ITEM_CHARS),
  );
  return packRecentRecords(bounded, {
    maxChars,
    maxItems,
    identity: (record) => record.replace(/\r\n/g, "\n").trim(),
  });
}
