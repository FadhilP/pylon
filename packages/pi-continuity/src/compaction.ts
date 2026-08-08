import { createHash } from "node:crypto";
import {
  findCutPoint,
  type CompactionResult,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Work } from "./active-work.ts";
import { assertSafe, sanitizeAndClip } from "./secrets.ts";
import { HANDOFF_ENTRY_TYPE } from "./run.ts";

// Inspired by pi-blackhole's structural summaries, without its runtime, workers, or aggressive cut policy.
export const CONTINUITY_COMPACTION_TYPE = "pi-continuity-compaction";
export const CONTINUITY_COMPACTION_VERSION = 3;
export const MAX_COMPACTION_SUMMARY_CHARS = 24_000;
export const MAX_CANONICAL_SUMMARY_CHARS = 20_000;
export const MAX_SUPPLEMENT_SUMMARY_CHARS = MAX_COMPACTION_SUMMARY_CHARS - MAX_CANONICAL_SUMMARY_CHARS;
const LEGACY_COMPACTION_VERSION = 1;
const STRUCTURED_COMPACTION_VERSION = 2;
const MAX_CURRENT_REQUEST_CHARS = 12_000;
const MAX_HISTORY_ITEMS = 12;
const MAX_HISTORY_PATH_CHARS = 540;
const MAX_SOURCE_ENTRY_ID_CHARS = 240;
const MAX_GENERIC_RECORDS = 20;
const MAX_GENERIC_RECORD_CHARS = 2_000;
const MAX_SUPPLEMENTS = 8;
const MAX_SUPPLEMENT_QUOTE_CHARS = 800;
const SECTION_ORDER = ["Current Task", "Current Work", "Best-effort Observed File Activity"] as const;

export type HistoryKind = "read" | "modified";
export type CompactionHistoryRecord = {
  path: string;
  sourceEntryId?: string;
};
export type CompactionHistory = Record<HistoryKind, CompactionHistoryRecord[]>;
export type GenericCompactionRole = "user" | "assistant" | "tool" | "summary";
export type GenericCompactionRecord = {
  sourceEntryId: string;
  role: GenericCompactionRole;
  text: string;
  isError?: boolean;
};
export type CompactionReviewRole = "user" | "assistant" | "tool";
export type CompactionReviewCategory = "constraint" | "decision" | "error" | "outcome" | "context";
export type CompactionSupplement = {
  sourceEntryId: string;
  role: CompactionReviewRole;
  category: CompactionReviewCategory;
  quote: string;
  sourceHash: string;
  quoteHash: string;
};
export type CompactionReviewSource = {
  sourceEntryId: string;
  role: CompactionReviewRole;
  content: string;
  sourceHash: string;
  isError?: boolean;
};

type CompactionDetailsBase = {
  type: typeof CONTINUITY_COMPACTION_TYPE;
  version: typeof CONTINUITY_COMPACTION_VERSION;
  mode: "active-work" | "generic";
  sourceEntryCount: number;
  history: CompactionHistory;
  supplements: CompactionSupplement[];
  currentTaskEntryId?: string;
};
export type ActiveWorkCompactionDetails = CompactionDetailsBase & {
  mode: "active-work";
  runId: string;
  timelineId: string;
  handoffEntryId?: string;
};
export type GenericContinuityCompactionDetails = CompactionDetailsBase & {
  mode: "generic";
  records: GenericCompactionRecord[];
};
export type ContinuityCompactionDetails = ActiveWorkCompactionDetails | GenericContinuityCompactionDetails;

type LegacyCompactionDetails = {
  type: typeof CONTINUITY_COMPACTION_TYPE;
  version: typeof LEGACY_COMPACTION_VERSION;
  runId: string;
  timelineId: string;
  handoffEntryId?: string;
  currentTaskEntryId?: string;
  sourceEntryCount: number;
};
type StructuredCompactionDetails = Omit<ActiveWorkCompactionDetails, "version" | "mode" | "supplements"> & {
  version: typeof STRUCTURED_COMPACTION_VERSION;
};
type AnyCompactionDetails = LegacyCompactionDetails | StructuredCompactionDetails | ContinuityCompactionDetails;

export type CompactionVerification = {
  state: string;
  scope?: string;
  runId?: string;
  worktreeId?: string;
};

type Preparation = {
  firstKeptEntryId: string;
  tokensBefore: number;
  settings: { keepRecentTokens: number };
};

type BuildInput = {
  branchEntries: SessionEntry[];
  preparation: Preparation;
  work: Work;
  verification?: CompactionVerification;
};

