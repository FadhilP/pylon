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
export const CONTINUITY_COMPACTION_VERSION = 2;
export const MAX_COMPACTION_SUMMARY_CHARS = 24_000;
const LEGACY_COMPACTION_VERSION = 1;
const MAX_CURRENT_REQUEST_CHARS = 12_000;
const MAX_HISTORY_ITEMS = 12;
const MAX_HISTORY_PATH_CHARS = 540;
const MAX_SOURCE_ENTRY_ID_CHARS = 240;
const SECTION_ORDER = ["Current Task", "Current Work", "Observed File Activity"] as const;

type HistoryKind = "read" | "modified";
export type CompactionHistoryRecord = {
  path: string;
  sourceEntryId?: string;
};
export type CompactionHistory = Record<HistoryKind, CompactionHistoryRecord[]>;

export type ContinuityCompactionDetails = {
  type: typeof CONTINUITY_COMPACTION_TYPE;
  version: typeof CONTINUITY_COMPACTION_VERSION;
  runId: string;
  timelineId: string;
  handoffEntryId?: string;
  currentTaskEntryId?: string;
  sourceEntryCount: number;
  history: CompactionHistory;
};

type LegacyCompactionDetails = Omit<ContinuityCompactionDetails, "version" | "history"> & {
  version: typeof LEGACY_COMPACTION_VERSION;
};
type AnyCompactionDetails = LegacyCompactionDetails | ContinuityCompactionDetails;

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

type SummaryRecord = {
  section: typeof SECTION_ORDER[number];
  text: string;
  priority: number;
  order: number;
  required?: boolean;
};

export type ContinuityBoundaryIdentity = { runId: string; timelineId: string; handoffEntryId?: string };
export type ContinuityBoundaryResolution =
  | { proof: "handoff"; identity: ContinuityBoundaryIdentity; handoffIndex: number }
  | { proof: "identity"; source: "compaction" | "work"; identity: ContinuityBoundaryIdentity }
  | { proof: "unproven"; reason: string };

const emptyHistory = (): CompactionHistory => ({ read: [], modified: [] });

function validBaseDetails(value: any) {
  return Boolean(
    value?.type === CONTINUITY_COMPACTION_TYPE &&
      (value.version === LEGACY_COMPACTION_VERSION || value.version === CONTINUITY_COMPACTION_VERSION) &&
      typeof value.runId === "string" && value.runId &&
      typeof value.timelineId === "string" && value.timelineId &&
      Number.isInteger(value.sourceEntryCount) && value.sourceEntryCount >= 0 &&
      (value.handoffEntryId === undefined || typeof value.handoffEntryId === "string") &&
      (value.currentTaskEntryId === undefined || typeof value.currentTaskEntryId === "string"),
  );
}

function validHistoryRecord(value: any) {
  return Boolean(
    value && typeof value.path === "string" && value.path &&
      value.path.length <= MAX_HISTORY_PATH_CHARS &&
      (value.sourceEntryId === undefined ||
        (typeof value.sourceEntryId === "string" && value.sourceEntryId.length <= MAX_SOURCE_ENTRY_ID_CHARS)),
  );
}

export function isContinuityCompactionDetails(value: unknown): value is AnyCompactionDetails {
  if (!validBaseDetails(value)) return false;
  const details = value as AnyCompactionDetails;
  return details.version === LEGACY_COMPACTION_VERSION || Boolean(
    details.history &&
      Array.isArray(details.history.read) && details.history.read.length <= MAX_HISTORY_ITEMS &&
      details.history.read.every(validHistoryRecord) &&
      Array.isArray(details.history.modified) && details.history.modified.length <= MAX_HISTORY_ITEMS &&
      details.history.modified.every(validHistoryRecord),
  );
}

