import { ADVISOR_MAX_OUTPUT_TOKENS } from "./advisor.ts";
import { redact } from "./redact.ts";

export type Snapshot = { text: string; estimatedTokens: number; redactionCount: number; truncated: boolean };
const CHARS_PER_TOKEN = 4;
const MAX_INPUT_TOKENS = 32_000;
const USER_TOKENS = 8_000;
const EVIDENCE_TOKENS = 8_192;
const CONTINUITY_TOKENS = 4_000;
const VERIFICATION_TOKENS = 1_000;
const SUMMARY_TOKENS = 8_000;
const ASSISTANT_TOKENS = 4_000;
const SYSTEM_TOKENS = 4_000;

function contentText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => part?.type === "text" ? part.text : part?.type === "image" ? "[image omitted]" : part?.type === "thinking" ? "[thinking omitted]" : part?.type === "toolCall" ? `[tool call ${part.name}]` : "[unsupported content omitted]").join("\n");
}
function assistantText(content: any): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.filter(part => part?.type === "text").map(part => part.text).join("\n").trim();
}
export function serializeMessage(message: any): string {
  switch (message?.role) {
    case "user": return `[USER]\n${contentText(message.content)}`;
    case "assistant": return `[ASSISTANT]\n${contentText(message.content)}`;
    case "toolResult": return `[TOOL ${message.toolName ?? "unknown"}]\n${contentText(message.content)}`;
    case "compactionSummary": return `[COMPACTION SUMMARY]\n${message.summary ?? ""}`;
    case "branchSummary": return `[BRANCH SUMMARY]\n${message.summary ?? ""}`;
    case "bashExecution": return `[BASH EXECUTION]\n${message.command ?? ""}\n${message.output ?? ""}`;
    case "custom": return `[CUSTOM ${message.customType ?? "message"}]\n${contentText(message.content)}`;
    default: return `[${String(message?.role ?? "unsupported").toUpperCase()}]\n[unsupported message omitted]`;
  }
}

export function advisorMaxTokens(contextWindow: number): number {
  const window = Number.isFinite(contextWindow)
    ? Math.max(512, Math.floor(contextWindow))
    : 8_192;
  return Math.max(128, Math.min(ADVISOR_MAX_OUTPUT_TOKENS, Math.floor(window * 0.25)));
}

function headTail(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text;
  const marker = `\n[${label} truncated: middle omitted]\n`;
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(available / 2);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - (available - head))}`;
}

export function buildSnapshot(systemPrompt: string, messages: any[], contextWindow: number, reservedInputTokens = 0): Snapshot {
  const window = Number.isFinite(contextWindow)
      ? Math.max(512, Math.floor(contextWindow))
      : 8_192,
    tokenBudget = Math.max(
      128,
      Math.min(
        Math.max(128, MAX_INPUT_TOKENS - Math.max(0, reservedInputTokens)),
        Math.floor(window * 0.7),
        window - advisorMaxTokens(window) - 256,
      ),
    );
  const charBudget = tokenBudget * CHARS_PER_TOKEN;
  const sections: string[] = [];
  let used = 0;
  let truncated = false;
  const add = (label: string, text: string, tokenCap: number) => {
    if (!text) return;
    const header = `<${label}>\n`, footer = `\n</${label}>`;
    const available = Math.min(tokenCap * CHARS_PER_TOKEN, charBudget - used - header.length - footer.length);
    if (available <= 0) { truncated = true; return; }
    const bounded = headTail(text, available, label);
    if (bounded.length < text.length) truncated = true;
    const section = `${header}${bounded}${footer}`;
    sections.push(section);
    used += section.length + 2;
  };

  const evidence = messages.filter(message => message?.role === "custom" && message.customType === "advisor-evidence").map(serializeMessage).join("\n\n");
  const continuity = messages.filter(message => message?.role === "custom" && message.customType === "pi-continuity").map(serializeMessage).join("\n\n");
  const verification = messages.filter(message => message?.role === "custom" && message.customType === "pi-verify-result").map(serializeMessage).slice(-1).join("\n\n");
  const summaries = messages.filter(message => message?.role === "compactionSummary" || message?.role === "branchSummary").map(serializeMessage).reverse().join("\n\n");
  const latestUser = [...messages].reverse().find(message => message?.role === "user");
  const latestAssistant = [...messages].reverse().find(message => message?.role === "assistant" && assistantText(message.content));

  add("explicit-evidence", evidence, EVIDENCE_TOKENS);
  add("continuity-state", continuity, CONTINUITY_TOKENS);
  add("latest-verification", verification, VERIFICATION_TOKENS);
  add("session-summaries-newest-first", summaries, SUMMARY_TOKENS);
  add("latest-user-request", latestUser ? serializeMessage(latestUser) : "", USER_TOKENS);
  add("latest-assistant-judgment", latestAssistant ? `[ASSISTANT]\n${assistantText(latestAssistant.content)}` : "", ASSISTANT_TOKENS);
  add("executor-system-prompt", systemPrompt, SYSTEM_TOKENS);

  const selected = new Set([latestUser, latestAssistant].filter(Boolean));
  if (messages.some(message => !selected.has(message) && !(message?.role === "custom" && (message.customType === "advisor-evidence" || message.customType === "pi-continuity" || message.customType === "pi-verify-result")) && message?.role !== "compactionSummary" && message?.role !== "branchSummary")) truncated = true;
  const marker = truncated ? "\n\n[Non-priority, earlier, or oversized executor context omitted.]" : "";
  let raw = `${sections.join("\n\n")}${marker}`;
  if (raw.length > charBudget) { raw = headTail(raw, charBudget, "advisor snapshot"); truncated = true; }
  const clean = redact(raw);
  return { text: clean.text, estimatedTokens: Math.ceil(clean.text.length / CHARS_PER_TOKEN), redactionCount: clean.count, truncated };
}