type DraftInput = {
  branchEntries: SessionEntry[];
  preparation: Preparation;
  work?: Work;
  verification?: CompactionVerification;
};

type SummaryRecord = {
  section: typeof SECTION_ORDER[number];
  text: string;
  priority: number;
  order: number;
  required?: boolean;
};

type BuiltDraft = {
  canonical: CompactionResult<ContinuityCompactionDetails>;
  priorSupplements: CompactionSupplement[];
  sourceStart: number;
  firstKeptIndex: number;
};

export type ContinuityCompactionDraft = {
  canonical: CompactionResult<ContinuityCompactionDetails>;
  priorSupplements: CompactionSupplement[];
  reviewSources: CompactionReviewSource[];
};

export type ContinuityBoundaryIdentity = { runId: string; timelineId: string; handoffEntryId?: string };
export type ContinuityBoundaryResolution =
  | { proof: "handoff"; identity: ContinuityBoundaryIdentity; handoffIndex: number }
  | { proof: "identity"; source: "compaction" | "work"; identity: ContinuityBoundaryIdentity }
  | { proof: "unproven"; reason: string };

const emptyHistory = (): CompactionHistory => ({ read: [], modified: [] });
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const validHash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function validHistoryRecord(value: any) {
  return Boolean(
    value && typeof value.path === "string" && value.path &&
      value.path.length <= MAX_HISTORY_PATH_CHARS &&
      (value.sourceEntryId === undefined ||
        (typeof value.sourceEntryId === "string" && value.sourceEntryId.length <= MAX_SOURCE_ENTRY_ID_CHARS)),
  );
}

function validHistory(value: any) {
  return Boolean(
    value && Array.isArray(value.read) && value.read.length <= MAX_HISTORY_ITEMS && value.read.every(validHistoryRecord) &&
      Array.isArray(value.modified) && value.modified.length <= MAX_HISTORY_ITEMS && value.modified.every(validHistoryRecord),
  );
}

function validGenericRecord(value: any) {
  return Boolean(
    value && typeof value.sourceEntryId === "string" && value.sourceEntryId && value.sourceEntryId.length <= MAX_SOURCE_ENTRY_ID_CHARS &&
      ["user", "assistant", "tool", "summary"].includes(value.role) &&
      typeof value.text === "string" && value.text && value.text.length <= MAX_GENERIC_RECORD_CHARS &&
      (value.isError === undefined || typeof value.isError === "boolean"),
  );
}

function validSupplement(value: any) {
  return Boolean(
    value && typeof value.sourceEntryId === "string" && value.sourceEntryId && value.sourceEntryId.length <= MAX_SOURCE_ENTRY_ID_CHARS &&
      ["user", "assistant", "tool"].includes(value.role) &&
      ["constraint", "decision", "error", "outcome", "context"].includes(value.category) &&
      typeof value.quote === "string" && value.quote && value.quote.length <= MAX_SUPPLEMENT_QUOTE_CHARS &&
      validHash(value.sourceHash) && validHash(value.quoteHash) && value.quoteHash === sha256(value.quote),
  );
}

function validLegacyBase(value: any) {
  return Boolean(
    value?.type === CONTINUITY_COMPACTION_TYPE &&
      typeof value.runId === "string" && value.runId && value.runId.length <= MAX_SOURCE_ENTRY_ID_CHARS &&
      typeof value.timelineId === "string" && value.timelineId && value.timelineId.length <= MAX_SOURCE_ENTRY_ID_CHARS &&
      Number.isInteger(value.sourceEntryCount) && value.sourceEntryCount >= 0 &&
      (value.handoffEntryId === undefined || typeof value.handoffEntryId === "string" && value.handoffEntryId.length <= MAX_SOURCE_ENTRY_ID_CHARS) &&
      (value.currentTaskEntryId === undefined || typeof value.currentTaskEntryId === "string" && value.currentTaskEntryId.length <= MAX_SOURCE_ENTRY_ID_CHARS),
  );
}

export function isContinuityCompactionDetails(value: unknown): value is AnyCompactionDetails {
  const details = value as any;
  if (details?.type !== CONTINUITY_COMPACTION_TYPE || ![1, 2, 3].includes(details.version)) return false;
  if (details.version === LEGACY_COMPACTION_VERSION) return validLegacyBase(details);
  if (details.version === STRUCTURED_COMPACTION_VERSION) return validLegacyBase(details) && validHistory(details.history);
  if (
    !["active-work", "generic"].includes(details.mode) ||
    !Number.isInteger(details.sourceEntryCount) || details.sourceEntryCount < 0 ||
    !validHistory(details.history) || !Array.isArray(details.supplements) || details.supplements.length > MAX_SUPPLEMENTS ||
    !details.supplements.every(validSupplement) ||
    (details.currentTaskEntryId !== undefined && (typeof details.currentTaskEntryId !== "string" || details.currentTaskEntryId.length > MAX_SOURCE_ENTRY_ID_CHARS))
  ) return false;
  if (details.mode === "active-work") return validLegacyBase(details);
  return Array.isArray(details.records) && details.records.length <= MAX_GENERIC_RECORDS && details.records.every(validGenericRecord);
}

