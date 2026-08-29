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
  return content
    .map(part =>
      part?.type === "text"
        ? part.text
        : part?.type === "image"
          ? "[image omitted]"
          : part?.type === "thinking"
            ? "[thinking omitted]"
            : part?.type === "toolCall"
              ? `[tool call ${part.name}]`
              : "[unsupported content omitted]",
    )
    .join("\n");
}
function assistantText(content: any): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter(part => part?.type === "text")
    .map(part => part.text)
    .join("\n")
    .trim();
}
function normalizedRecord(record: string): string {
  return redact(record).text.replace(/\r\n/g, "\n").trim();
}
function normalizedPayload(record: string): string {
  const clean = record.replace(/\r\n/g, "\n").trim();
  return /^\[[^\n]+\]\n/.test(clean) ? clean.slice(clean.indexOf("\n") + 1).trim() : clean;
}
type DedupeOptions = {
  seen: Set<string>;
  identity: (record: string) => string;
  /** Cross-section dedupe defers remembering until a record is actually packed. */
  remember: boolean;
};
function dedupe(records: string[], telemetry: DuplicateTelemetry, options: DedupeOptions): string[] {
  return records.filter(record => {
    const identity = options.identity(record);
    if (!identity || options.seen.has(identity)) {
      telemetry.records++;
      telemetry.chars += record.length;
      return false;
    }
    if (options.remember) options.seen.add(identity);
    return true;
  });
}
function dedupeRecords(records: string[], telemetry: DuplicateTelemetry): string[] {
  return dedupe(records, telemetry, { seen: new Set(), identity: normalizedRecord, remember: true });
}
/** Drops records whose payload a higher-priority section already packed. */
function dedupeAcrossSections(records: string[], seen: Set<string>, telemetry: DuplicateTelemetry): string[] {
  return dedupe(records, telemetry, { seen, identity: normalizedPayload, remember: false });
}

