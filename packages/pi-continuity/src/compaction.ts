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
export const CONTINUITY_COMPACTION_VERSION = 1;
export const MAX_COMPACTION_SUMMARY_CHARS = 24_000;
const MAX_CURRENT_REQUEST_CHARS = 12_000;
const HISTORY_HEADINGS = [
  "Goals and scope changes",
  "Files read",
  "Files modified",
  "Commits",
  "Unresolved errors and blockers",
  "User preferences",
  "Recent transcript brief",
] as const;
type HistoryHeading = typeof HISTORY_HEADINGS[number];
type History = Record<HistoryHeading, string[]>;

export type ContinuityCompactionDetails = {
  type: typeof CONTINUITY_COMPACTION_TYPE;
  version: typeof CONTINUITY_COMPACTION_VERSION;
  runId: string;
  timelineId: string;
  handoffEntryId?: string;
  currentTaskEntryId?: string;
  sourceEntryCount: number;
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
};

export type ContinuityBoundaryIdentity = { runId: string; timelineId: string; handoffEntryId?: string };
export type ContinuityBoundaryResolution =
  | { proof: "handoff"; identity: ContinuityBoundaryIdentity; handoffIndex: number }
  | { proof: "identity"; source: "compaction" | "work"; identity: ContinuityBoundaryIdentity }
  | { proof: "unproven"; reason: string };

const emptyHistory = (): History => Object.fromEntries(
  HISTORY_HEADINGS.map((heading) => [heading, [] as string[]]),
) as unknown as History;