function activeDetails(value: unknown): value is LegacyCompactionDetails | StructuredCompactionDetails | ActiveWorkCompactionDetails {
  return isContinuityCompactionDetails(value) && (
    value.version === LEGACY_COMPACTION_VERSION ||
    value.version === STRUCTURED_COMPACTION_VERSION ||
    value.version === CONTINUITY_COMPACTION_VERSION && value.mode === "active-work"
  );
}

function handoffIdentity(entry: SessionEntry): ContinuityBoundaryIdentity | undefined {
  if (entry.type !== "custom_message" || entry.customType !== HANDOFF_ENTRY_TYPE) return;
  const details = entry.details as any;
  if (
    details?.version !== 1 ||
    typeof details.runId !== "string" || !details.runId ||
    typeof details.timelineId !== "string" || !details.timelineId
  ) return;
  return {
    runId: details.runId,
    timelineId: details.timelineId,
    ...(typeof entry.id === "string" && entry.id ? { handoffEntryId: entry.id } : {}),
  };
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");
}

function safe(value: string, max: number) {
  return sanitizeAndClip(value, max);
}

function inline(value: string, max = 500) {
  return safe(value.replace(/\s+/g, " ").trim(), max);
}

function fenced(value: string) {
  const longest = (character: "`" | "~") => Math.max(0, ...(value.match(character === "`" ? /`+/g : /~+/g) ?? []).map((run) => run.length));
  const backticks = longest("`");
  const tildes = longest("~");
  const character = backticks <= tildes ? "`" : "~";
  const fence = character.repeat(Math.max(3, Math.min(backticks, tildes) + 1));
  return `${fence}text\n${value}\n${fence}`;
}

function addHistory(history: CompactionHistory, kind: HistoryKind, path: string, sourceEntryId?: string) {
  const record: CompactionHistoryRecord = {
    path: inline(path),
    ...(sourceEntryId ? { sourceEntryId: inline(sourceEntryId, 200) } : {}),
  };
  if (!record.path) return;
  const records = history[kind];
  const existing = records.findIndex((item) => item.path === record.path);
  if (existing >= 0) records.splice(existing, 1);
  records.push(record);
  if (records.length > MAX_HISTORY_ITEMS) records.shift();
}

function legacySection(summary: string, heading: string) {
  if (!summary.startsWith("# Continuity Compaction v1\n")) return [];
  const marker = `### ${heading}\n`;
  const start = summary.indexOf(marker);
  if (start < 0) return [];
  const contentStart = start + marker.length;
  const nextHeading = summary.indexOf("\n### ", contentStart);
  const metadata = summary.indexOf("\n[Compaction Metadata]", contentStart);
  const ends = [nextHeading, metadata].filter((position) => position >= 0);
  const end = ends.length ? Math.min(...ends) : summary.length;
  return summary.slice(contentStart, end).split("\n")
    .filter((line) => line.startsWith("- ") && line !== "- (none)")
    .map((line) => line.slice(2));
}

function previousHistory(previous: Extract<SessionEntry, { type: "compaction" }> | undefined) {
  const history = emptyHistory();
  const details = previous?.details;
  if (!isContinuityCompactionDetails(details)) return history;
  if (details.version === STRUCTURED_COMPACTION_VERSION || details.version === CONTINUITY_COMPACTION_VERSION) {
    for (const kind of ["read", "modified"] as const)
      for (const record of details.history[kind]) addHistory(history, kind, record.path, record.sourceEntryId);
    return history;
  }
  for (const path of legacySection(previous?.summary ?? "", "Files read")) addHistory(history, "read", path);
  for (const path of legacySection(previous?.summary ?? "", "Files modified")) addHistory(history, "modified", path);
  return history;
}

function toolCalls(entry: SessionEntry): any[] {
  if (entry.type !== "message" || entry.message.role !== "assistant") return [];
  const content = (entry.message as any).content;
  return Array.isArray(content) ? content.filter((part: any) => part?.type === "toolCall") : [];
}

function toolPath(call: any): string | undefined {
  const args = call?.arguments;
  if (!args || typeof args !== "object") return;
  for (const key of ["path", "filePath", "file", "target"])
    if (typeof args[key] === "string" && args[key]) return args[key];
}

function collectEntry(history: CompactionHistory, entry: SessionEntry) {
  for (const call of toolCalls(entry)) {
    const name = typeof call.name === "string" ? call.name : "";
    const path = toolPath(call);
    if (!path) continue;
    if (["read", "rg", "grep", "fd", "find"].includes(name)) addHistory(history, "read", path, entry.id);
    if (["edit", "write"].includes(name)) addHistory(history, "modified", path, entry.id);
  }
}

function latestUserIndex(entries: SessionEntry[], after: number) {
  for (let index = entries.length - 1; index > after; index--) {
    const entry = entries[index];
    if (entry.type === "message" && entry.message.role === "user") return index;
  }
  return -1;
}

function recordsFor(work: Work, currentRequest: string, currentRequestRetained: boolean, history: CompactionHistory, verification?: CompactionVerification) {
  let order = 0;
  const records: SummaryRecord[] = [];
  const add = (section: SummaryRecord["section"], text: string, priority: number, required = false) =>
    records.push({ section, text, priority, required, order: order++ });

  add("Current Task", currentRequestRetained
    ? "> Latest in-scope user request retained verbatim at the compaction cut."
    : `**Latest in-scope user request** _(verbatim unless credential redaction or the size limit applies)_\n\n${fenced(safe(currentRequest || "(no in-scope user request)", MAX_CURRENT_REQUEST_CHARS))}`, 1_000, true);
  add("Current Work", `Goal: ${safe(work.goal || "(not specified)", 2_000)}`, 990, true);
  if (work.latestFailure) add("Current Work", `Blocker: ${safe(work.latestFailure, 1_000)}`, 980);
  if (work.nextAction) add("Current Work", `Next action: ${safe(work.nextAction, 1_000)}`, 970);
  if (verification?.state) {
    const qualifiers = [
      verification.scope ? `scope=${inline(verification.scope, 100)}` : "",
      verification.runId ? `run=${inline(verification.runId, 200)}` : "",
      verification.worktreeId ? `worktree=${inline(verification.worktreeId, 100)}` : "",
    ].filter(Boolean).join(", ");
    add("Current Work", `Verification: ${inline(verification.state, 100)}${qualifiers ? ` (${qualifiers})` : ""}`, 960);
  }
  add("Current Work", `Plan: ${safe(work.planSummary || "(not specified)", 4_000)}`, 950);
  for (const value of work.handoff?.workingSet ?? []) add("Current Work", `Working set: ${safe(value, 240)}`, 948);
  for (const value of work.handoff?.assumptions ?? []) add("Current Work", `Assumption/gap: ${safe(value, 500)}`, 947);
  for (const value of work.handoff?.acceptanceCriteria ?? []) add("Current Work", `Acceptance: ${safe(value, 500)}`, 946);
  if (work.revisionFeedback) add("Current Work", `Revision feedback (plan ${work.revisionFeedback.revision}): ${safe(work.revisionFeedback.text, 1_000)}`, 949);

  if (!work.todos.length) add("Current Work", "Todos: (none)", 940);
  const currentTodo = work.todos.find((todo) => todo.id === work.currentTodoId);
  const todos = work.todos.slice(0, 12);
  if (currentTodo && !todos.includes(currentTodo)) todos.splice(11, 1, currentTodo);
  for (const todo of todos) {
    const current = todo === currentTodo ? " current" : "";
    add("Current Work", `Todo ${inline(todo.id, 100)} [${todo.status}${current}]: ${safe(todo.text, 300)}`, current ? 945 : 930);
  }

  if (!work.constraints.length) add("Current Work", "Constraints: (none)", 900);
  for (const constraint of work.constraints.slice(0, 12)) add("Current Work", `Constraint: ${safe(constraint, 300)}`, 900);
  for (const record of history.modified) add("Best-effort Observed File Activity", `Attempted modification: ${record.path}${record.sourceEntryId ? ` (entry ${record.sourceEntryId})` : ""}`, 200);
  for (const record of history.read) add("Best-effort Observed File Activity", `Read/search: ${record.path}${record.sourceEntryId ? ` (entry ${record.sourceEntryId})` : ""}`, 100);
  return records;
}

function renderActiveSummary(records: SummaryRecord[], metadata: string) {
  const sections = SECTION_ORDER.flatMap((section) => {
    const values = records.filter((record) => record.section === section).sort((a, b) => a.order - b.order);
    const content = section === "Current Task"
      ? values.map((record) => record.text).join("\n\n")
      : values.map((record) => `- ${record.text.replace(/\n/g, "\n    ")}`).join("\n");
    return values.length ? [`## ${section}\n\n${content}`] : [];
  });
  return `# Continuity Compaction v3\n\n${sections.join("\n\n")}\n\n${metadata}`;
}

function buildActiveSummary(records: SummaryRecord[], metadata: string) {
  const selected = records.filter((record) => record.required);
  if (renderActiveSummary(selected, metadata).length > MAX_CANONICAL_SUMMARY_CHARS) return;
  const optional = records.filter((record) => !record.required)
    .sort((left, right) => right.priority - left.priority || left.order - right.order);
  for (const record of optional) {
    const candidate = [...selected, record];
    if (renderActiveSummary(candidate, metadata).length <= MAX_CANONICAL_SUMMARY_CHARS) selected.push(record);
  }
  return renderActiveSummary(selected, metadata);
}

function matchesWork(identity: ContinuityBoundaryIdentity, work: Work) {
  return identity.runId === work.runId && identity.timelineId === work.timelineId;
}

export function resolveContinuityBoundary(entries: SessionEntry[], work: Work): ContinuityBoundaryResolution {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom_message" || entry.customType !== HANDOFF_ENTRY_TYPE) continue;
    const identity = handoffIdentity(entry);
    return identity && matchesWork(identity, work)
      ? { proof: "handoff", identity, handoffIndex: index }
      : { proof: "unproven", reason: "latest Continuity handoff is malformed or does not match active Work" };
  }
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "compaction") continue;
    const markedContinuity = (entry.details as any)?.type === CONTINUITY_COMPACTION_TYPE;
    if (!isContinuityCompactionDetails(entry.details)) {
      if (markedContinuity) return { proof: "unproven", reason: "latest Continuity compaction metadata is malformed" };
      continue;
    }
    if (!activeDetails(entry.details)) continue;
    const identity = { runId: entry.details.runId, timelineId: entry.details.timelineId, handoffEntryId: entry.details.handoffEntryId };
    return matchesWork(identity, work)
      ? { proof: "identity", source: "compaction", identity }
      : { proof: "unproven", reason: "latest Continuity compaction does not match active Work" };
  }
  if (work.runId && work.timelineId) return { proof: "identity", source: "work", identity: { runId: work.runId, timelineId: work.timelineId } };
  return { proof: "unproven", reason: "active Continuity identity is unavailable" };
}