export function serializeMessage(message: any): string {
  switch (message?.role) {
    case "user":
      return `[USER]\n${contentText(message.content)}`;
    case "assistant":
      return `[ASSISTANT]\n${contentText(message.content)}`;
    case "toolResult":
      return `[TOOL ${message.toolName ?? "unknown"}]\n${contentText(message.content)}`;
    case "compactionSummary":
      return `[COMPACTION SUMMARY]\n${message.summary ?? ""}`;
    case "branchSummary":
      return `[BRANCH SUMMARY]\n${message.summary ?? ""}`;
    case "bashExecution":
      return `[BASH EXECUTION]\n${message.command ?? ""}\n${message.output ?? ""}`;
    case "custom":
      return `[CUSTOM ${message.customType ?? "message"}]\n${contentText(message.content)}`;
    default:
      return `[${String(message?.role ?? "unsupported").toUpperCase()}]\n[unsupported message omitted]`;
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
  return anchors.length ? `[Omitted evidence available for focused retrieval: ${anchors.join(", ")}.]` : generic;
}

function normalizedWindow(contextWindow: number): number {
  return Number.isFinite(contextWindow) ? Math.max(512, Math.floor(contextWindow)) : 8_192;
}

export function advisorMaxTokens(contextWindow: number): number {
  const window = normalizedWindow(contextWindow);
  return Math.max(128, Math.min(ADVISOR_MAX_OUTPUT_TOKENS, Math.floor(window * 0.25)));
}

/** Input tokens the snapshot may occupy: the global cap, a share of the window, and room for output. */
function snapshotTokenBudget(contextWindow: number, reservedInputTokens: number): number {
  const window = normalizedWindow(contextWindow);
  const reserved = Math.max(0, reservedInputTokens);
  return Math.max(
    0,
    Math.min(
      MAX_INPUT_TOKENS - reserved,
      Math.floor(window * 0.7) - reserved,
      window - advisorMaxTokens(window) - 256 - reserved,
    ),
  );
}

function sectionSize(label: string, records: readonly string[]): number {
  return records.length ? `<${label}>\n${records.join("\n\n")}\n</${label}>`.length + 2 : 0;
}

function fitRecords<T>(
  label: string,
  items: readonly T[],
  textOf: (item: T) => string,
  used: number,
  charBudget: number,
): { kept: T[]; omitted: T[] } {
  const kept: T[] = [];
  const omitted: T[] = [];
  for (const item of items) {
    const candidate = [...kept.map(textOf), textOf(item)];
    if (used + sectionSize(label, candidate) <= charBudget) kept.push(item);
    else omitted.push(item);
  }
  return { kept, omitted };
}

const SECTION_LABELS = [
  "advisor-request",
  "explicit-evidence",
  "continuity-state",
  "latest-verification",
  "session-summaries-newest-first",
  "latest-user-request",
  "latest-assistant-judgment",
] as const;
const PACKED_CUSTOM_TYPES = new Set(["advisor-request", "advisor-evidence", "pi-continuity", "pi-verify-result"]);
const PACKED_ROLES = new Set(["compactionSummary", "branchSummary"]);

function customRecords(messages: any[], customType: string, latestOnly = false): string[] {
  const matches = messages.filter(message => message?.role === "custom" && message.customType === customType);
  return (latestOnly ? matches.slice(-1) : matches).map(serializeMessage);
}

type EvidenceCandidate = { message: any; index: number; text: string };
function rankedEvidence(messages: any[], query: Set<string>, telemetry: DuplicateTelemetry): EvidenceCandidate[] {
  const seen = new Set<string>();
  return messages
    .filter(message => message?.role === "custom" && message.customType === "advisor-evidence")
    .map((message, index) => ({ message, index, text: serializeMessage(message) }))
    .filter(candidate => {
      // Evidence provenance is part of identity: equal excerpts at different ranges stay distinct.
      const identity = JSON.stringify([normalizedRecord(candidate.text), candidate.message?.evidenceRef ?? null]);
      if (seen.has(identity)) {
        telemetry.records++;
        telemetry.chars += candidate.text.length;
        return false;
      }
      seen.add(identity);
      return true;
    })
    .sort((a, b) => relevance(b.message, query) - relevance(a.message, query) || b.index - a.index);
}

export function buildSnapshot(messages: any[], contextWindow: number, reservedInputTokens = 0): Snapshot {
  const charBudget = snapshotTokenBudget(contextWindow, reservedInputTokens) * CHARS_PER_TOKEN;
  const duplicateTelemetry: DuplicateTelemetry = { records: 0, chars: 0 };
  const localUnique = (records: string[]) => dedupeRecords(records, duplicateTelemetry);

  const request = localUnique(customRecords(messages, "advisor-request", true));
  const evidenceMessages = rankedEvidence(messages, terms(request.join("\n")), duplicateTelemetry);
  const continuity = localUnique(customRecords(messages, "pi-continuity"));
  const verification = localUnique(customRecords(messages, "pi-verify-result", true));
  const summaries = localUnique(
    messages
      .filter(message => PACKED_ROLES.has(message?.role))
      .map(serializeMessage)
      .reverse(),
  );
  const latestUserMessage = [...messages].reverse().find(message => message?.role === "user");
  const latestAssistantMessage = [...messages]
    .reverse()
    .find(message => message?.role === "assistant" && assistantText(message.content));
  const latestUser = latestUserMessage ? localUnique([serializeMessage(latestUserMessage)]) : [];
  const latestAssistant = latestAssistantMessage
    ? localUnique([`[ASSISTANT]\n${assistantText(latestAssistantMessage.content)}`])
    : [];

  const sectionAllocations = Object.fromEntries(
    SECTION_LABELS.map(label => [
      label,
      { estimatedTokens: 0, includedRecords: 0, omittedRecords: 0, truncated: false },
    ]),
  ) as Record<string, SectionAllocation>;
  const recordAllocation = (label: string, section: string, includedRecords: number, omittedRecords: number) => {
    sectionAllocations[label] = {
      estimatedTokens: Math.ceil(redact(section).text.length / CHARS_PER_TOKEN),
      includedRecords,
      omittedRecords,
      truncated: omittedRecords > 0,
    };
  };
  if (sectionSize("advisor-request", request) > charBudget) {
    recordAllocation("advisor-request", "", 0, request.length);
    return {
      text: "",
      estimatedTokens: 0,
      redactionCount: 0,
      truncated: true,
      requiredContextOmitted: true,
      omittedEvidence: [],
      sectionAllocations,
      duplicateTelemetry,
    };
  }

  const globalSeen = new Set<string>();
  const sections: string[] = [];
  const omittedEvidence: EvidenceRef[] = [];
  let used = 0;
  let truncated = false;
  const pushSection = (label: string, kept: string[], omittedRecords: number) => {
    if (!kept.length) {
      recordAllocation(label, "", 0, omittedRecords);
      return;
    }
    for (const record of kept) globalSeen.add(normalizedPayload(record));
    const section = `<${label}>\n${kept.join("\n\n")}\n</${label}>`;
    sections.push(section);
    used += section.length + 2;
    recordAllocation(label, section, kept.length, omittedRecords);
  };
  const add = (label: string, records: string[]) => {
    if (!records.length) return;
    const candidates = dedupeAcrossSections(records, globalSeen, duplicateTelemetry);
    if (!candidates.length) return;
    const { kept, omitted } = fitRecords(label, candidates, record => record, used, charBudget);
    if (omitted.length) truncated = true;
    pushSection(label, kept, omitted.length);
  };
  const addEvidence = () => {
    const { kept, omitted } = fitRecords("explicit-evidence", evidenceMessages, item => item.text, used, charBudget);
    for (const candidate of omitted) {
      truncated = true;
      if (candidate.message?.evidenceRef) omittedEvidence.push(candidate.message.evidenceRef);
    }
    pushSection(
      "explicit-evidence",
      kept.map(item => item.text),
      omitted.length,
    );
    if (!omitted.length) return;
    const marker = evidenceMarker(omittedEvidence, omitted.length, Math.max(0, charBudget - used));
    if (!marker) return;
    sections.push(marker);
    used += marker.length + 2;
  };

  add("advisor-request", request);
  if (evidenceMessages.length) addEvidence();
  add("continuity-state", continuity);
  add("latest-verification", verification);
  add("session-summaries-newest-first", summaries);
  add("latest-user-request", latestUser);
  add("latest-assistant-judgment", latestAssistant);

  const selected = new Set([latestUserMessage, latestAssistantMessage].filter(Boolean));
  const isPacked = (message: any) =>
    selected.has(message) ||
    PACKED_ROLES.has(message?.role) ||
    (message?.role === "custom" && PACKED_CUSTOM_TYPES.has(message.customType));
  if (messages.some(message => !isPacked(message))) truncated = true;
  const marker = "\n\n[Non-priority, earlier, or oversized executor context omitted.]";
  let raw = sections.join("\n\n");
  if (truncated && raw.length + marker.length <= charBudget) raw += marker;
  const clean = redact(raw);
  return {
    text: clean.text,
    estimatedTokens: Math.ceil(clean.text.length / CHARS_PER_TOKEN),
    redactionCount: clean.count,
    truncated,
    requiredContextOmitted: false,
    omittedEvidence,
    sectionAllocations,
    duplicateTelemetry,
  };
}
