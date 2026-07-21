import { ADVISOR_MAX_OUTPUT_TOKENS } from "./advisor.ts";
import type { EvidenceRef } from "./evidence.ts";
import { redact } from "./redact.ts";

export type SectionAllocation = {
  estimatedTokens: number;
  includedRecords: number;
  omittedRecords: number;
  truncated: boolean;
};
export type DuplicateTelemetry = { records: number; chars: number };
export type Snapshot = {
  text: string;
  estimatedTokens: number;
  redactionCount: number;
  truncated: boolean;
  requiredContextOmitted: boolean;
  omittedEvidence: EvidenceRef[];
  sectionAllocations: Record<string, SectionAllocation>;
  duplicateTelemetry: DuplicateTelemetry;
};
const CHARS_PER_TOKEN = 4;
const MAX_INPUT_TOKENS = 32_768;

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
function normalizedRecord(record: string): string {
  return redact(record).text.replace(/\r\n/g, "\n").trim();
}
function normalizedPayload(record: string): string {
  const clean = record.replace(/\r\n/g, "\n").trim();
  return /^\[[^\n]+\]\n/.test(clean) ? clean.slice(clean.indexOf("\n") + 1).trim() : clean;
}
function dedupeRecords(records: string[], telemetry: DuplicateTelemetry): string[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const identity = normalizedRecord(record);
    if (!identity || seen.has(identity)) {
      telemetry.records++;
      telemetry.chars += record.length;
      return false;
    }
    seen.add(identity);
    return true;
  });
}
function dedupeAcrossSections(records: string[], seen: Set<string>, telemetry: DuplicateTelemetry): string[] {
  return records.filter((record) => {
    const identity = normalizedPayload(record);
    if (!identity || seen.has(identity)) {
      telemetry.records++;
      telemetry.chars += record.length;
      return false;
    }
    return true;
  });
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

const commonWords = new Set(["about", "after", "before", "from", "into", "that", "the", "this", "with", "your"]);
function terms(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? []).filter(term => !commonWords.has(term)));
}
function relevance(message: any, query: Set<string>): number {
  const ref = message?.evidenceRef as EvidenceRef | undefined;
  const metadata = terms(`${ref?.claim ?? ""} ${(ref?.claims ?? []).join(" ")} ${ref?.path ?? ""}`);
  const body = terms(contentText(message?.content));
  const metadataMatches = [...metadata].filter(term => query.has(term)).length;
  const bodyMatches = [...body].filter(term => query.has(term)).length;
  return metadataMatches * 4 + bodyMatches - (message?.evidenceUnavailable ? 1_000 : 0);
}
function evidenceMarker(refs: readonly EvidenceRef[], omittedCount: number, maxChars = Infinity): string {
  const generic = `[Omitted evidence: ${omittedCount} complete record${omittedCount === 1 ? "" : "s"}.]`;
  if (generic.length > maxChars) return "";
  const anchors: string[] = [];
  for (const ref of refs) {
    const anchor = `${ref.path.replace(/[\r\n\t<>]/g, "")}:${ref.start}-${ref.end}`;
    const candidate = `[Omitted evidence available for focused retrieval: ${[...anchors, anchor].join(", ")}.]`;
    if (candidate.length > maxChars) break;
    anchors.push(anchor);
  }
  return anchors.length
    ? `[Omitted evidence available for focused retrieval: ${anchors.join(", ")}.]`
    : generic;
}

export function advisorMaxTokens(contextWindow: number): number {
  const window = Number.isFinite(contextWindow)
    ? Math.max(512, Math.floor(contextWindow))
    : 8_192;
  return Math.max(128, Math.min(ADVISOR_MAX_OUTPUT_TOKENS, Math.floor(window * 0.25)));
}