function isSafeCutEntry(entry: SessionEntry | undefined) {
  if (!entry) return false;
  if (entry.type === "message") return entry.message.role !== "toolResult";
  return ["custom", "custom_message", "branch_summary"].includes(entry.type);
}

function validCut(branchEntries: SessionEntry[], sourceStart: number, requestedIndex: number, preparation: Preparation) {
  let firstKeptIndex = requestedIndex;
  let selected = branchEntries[firstKeptIndex];
  if (typeof selected?.id !== "string" || !selected.id || !isSafeCutEntry(selected)) {
    const preparedIndex = branchEntries.findIndex((entry) => entry.id === preparation.firstKeptEntryId);
    if (preparedIndex < sourceStart || !isSafeCutEntry(branchEntries[preparedIndex])) return;
    firstKeptIndex = preparedIndex;
    selected = branchEntries[firstKeptIndex];
  }
  return { firstKeptIndex, firstKeptEntryId: selected.id };
}

function sourceText(entry: SessionEntry): { role: CompactionReviewRole; content: string; isError?: boolean } | undefined {
  if (entry.type !== "message") return;
  const role = entry.message.role;
  if (role === "user" || role === "assistant") {
    const content = safe(textContent((entry.message as any).content), 4_000);
    return content ? { role, content } : undefined;
  }
  if (role === "toolResult") {
    const content = safe(textContent((entry.message as any).content), 4_000);
    return content ? { role: "tool", content, ...((entry.message as any).isError ? { isError: true } : {}) } : undefined;
  }
}