function handoffIdentity(entry: SessionEntry): ContinuityBoundaryIdentity | undefined {
  if (entry.type !== "custom_message" || entry.customType !== HANDOFF_ENTRY_TYPE)
    return;
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

function addHistory(
  history: CompactionHistory,
  kind: HistoryKind,
  path: string,
  sourceEntryId?: string,
) {
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
  if (details.version === CONTINUITY_COMPACTION_VERSION) {
    for (const kind of ["read", "modified"] as const)
      for (const record of details.history[kind])
        addHistory(history, kind, record.path, record.sourceEntryId);
    return history;
  }
  for (const path of legacySection(previous?.summary ?? "", "Files read")) addHistory(history, "read", path);
  for (const path of legacySection(previous?.summary ?? "", "Files modified")) addHistory(history, "modified", path);
  return history;
}

function toolCalls(entry: SessionEntry): any[] {
  if (entry.type !== "message" || entry.message.role !== "assistant") return [];
  const content = (entry.message as any).content;
  return Array.isArray(content)
    ? content.filter((part: any) => part?.type === "toolCall")
    : [];
}

function toolPath(call: any): string | undefined {
  const args = call?.arguments;
  if (!args || typeof args !== "object") return;
  for (const key of ["path", "filePath", "file", "target"]) {
    if (typeof args[key] === "string" && args[key]) return args[key];
  }
}

function collectEntry(history: CompactionHistory, entry: SessionEntry) {
  for (const call of toolCalls(entry)) {
    const name = typeof call.name === "string" ? call.name : "";
    const path = toolPath(call);
    if (!path) continue;
    if (["read", "rg", "grep", "fd", "find"].includes(name))
      addHistory(history, "read", path, entry.id);
    if (["edit", "write"].includes(name))
      addHistory(history, "modified", path, entry.id);
  }
}

function latestUserIndex(entries: SessionEntry[], after: number) {
  for (let index = entries.length - 1; index > after; index--) {
    const entry = entries[index];
    if (entry.type === "message" && entry.message.role === "user") return index;
  }
  return -1;
}

function recordsFor(
  work: Work,
  currentRequest: string,
  history: CompactionHistory,
  verification?: CompactionVerification,
) {
  let order = 0;
  const records: SummaryRecord[] = [];
  const add = (
    section: SummaryRecord["section"],
    text: string,
    priority: number,
    required = false,
  ) => records.push({ section, text, priority, required, order: order++ });

  add(
    "Current Task",
    `Latest in-scope user request (verbatim unless credential redaction or the size limit applies):\n${safe(currentRequest || "(no in-scope user request)", MAX_CURRENT_REQUEST_CHARS)}`,
    1_000,
    true,
  );
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

  if (!work.todos.length) add("Current Work", "Todos: (none)", 940);
  const currentTodo = work.todos.find((todo) => todo.id === work.currentTodoId);
  const todos = work.todos.slice(0, 12);
  if (currentTodo && !todos.includes(currentTodo)) todos.splice(11, 1, currentTodo);
  for (const todo of todos) {
    const current = todo === currentTodo ? " current" : "";
    add(
      "Current Work",
      `Todo ${inline(todo.id, 100)} [${todo.status}${current}]: ${safe(todo.text, 300)}`,
      current ? 945 : 930,
    );
  }

  if (!work.constraints.length) add("Current Work", "Constraints: (none)", 900);
  for (const constraint of work.constraints.slice(0, 12))
    add("Current Work", `Constraint: ${safe(constraint, 300)}`, 900);

  for (const record of history.modified)
    add("Observed File Activity", `Attempted modification: ${record.path}${record.sourceEntryId ? ` (entry ${record.sourceEntryId})` : ""}`, 200);
  for (const record of history.read)
    add("Observed File Activity", `Read/search: ${record.path}${record.sourceEntryId ? ` (entry ${record.sourceEntryId})` : ""}`, 100);
  return records;
}

function renderSummary(records: SummaryRecord[], metadata: string) {
  const sections = SECTION_ORDER.flatMap((section) => {
    const values = records.filter((record) => record.section === section).sort((a, b) => a.order - b.order);
    return values.length ? [`[${section}]\n${values.map((record) => record.text).join("\n")}`] : [];
  });
  return `# Continuity Compaction v2\n\n${sections.join("\n\n")}\n\n${metadata}`;
}

function buildSummary(records: SummaryRecord[], metadata: string) {
  const selected = records.filter((record) => record.required);
  if (renderSummary(selected, metadata).length > MAX_COMPACTION_SUMMARY_CHARS) return;
  const optional = records.filter((record) => !record.required)
    .sort((left, right) => right.priority - left.priority || left.order - right.order);
  for (const record of optional) {
    const candidate = [...selected, record];
    if (renderSummary(candidate, metadata).length <= MAX_COMPACTION_SUMMARY_CHARS)
      selected.push(record);
  }
  return renderSummary(selected, metadata);
}

function matchesWork(identity: ContinuityBoundaryIdentity, work: Work) {
  return identity.runId === work.runId && identity.timelineId === work.timelineId;
}

export function resolveContinuityBoundary(
  entries: SessionEntry[],
  work: Work,
): ContinuityBoundaryResolution {
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
      if (markedContinuity)
        return { proof: "unproven", reason: "latest Continuity compaction metadata is malformed" };
      continue;
    }
    const identity = {
      runId: entry.details.runId,
      timelineId: entry.details.timelineId,
      handoffEntryId: entry.details.handoffEntryId,
    };
    return matchesWork(identity, work)
      ? { proof: "identity", source: "compaction", identity }
      : { proof: "unproven", reason: "latest Continuity compaction does not match active Work" };
  }
  if (work.runId && work.timelineId)
    return {
      proof: "identity",
      source: "work",
      identity: { runId: work.runId, timelineId: work.timelineId },
    };
  return { proof: "unproven", reason: "active Continuity identity is unavailable" };
}