function isDetails(value: unknown): value is ContinuityCompactionDetails {
  const details = value as Partial<ContinuityCompactionDetails> | undefined;
  return Boolean(
    details?.type === CONTINUITY_COMPACTION_TYPE &&
      details.version === CONTINUITY_COMPACTION_VERSION &&
      typeof details.runId === "string" && details.runId &&
      typeof details.timelineId === "string" && details.timelineId &&
      Number.isInteger(details.sourceEntryCount) && details.sourceEntryCount! >= 0 &&
      (details.handoffEntryId === undefined || typeof details.handoffEntryId === "string") &&
      (details.currentTaskEntryId === undefined || typeof details.currentTaskEntryId === "string"),
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

function brief(value: string, max = 240) {
  return safe(value.replace(/\s+/g, " ").trim(), max);
}

function add(history: History, heading: HistoryHeading, value: string, maxItems: number) {
  const item = brief(value);
  if (!item || history[heading].includes(item) || history[heading].length >= maxItems) return;
  history[heading].push(item);
}

function parsePreviousHistory(summary: string): History {
  const history = emptyHistory();
  if (!summary.startsWith("# Continuity Compaction v1\n")) return history;
  const older = summary.indexOf("\n[Older History]\n");
  if (older < 0) return history;
  const text = summary.slice(older + "\n[Older History]\n".length);
  for (let index = 0; index < HISTORY_HEADINGS.length; index++) {
    const heading = HISTORY_HEADINGS[index];
    const marker = `### ${heading}\n`;
    const start = text.indexOf(marker);
    if (start < 0) continue;
    const nextStarts = HISTORY_HEADINGS.slice(index + 1)
      .map((next) => text.indexOf(`### ${next}\n`, start + marker.length))
      .filter((position) => position >= 0);
    const end = nextStarts.length ? Math.min(...nextStarts) : text.length;
    for (const line of text.slice(start + marker.length, end).split("\n")) {
      if (line.startsWith("- ")) add(history, heading, line.slice(2), 12);
    }
  }
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

function collectEntry(history: History, entry: SessionEntry) {
  if (entry.type === "message") {
    const message = entry.message as any;
    if (message.role === "user") {
      const text = textContent(message.content);
      add(history, "Goals and scope changes", text, 8);
      for (const line of text.split(/\r?\n/))
        if (/\b(?:prefer|do not|don't|never|always|must|avoid|keep)\b/i.test(line))
          add(history, "User preferences", line, 8);
      add(history, "Recent transcript brief", `User: ${text}`, 10);
    } else if (message.role === "assistant") {
      const text = textContent(message.content);
      if (text) add(history, "Recent transcript brief", `Assistant: ${text}`, 10);
      for (const line of text.split(/\r?\n/))
        if (/\b(?:blocked|error|failed|failure|cannot|can't)\b/i.test(line))
          add(history, "Unresolved errors and blockers", line, 8);
    } else if (message.role === "toolResult" && message.isError) {
      add(history, "Unresolved errors and blockers", textContent(message.content), 8);
      add(history, "Recent transcript brief", `Tool error: ${textContent(message.content)}`, 10);
    }
  }

  for (const call of toolCalls(entry)) {
    const name = typeof call.name === "string" ? call.name : "tool";
    const path = toolPath(call);
    if (path && ["read", "rg", "grep", "fd", "find"].includes(name))
      add(history, "Files read", path, 12);
    if (path && ["edit", "write"].includes(name))
      add(history, "Files modified", path, 12);
    if (name === "bash" && typeof call.arguments?.command === "string" && /\bgit\s+commit\b/.test(call.arguments.command))
      add(history, "Commits", "git commit executed", 6);
    add(history, "Recent transcript brief", `Assistant tool call: ${name}${path ? ` (${path})` : ""}`, 10);
  }

  if (entry.type === "custom_message" && entry.customType !== HANDOFF_ENTRY_TYPE)
    add(history, "Recent transcript brief", `Custom activity: ${entry.customType}`, 10);
  if (entry.type === "branch_summary")
    add(history, "Recent transcript brief", "A branch summary was present", 10);
}

function latestUserIndex(entries: SessionEntry[], after: number) {
  for (let index = entries.length - 1; index > after; index--) {
    const entry = entries[index];
    if (entry.type === "message" && entry.message.role === "user") return index;
  }
  return -1;
}

function renderHistory(history: History) {
  return HISTORY_HEADINGS.map((heading) => [
    `### ${heading}`,
    ...(history[heading].length ? history[heading].map((item) => `- ${item}`) : ["- (none)"]),
  ].join("\n")).join("\n\n");
}

function renderAnchor(work: Work, currentRequest: string) {
  const current = work.todos.find((todo) => todo.id === work.currentTodoId);
  return [
    "[Current Task]",
    "Latest in-scope user request (verbatim unless credential redaction or the size limit applies):",
    safe(currentRequest || "(no in-scope user request)", MAX_CURRENT_REQUEST_CHARS),
    "",
    `Goal: ${safe(work.goal || "(not specified)", 2_000)}`,
    `Current todo: ${current ? `${current.id} [${current.status}]: ${safe(current.text, 500)}` : "(none)"}`,
    ...(work.latestFailure ? [`Blocker: ${safe(work.latestFailure, 1_000)}`] : []),
    ...(work.nextAction ? [`Next action: ${safe(work.nextAction, 1_000)}`] : []),
    "Constraints:",
    ...(work.constraints.length
      ? work.constraints.slice(0, 12).map((constraint) => `- ${safe(constraint, 300)}`)
      : ["- (none)"]),
  ].join("\n");
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
    if (!isDetails(entry.details)) {
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
  return ["custom_message", "branch_summary"].includes(entry.type);
}

export function buildContinuityCompaction({
  branchEntries,
  preparation,
  work,
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
      entry.type === "compaction" && isDetails(entry.details) &&
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

  const history = previous ? parsePreviousHistory(previous.summary) : emptyHistory();
  const sourceEnd = Math.max(sourceStart, firstKeptIndex);
  for (const entry of branchEntries.slice(sourceStart, sourceEnd)) collectEntry(history, entry);

  const currentEntry = branchEntries[currentTaskIndex];
  const currentRequest = currentEntry?.type === "message"
    ? textContent((currentEntry.message as any).content)
    : "";
  const anchor = renderAnchor(work, currentRequest);
  const details: ContinuityCompactionDetails = {
    type: CONTINUITY_COMPACTION_TYPE,
    version: CONTINUITY_COMPACTION_VERSION,
    runId: boundary.identity.runId,
    timelineId: boundary.identity.timelineId,
    ...(boundary.identity.handoffEntryId ? { handoffEntryId: boundary.identity.handoffEntryId } : {}),
    ...(typeof currentEntry?.id === "string" && currentEntry.id ? { currentTaskEntryId: currentEntry.id } : {}),
    sourceEntryCount: ((previous?.details as ContinuityCompactionDetails | undefined)?.sourceEntryCount ?? 0)
      + Math.max(0, sourceEnd - sourceStart),
  };
  const metadata = `[Compaction Metadata]\nBoundary: ${brief(details.runId, 200)}/${brief(details.timelineId, 200)}\nSource entries: ${details.sourceEntryCount}`;
  let summary = `# Continuity Compaction v1\n\n${anchor}\n\n[Older History]\n${renderHistory(history)}\n\n${metadata}`;

  if (summary.length > MAX_COMPACTION_SUMMARY_CHARS) {
    const trimmed = emptyHistory();
    for (const heading of HISTORY_HEADINGS) {
      for (const item of history[heading]) {
        trimmed[heading].push(item);
        const candidate = `# Continuity Compaction v1\n\n${anchor}\n\n[Older History]\n${renderHistory(trimmed)}\n\n${metadata}`;
        if (candidate.length > MAX_COMPACTION_SUMMARY_CHARS) {
          trimmed[heading].pop();
          break;
        }
      }
    }
    summary = `# Continuity Compaction v1\n\n${anchor}\n\n[Older History]\n${renderHistory(trimmed)}\n\n${metadata}`;
  }
  if (summary.length > MAX_COMPACTION_SUMMARY_CHARS)
    summary = `${summary.slice(0, MAX_COMPACTION_SUMMARY_CHARS - 34)}\n[truncated by Continuity]`;
  assertSafe(summary);

  return {
    summary,
    firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    details,
  };
}