function reviewSources(entries: SessionEntry[], sourceStart: number, firstKeptIndex: number) {
  return entries.slice(sourceStart, firstKeptIndex).flatMap((entry) => {
    const source = sourceText(entry);
    return source && typeof entry.id === "string" && entry.id
      ? [{ sourceEntryId: entry.id, ...source, sourceHash: sha256(source.content) }]
      : [];
  });
}

function retainedSupplements(previous: Extract<SessionEntry, { type: "compaction" }> | undefined, entries: SessionEntry[]) {
  if (!previous || !isContinuityCompactionDetails(previous.details) || previous.details.version !== CONTINUITY_COMPACTION_VERSION) return [];
  const sources = new Map(reviewSources(entries, 0, entries.length).map((source) => [source.sourceEntryId, source]));
  return previous.details.supplements.filter((supplement) => {
    const source = sources.get(supplement.sourceEntryId);
    return source && source.role === supplement.role && source.sourceHash === supplement.sourceHash &&
      source.content.includes(supplement.quote) && sha256(supplement.quote) === supplement.quoteHash;
  });
}

function buildActiveDraft({ branchEntries, preparation, work, verification }: BuildInput): BuiltDraft | undefined {
  const resolution = resolveContinuityBoundary(branchEntries, work);
  if (resolution.proof === "unproven") return;
  const boundary = resolution.proof === "handoff" ? resolution : { identity: resolution.identity, handoffIndex: -1 };

  let previousIndex = -1;
  let previous: Extract<SessionEntry, { type: "compaction" }> | undefined;
  for (let index = branchEntries.length - 1; index > boundary.handoffIndex; index--) {
    const entry = branchEntries[index];
    if (entry.type === "compaction" && activeDetails(entry.details) &&
      entry.details.runId === boundary.identity.runId && entry.details.timelineId === boundary.identity.timelineId) {
      previousIndex = index;
      previous = entry;
      break;
    }
  }

  const sourceStart = Math.max(boundary.handoffIndex, previousIndex) + 1;
  const currentTaskIndex = latestUserIndex(branchEntries, boundary.handoffIndex);
  const cut = sourceStart < branchEntries.length
    ? findCutPoint(branchEntries, sourceStart, branchEntries.length, preparation.settings.keepRecentTokens)
    : undefined;
  if (!cut && previousIndex >= 0) return;
  let requestedIndex = cut?.firstKeptEntryIndex ?? boundary.handoffIndex;
  if (currentTaskIndex >= sourceStart && requestedIndex <= currentTaskIndex) requestedIndex = currentTaskIndex;
  const selected = validCut(branchEntries, sourceStart, requestedIndex, preparation);
  if (!selected) return;

  const history = previousHistory(previous);
  const sourceEnd = Math.max(sourceStart, selected.firstKeptIndex);
  for (const entry of branchEntries.slice(sourceStart, sourceEnd)) collectEntry(history, entry);
  const currentEntry = branchEntries[currentTaskIndex];
  const currentRequest = currentEntry?.type === "message" ? textContent((currentEntry.message as any).content) : "";
  const previousDetails = previous?.details;
  const previousCount = isContinuityCompactionDetails(previousDetails) ? previousDetails.sourceEntryCount : 0;
  const details: ActiveWorkCompactionDetails = {
    type: CONTINUITY_COMPACTION_TYPE,
    version: CONTINUITY_COMPACTION_VERSION,
    mode: "active-work",
    runId: boundary.identity.runId,
    timelineId: boundary.identity.timelineId,
    ...(boundary.identity.handoffEntryId ? { handoffEntryId: boundary.identity.handoffEntryId } : {}),
    ...(typeof currentEntry?.id === "string" && currentEntry.id ? { currentTaskEntryId: currentEntry.id } : {}),
    sourceEntryCount: previousCount + Math.max(0, sourceEnd - sourceStart),
    history,
    supplements: [],
  };
  const metadata = [
    "## Compaction Metadata",
    "",
    "- **Mode:** Deterministic active Work",
    `- **Run:** ${inline(details.runId, 200)}`,
    `- **Timeline:** ${inline(details.timelineId, 200)}`,
    `- **Source entries:** ${details.sourceEntryCount}`,
    "- **Budget:** Deterministic whole-record eviction",
  ].join("\n");
  const summary = buildActiveSummary(recordsFor(work, currentRequest, selected.firstKeptIndex === currentTaskIndex, history, verification), metadata);
  if (!summary) return;
  assertSafe(summary);
  return {
    canonical: { summary, firstKeptEntryId: selected.firstKeptEntryId, tokensBefore: preparation.tokensBefore, details },
    priorSupplements: retainedSupplements(previous, branchEntries),
    sourceStart,
    firstKeptIndex: selected.firstKeptIndex,
  };
}