export function buildSnapshot(systemPrompt: string, messages: any[], contextWindow: number, reservedInputTokens = 0): Snapshot {
  const window = Number.isFinite(contextWindow)
      ? Math.max(512, Math.floor(contextWindow))
      : 8_192,
    reserved = Math.max(0, reservedInputTokens),
    tokenBudget = Math.max(
      0,
      Math.min(
        MAX_INPUT_TOKENS - reserved,
        Math.floor(window * 0.7) - reserved,
        window - advisorMaxTokens(window) - 256 - reserved,
      ),
    );
  const charBudget = tokenBudget * CHARS_PER_TOKEN;
  const duplicateTelemetry: DuplicateTelemetry = { records: 0, chars: 0 };
  const globalSeen = new Set<string>();
  const localUnique = (records: string[]) => dedupeRecords(records, duplicateTelemetry);
  const request = localUnique(messages.filter(message => message?.role === "custom" && message.customType === "advisor-request").slice(-1).map(serializeMessage));
  const query = terms(request.join("\n"));
  const evidenceSeen = new Set<string>();
  const evidenceMessages = messages
    .filter(message => message?.role === "custom" && message.customType === "advisor-evidence")
    .map((message, index) => ({ message, index, text: serializeMessage(message) }))
    .filter((candidate) => {
      const identity = JSON.stringify([normalizedRecord(candidate.text), candidate.message?.evidenceRef ?? null]);
      if (evidenceSeen.has(identity)) {
        duplicateTelemetry.records++;
        duplicateTelemetry.chars += candidate.text.length;
        return false;
      }
      evidenceSeen.add(identity);
      // Evidence provenance is part of identity: equal excerpts at different ranges stay distinct.
      return true;
    })
    .sort((a, b) => relevance(b.message, query) - relevance(a.message, query) || b.index - a.index);
  const continuity = localUnique(messages.filter(message => message?.role === "custom" && message.customType === "pi-continuity").map(serializeMessage));
  const verification = localUnique(messages.filter(message => message?.role === "custom" && message.customType === "pi-verify-result").slice(-1).map(serializeMessage));
  const summaries = localUnique(messages.filter(message => message?.role === "compactionSummary" || message?.role === "branchSummary").map(serializeMessage).reverse());
  const latestUserMessage = [...messages].reverse().find(message => message?.role === "user");
  const latestAssistantMessage = [...messages].reverse().find(message => message?.role === "assistant" && assistantText(message.content));
  const latestUser = latestUserMessage ? localUnique([serializeMessage(latestUserMessage)]) : [];
  const latestAssistant = latestAssistantMessage ? localUnique([`[ASSISTANT]\n${assistantText(latestAssistantMessage.content)}`]) : [];
  const system = systemPrompt ? [systemPrompt] : [];
  const sectionSize = (label: string, records: string[]) => records.length
    ? `<${label}>\n${records.join("\n\n")}\n</${label}>`.length + 2
    : 0;
  const allocationLabels = [
    "advisor-request", "explicit-evidence", "continuity-state", "latest-verification",
    "session-summaries-newest-first", "latest-user-request", "latest-assistant-judgment",
    "executor-system-prompt",
  ];
  const sectionAllocations = Object.fromEntries(allocationLabels.map(label => [label, {
    estimatedTokens: 0, includedRecords: 0, omittedRecords: 0, truncated: false,
  }])) as Record<string, SectionAllocation>;
  const recordAllocation = (label: string, section: string, includedRecords: number, omittedRecords: number) => {
    sectionAllocations[label] = {
      estimatedTokens: Math.ceil(redact(section).text.length / CHARS_PER_TOKEN),
      includedRecords,
      omittedRecords,
      truncated: omittedRecords > 0,
    };
  };
  const requiredSize = sectionSize("advisor-request", request) + sectionSize("executor-system-prompt", system);
  if (requiredSize > charBudget) {
    recordAllocation("advisor-request", "", 0, request.length);
    recordAllocation("executor-system-prompt", "", 0, system.length);
    return { text: "", estimatedTokens: 0, redactionCount: 0, truncated: true, requiredContextOmitted: true, omittedEvidence: [], sectionAllocations, duplicateTelemetry };
  }

  const sections: string[] = [];
  const omittedEvidence: EvidenceRef[] = [];
  let used = 0;
  let truncated = false;
  const add = (label: string, records: string[], reservedChars = 0, dedupeAcross = true) => {
    if (!records.length) return;
    const candidates = dedupeAcross ? dedupeAcrossSections(records, globalSeen, duplicateTelemetry) : records;
    if (!candidates.length) return;
    const kept: string[] = [];
    for (const record of candidates) {
      const candidate = [...kept, record];
      if (used + sectionSize(label, candidate) + reservedChars <= charBudget) kept.push(record);
      else truncated = true;
    }
    if (!kept.length) {
      recordAllocation(label, "", 0, candidates.length);
      return;
    }
    if (dedupeAcross) for (const record of kept) globalSeen.add(normalizedPayload(record));
    const section = `<${label}>\n${kept.join("\n\n")}\n</${label}>`;
    sections.push(section);
    used += section.length + 2;
    recordAllocation(label, section, kept.length, candidates.length - kept.length);
  };

  const systemSize = sectionSize("executor-system-prompt", system);
  add("advisor-request", request, systemSize);
  if (evidenceMessages.length) {
    const selectEvidence = (reserve: number) => {
      const kept: typeof evidenceMessages = [];
      const omitted: typeof evidenceMessages = [];
      for (const candidate of evidenceMessages) {
        if (used + sectionSize("explicit-evidence", [...kept.map(item => item.text), candidate.text]) + systemSize + reserve <= charBudget) kept.push(candidate);
        else omitted.push(candidate);
      }
      return { kept, omitted };
    };
    const selectedEvidence = selectEvidence(0);
    const kept = selectedEvidence.kept.map(candidate => candidate.text);
    for (const candidate of selectedEvidence.omitted) {
      truncated = true;
      if (candidate.message?.evidenceRef) omittedEvidence.push(candidate.message.evidenceRef);
    }
    let evidenceSection = "";
    if (kept.length) {
      for (const record of kept) globalSeen.add(normalizedPayload(record));
      evidenceSection = `<explicit-evidence>\n${kept.join("\n\n")}\n</explicit-evidence>`;
      sections.push(evidenceSection);
      used += evidenceSection.length + 2;
    }
    const omittedCount = evidenceMessages.length - kept.length;
    recordAllocation("explicit-evidence", evidenceSection, kept.length, omittedCount);
    if (omittedCount) {
      const marker = evidenceMarker(omittedEvidence, omittedCount, Math.max(0, charBudget - used - systemSize));
      if (marker) {
        sections.push(marker);
        used += marker.length + 2;
      }
    }
  }
  add("continuity-state", continuity, systemSize);
  add("latest-verification", verification, systemSize);
  add("session-summaries-newest-first", summaries, systemSize);
  add("latest-user-request", latestUser, systemSize);
  add("latest-assistant-judgment", latestAssistant, systemSize);
  add("executor-system-prompt", system, 0, false);

  const selected = new Set([latestUserMessage, latestAssistantMessage].filter(Boolean));
  if (messages.some(message => !selected.has(message) && !(message?.role === "custom" && (message.customType === "advisor-request" || message.customType === "advisor-evidence" || message.customType === "pi-continuity" || message.customType === "pi-verify-result")) && message?.role !== "compactionSummary" && message?.role !== "branchSummary")) truncated = true;
  const marker = "\n\n[Non-priority, earlier, or oversized executor context omitted.]";
  let raw = sections.join("\n\n");
  if (truncated && raw.length + marker.length <= charBudget) raw += marker;
  const clean = redact(raw);
  return { text: clean.text, estimatedTokens: Math.ceil(clean.text.length / CHARS_PER_TOKEN), redactionCount: clean.count, truncated, requiredContextOmitted: false, omittedEvidence, sectionAllocations, duplicateTelemetry };
}