function isSafeCutEntry(entry: SessionEntry | undefined) {
  if (!entry) return false;
  if (entry.type === "message") return entry.message.role !== "toolResult";
  return ["custom", "custom_message", "branch_summary"].includes(entry.type);
}

export function buildContinuityCompaction({
  branchEntries,
  preparation,
  work,
  verification,
}: BuildInput): CompactionResult<ContinuityCompactionDetails> | undefined {
  const resolution = resolveContinuityBoundary(branchEntries, work);
  if (resolution.proof === "unproven") return;
  const boundary = resolution.proof === "handoff"
    ? resolution
    : { identity: resolution.identity, handoffIndex: -1 };

  let previousIndex = -1;
  let previous: Extract<SessionEntry, { type: "compaction" }> | undefined;
  for (let index = branchEntries.length - 1; index > boundary.handoffIndex; index--) {
    const entry = branchEntries[index];
    if (
      entry.type === "compaction" && isContinuityCompactionDetails(entry.details) &&
      entry.details.runId === boundary.identity.runId &&
      entry.details.timelineId === boundary.identity.timelineId
    ) {
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
  let firstKeptIndex = cut?.firstKeptEntryIndex ?? boundary.handoffIndex;
  if (currentTaskIndex >= sourceStart && firstKeptIndex <= currentTaskIndex)
    firstKeptIndex = currentTaskIndex;

  let selected = branchEntries[firstKeptIndex];
  if (typeof selected?.id !== "string" || !selected.id || !isSafeCutEntry(selected)) {
    const preparedIndex = branchEntries.findIndex((entry) => entry.id === preparation.firstKeptEntryId);
    if (preparedIndex < sourceStart || !isSafeCutEntry(branchEntries[preparedIndex])) return;
    firstKeptIndex = preparedIndex;
    selected = branchEntries[firstKeptIndex];
  }
  const firstKeptEntryId = selected.id;

  const history = previousHistory(previous);
  const sourceEnd = Math.max(sourceStart, firstKeptIndex);
  for (const entry of branchEntries.slice(sourceStart, sourceEnd)) collectEntry(history, entry);

  const currentEntry = branchEntries[currentTaskIndex];
  const currentRequest = currentEntry?.type === "message"
    ? textContent((currentEntry.message as any).content)
    : "";
  const previousDetails = previous?.details;
  const previousCount = isContinuityCompactionDetails(previousDetails)
    ? previousDetails.sourceEntryCount
    : 0;
  const details: ContinuityCompactionDetails = {
    type: CONTINUITY_COMPACTION_TYPE,
    version: CONTINUITY_COMPACTION_VERSION,
    runId: boundary.identity.runId,
    timelineId: boundary.identity.timelineId,
    ...(boundary.identity.handoffEntryId ? { handoffEntryId: boundary.identity.handoffEntryId } : {}),
    ...(typeof currentEntry?.id === "string" && currentEntry.id ? { currentTaskEntryId: currentEntry.id } : {}),
    sourceEntryCount: previousCount + Math.max(0, sourceEnd - sourceStart),
    history,
  };
  const metadata = [
    "[Compaction Metadata]",
    `Boundary: ${inline(details.runId, 200)}/${inline(details.timelineId, 200)}`,
    `Source entries: ${details.sourceEntryCount}`,
    "Budget: deterministic whole-record eviction",
  ].join("\n");
  const summary = buildSummary(recordsFor(work, currentRequest, history, verification), metadata);
  if (!summary) return;
  assertSafe(summary);

  return {
    summary,
    firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    details,
  };
}