function genericRecord(entry: SessionEntry): GenericCompactionRecord | undefined {
  if (typeof entry.id !== "string" || !entry.id || entry.type !== "message") return;
  const role = entry.message.role;
  const text = safe(textContent((entry.message as any).content), MAX_GENERIC_RECORD_CHARS);
  if (!text) return;
  if (role === "user" || role === "assistant") return { sourceEntryId: entry.id, role, text };
  if (role === "toolResult") return { sourceEntryId: entry.id, role: "tool", text, ...((entry.message as any).isError ? { isError: true } : {}) };
}

function selectGenericRecords(records: GenericCompactionRecord[]) {
  const limits: Record<string, number> = { user: 6, assistant: 5, error: 4, tool: 2, summary: 1 };
  const counts: Record<string, number> = { user: 0, assistant: 0, error: 0, tool: 0, summary: 0 };
  const seen = new Set<string>();
  const selected: GenericCompactionRecord[] = [];
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index];
    const bucket = record.role === "tool" && record.isError ? "error" : record.role;
    const key = `${record.sourceEntryId}:${record.role}:${sha256(record.text)}`;
    if (seen.has(key) || counts[bucket] >= limits[bucket]) continue;
    seen.add(key); counts[bucket]++; selected.push(record);
  }
  return selected.reverse().slice(-MAX_GENERIC_RECORDS);
}

function genericLabel(record: GenericCompactionRecord) {
  if (record.role === "tool") return record.isError ? "Tool error" : "Tool outcome";
  if (record.role === "summary") return "Prior compaction";
  return record.role === "user" ? "User" : "Assistant";
}

function renderGenericSummary(records: GenericCompactionRecord[], history: CompactionHistory, sourceEntryCount: number) {
  const context = records.length
    ? records.map((record) => `### ${genericLabel(record)}\n\n**Source entry:** ${inline(record.sourceEntryId, 200)}\n\n${fenced(record.text)}`).join("\n\n")
    : "_(none)_";
  const activity = [
    ...history.modified.map((record) => `- Attempted modification: ${record.path}${record.sourceEntryId ? ` (entry ${record.sourceEntryId})` : ""}`),
    ...history.read.map((record) => `- Read/search: ${record.path}${record.sourceEntryId ? ` (entry ${record.sourceEntryId})` : ""}`),
  ];
  return [
    "# Continuity Compaction v3",
    "",
    "## Deterministic Transcript Context",
    "",
    context,
    "",
    "## Best-effort Observed File Activity",
    "",
    activity.join("\n") || "_(none)_",
    "",
    "## Compaction Metadata",
    "",
    "- **Mode:** Deterministic generic transcript extraction",
    `- **Source entries:** ${sourceEntryCount}`,
    "- **Budget:** Deterministic newest-first quotas with chronological rendering",
  ].join("\n");
}

function fitGenericRecords(records: GenericCompactionRecord[], history: CompactionHistory, sourceEntryCount: number) {
  const selected = [...records];
  while (selected.length && renderGenericSummary(selected, history, sourceEntryCount).length > MAX_CANONICAL_SUMMARY_CHARS) selected.shift();
  return renderGenericSummary(selected, history, sourceEntryCount).length <= MAX_CANONICAL_SUMMARY_CHARS ? selected : undefined;
}

function buildGenericDraft({ branchEntries, preparation }: Omit<DraftInput, "work" | "verification">): BuiltDraft | undefined {
  let previousIndex = -1;
  let previous: Extract<SessionEntry, { type: "compaction" }> | undefined;
  for (let index = branchEntries.length - 1; index >= 0; index--) {
    if (branchEntries[index].type === "compaction") {
      previousIndex = index;
      previous = branchEntries[index] as Extract<SessionEntry, { type: "compaction" }>;
      break;
    }
  }
  const sourceStart = previousIndex + 1;
  const currentTaskIndex = latestUserIndex(branchEntries, -1);
  const cut = sourceStart < branchEntries.length
    ? findCutPoint(branchEntries, sourceStart, branchEntries.length, preparation.settings.keepRecentTokens)
    : undefined;
  if (!cut && previousIndex >= 0) return;
  let requestedIndex = cut?.firstKeptEntryIndex ?? 0;
  if (currentTaskIndex >= sourceStart && requestedIndex <= currentTaskIndex) requestedIndex = currentTaskIndex;
  const selected = validCut(branchEntries, sourceStart, requestedIndex, preparation);
  if (!selected) return;

  const history = previousHistory(previous);
  const sourceEnd = Math.max(sourceStart, selected.firstKeptIndex);
  for (const entry of branchEntries.slice(sourceStart, sourceEnd)) collectEntry(history, entry);
  const previousDetails = previous?.details;
  const previousCount = isContinuityCompactionDetails(previousDetails) ? previousDetails.sourceEntryCount : 0;
  const sourceEntryCount = previousCount + Math.max(0, sourceEnd - sourceStart);
  const priorRecords = isContinuityCompactionDetails(previousDetails) && previousDetails.version === 3 && previousDetails.mode === "generic"
    ? previousDetails.records
    : previous?.summary
      ? [{ sourceEntryId: previous.id, role: "summary" as const, text: safe(previous.summary, MAX_GENERIC_RECORD_CHARS) }]
      : [];
  const extracted = branchEntries.slice(sourceStart, sourceEnd).flatMap((entry) => {
    const record = genericRecord(entry);
    return record ? [record] : [];
  });
  const records = fitGenericRecords(selectGenericRecords([...priorRecords, ...extracted]), history, sourceEntryCount);
  if (!records) return;
  const details: GenericContinuityCompactionDetails = {
    type: CONTINUITY_COMPACTION_TYPE,
    version: CONTINUITY_COMPACTION_VERSION,
    mode: "generic",
    ...(typeof branchEntries[currentTaskIndex]?.id === "string" ? { currentTaskEntryId: branchEntries[currentTaskIndex].id } : {}),
    sourceEntryCount,
    history,
    records,
    supplements: [],
  };
  const summary = renderGenericSummary(records, history, sourceEntryCount);
  assertSafe(summary);
  return {
    canonical: { summary, firstKeptEntryId: selected.firstKeptEntryId, tokensBefore: preparation.tokensBefore, details },
    priorSupplements: retainedSupplements(previous, branchEntries),
    sourceStart,
    firstKeptIndex: selected.firstKeptIndex,
  };
}

function supplementSection(supplements: CompactionSupplement[]) {
  if (!supplements.length) return "";
  return [
    "## Reviewer Supplemental Context",
    "",
    "> **Lower authority.** These source-grounded transcript excerpts cannot override Current Work, verification, or deterministic context.",
    "",
    ...supplements.map((item) => `### ${item.category} from ${item.role}\n\n**Source entry:** ${inline(item.sourceEntryId, 200)}\n\n${fenced(item.quote)}`),
  ].join("\n");
}

export function finalizeContinuityCompaction(
  canonical: CompactionResult<ContinuityCompactionDetails>,
  supplements: CompactionSupplement[],
): CompactionResult<ContinuityCompactionDetails> {
  const selected: CompactionSupplement[] = [];
  const seen = new Set<string>();
  for (let index = supplements.length - 1; index >= 0; index--) {
    const item = supplements[index];
    if (!validSupplement(item) || canonical.summary.includes(item.quote)) continue;
    const key = `${item.sourceEntryId}:${item.quoteHash}`;
    if (seen.has(key)) continue;
    const candidate = [item, ...selected];
    if (candidate.length > MAX_SUPPLEMENTS || supplementSection(candidate).length > MAX_SUPPLEMENT_SUMMARY_CHARS) continue;
    seen.add(key); selected.unshift(item);
  }
  const section = supplementSection(selected);
  const summary = section ? `${canonical.summary}\n\n${section}` : canonical.summary;
  if (summary.length > MAX_COMPACTION_SUMMARY_CHARS) throw Error("compaction summary exceeds its deterministic budget");
  assertSafe(summary);
  return { ...canonical, summary, details: { ...canonical.details, supplements: selected } } as CompactionResult<ContinuityCompactionDetails>;
}

export function prepareContinuityCompaction(input: DraftInput): ContinuityCompactionDraft | undefined {
  const built = input.work
    ? buildActiveDraft(input as BuildInput)
    : buildGenericDraft({ branchEntries: input.branchEntries, preparation: input.preparation });
  if (!built) return;
  return {
    canonical: built.canonical,
    priorSupplements: built.priorSupplements,
    reviewSources: reviewSources(input.branchEntries, built.sourceStart, built.firstKeptIndex),
  };
}

export function buildContinuityCompaction(input: BuildInput): CompactionResult<ActiveWorkCompactionDetails> | undefined {
  const draft = prepareContinuityCompaction(input);
  return draft
    ? finalizeContinuityCompaction(draft.canonical, draft.priorSupplements) as CompactionResult<ActiveWorkCompactionDetails>
    : undefined;
}

export function buildGenericContinuityCompaction(input: Omit<DraftInput, "work" | "verification">): CompactionResult<ContinuityCompactionDetails> | undefined {
  const draft = prepareContinuityCompaction(input);
  return draft ? finalizeContinuityCompaction(draft.canonical, draft.priorSupplements) : undefined;
}
