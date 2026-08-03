import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Work } from "./active-work.ts";
import {
  CONTINUITY_COMPACTION_TYPE,
  resolveContinuityBoundary,
  type ContinuityBoundaryResolution,
} from "./compaction.ts";
import { HANDOFF_ENTRY_TYPE } from "./run.ts";
import { sanitizeAndClip } from "./secrets.ts";

// Inspired by pi-blackhole's recovery ergonomics; recall stays local, explicit, and read-only.
export const RECALL_PAGE_SIZE = 8;
export const MAX_RECALL_OUTPUT_CHARS = 12_000;
export const MAX_RECALL_SCAN_ENTRIES = 5_000;
export const MAX_RECALL_RESULTS = 200;
export const MAX_RECALL_PAGE = 1_000;
const MAX_QUERY_CHARS = 200;
const MAX_EXCERPT_CHARS = 700;
const MAX_EXPANSION_CHARS = 2_000;
const ALLOWED_CUSTOM_MESSAGES = new Set([HANDOFF_ENTRY_TYPE, "pi-continuity"]);
const FILE_TOOLS = new Set(["read", "write", "edit"]);

export type RecallScope = "execution" | "lineage" | "all";
export type RecallMode = "text" | "files" | "touched";
export type RecallParams = {
  query?: string;
  expand?: string[];
  page?: number;
  scope?: RecallScope;
  mode?: RecallMode;
};
export type RecallInput = {
  sessionId: string;
  activeBranch: SessionEntry[];
  visibleEntries: SessionEntry[];
  allEntries?: SessionEntry[];
  work: Work;
  params: RecallParams;
};
export type RecallResult = {
  text: string;
  requestedScope: RecallScope;
  effectiveScope: RecallScope | "visible";
  page: number;
  total: number;
};

type RecallRecord = {
  key: string;
  entry: SessionEntry;
  role: string;
  label: string;
  content: string;
  searchText?: string;
};
type FileOperation = {
  callEntry: SessionEntry;
  resultEntry?: SessionEntry;
  toolCallId: string;
  toolName: "read" | "write" | "edit";
  path: string;
};

function textContent(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");
}

function validActiveBranch(entries: SessionEntry[]) {
  const ids = new Set<string>();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry?.id || ids.has(entry.id)) return false;
    if (index === 0) {
      if (entry.parentId !== null) return false;
    } else if (entry.parentId !== entries[index - 1].id) return false;
    ids.add(entry.id);
  }
  return true;
}

function validAllEntries(entries: SessionEntry[], activeBranch: SessionEntry[]) {
  const byId = new Map<string, SessionEntry>();
  const indexes = new Map<string, number>();
  const toolCallIds = new Set<string>();
  let roots = 0;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry?.id || byId.has(entry.id)) return false;
    byId.set(entry.id, entry);
    indexes.set(entry.id, index);
    if (entry.parentId === null) roots++;
    if (entry.type === "message" && entry.message.role === "assistant") {
      const content = (entry.message as any).content;
      for (const part of Array.isArray(content) ? content : []) {
        if (part?.type !== "toolCall" || typeof part.id !== "string") continue;
        if (toolCallIds.has(part.id)) return false;
        toolCallIds.add(part.id);
      }
    }
  }
  if (entries.length && roots !== 1) return false;
  for (const active of activeBranch) {
    const stored = byId.get(active.id);
    if (!stored || stored.parentId !== active.parentId || stored.type !== active.type) return false;
  }
  for (const entry of entries) {
    if (entry.parentId === null) continue;
    const parentIndex = indexes.get(entry.parentId);
    if (parentIndex === undefined || parentIndex >= indexes.get(entry.id)!) return false;
  }
  return true;
}

function broadScopeProven(resolution: ContinuityBoundaryResolution) {
  return resolution.proof === "handoff" ||
    (resolution.proof === "identity" && resolution.source === "compaction");
}

export function canUseBroadRecall(activeBranch: SessionEntry[], work: Work) {
  return validActiveBranch(activeBranch) && broadScopeProven(resolveContinuityBoundary(activeBranch, work));
}

function safeVisibleEntries(entries: SessionEntry[], work: Work) {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type === "custom_message" && entry.customType === HANDOFF_ENTRY_TYPE)
      return entries.slice(index);
  }
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    const details = entry.type === "compaction" ? entry.details as any : undefined;
    if (
      details?.type === CONTINUITY_COMPACTION_TYPE && details.version === 1 &&
      details.runId === work.runId && details.timelineId === work.timelineId
    ) return entries.slice(index);
  }
  return entries;
}

function selectScope(input: RecallInput) {
  const requested = input.params.scope ?? "execution";
  const visibleEntries = safeVisibleEntries(input.visibleEntries, input.work);
  if (!validActiveBranch(input.activeBranch))
    return {
      entries: visibleEntries,
      effective: "visible" as const,
      notice: "Requested scope was downgraded: active ancestry is malformed; only currently visible entries were searched.",
    };
  const resolution = resolveContinuityBoundary(input.activeBranch, input.work);
  if (requested === "execution") {
    if (resolution.proof !== "handoff")
      return {
        entries: visibleEntries,
        effective: "visible" as const,
        notice: "Execution boundary could not be proven; only currently visible entries were searched.",
      };
    return {
      entries: input.activeBranch.slice(resolution.handoffIndex),
      effective: "execution" as const,
      notice: undefined,
    };
  }
  if (!broadScopeProven(resolution))
    return {
      entries: visibleEntries,
      effective: "visible" as const,
      notice: `Requested ${requested} scope was downgraded because the Continuity boundary identity could not be proven.`,
    };
  if (requested === "lineage")
    return {
      entries: input.activeBranch,
      effective: "lineage" as const,
      notice: "Non-default lineage scope includes pre-handoff entries on the active ancestry.",
    };
  if (!input.allEntries || !validAllEntries(input.allEntries, input.activeBranch))
    return {
      entries: visibleEntries,
      effective: "visible" as const,
      notice: "Requested all-branch scope was downgraded because complete branch ancestry could not be validated.",
    };
  return {
    entries: input.allEntries,
    effective: "all" as const,
    notice: "Non-default all scope includes every validated branch in the current session.",
  };
}

function queryMatcher(query: string | undefined) {
  const value = query?.trim() ?? "";
  if (!value) return { test: (_text: string) => true };
  if (value.length > MAX_QUERY_CHARS)
    return { test: (_text: string) => false, error: `Query exceeds ${MAX_QUERY_CHARS} characters.` };
  const regex = value.match(/^\/([\s\S]*)\/([a-z]*)$/);
  if (regex) {
    const [, pattern, flags] = regex;
    if (
      pattern.length > 100 ||
      !/^[im]*$/.test(flags) ||
      /\\[1-9]|[(){}|]/.test(pattern) ||
      (pattern.match(/[*+?]/g)?.length ?? 0) > 1
    ) return { test: (_text: string) => false, error: "Regex query was rejected as unsafe." };
    try {
      const compiled = new RegExp(pattern, flags.includes("i") ? flags : `${flags}i`);
      return { test: (text: string) => compiled.test(text) };
    } catch {
      return { test: (_text: string) => false, error: "Regex query is invalid." };
    }
  }
  const terms = value.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  return { test: (text: string) => terms.every((term) => text.toLowerCase().includes(term)) };
}

function textRecord(entry: SessionEntry, expanded: boolean): RecallRecord | undefined {
  let role = "";
  let content = "";
  if (entry.type === "message") {
    const message = entry.message as any;
    if (message.role !== "user" && message.role !== "assistant") return;
    role = message.role;
    content = textContent(message.content);
  } else if (entry.type === "custom_message" && ALLOWED_CUSTOM_MESSAGES.has(entry.customType)) {
    role = `custom:${entry.customType}`;
    content = textContent(entry.content);
  } else return;
  if (!content) return;
  return {
    key: `text:${entry.id}`,
    entry,
    role,
    label: "historical evidence",
    content: sanitizeAndClip(content, expanded ? MAX_EXPANSION_CHARS : MAX_EXCERPT_CHARS),
    searchText: sanitizeAndClip(content, 8_000),
  };
}

function fileOperations(entries: SessionEntry[]) {
  const operations: FileOperation[] = [];
  const byCallId = new Map<string, FileOperation>();
  const ambiguous = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message as any;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (
          part?.type !== "toolCall" ||
          !FILE_TOOLS.has(part.name) ||
          typeof part.id !== "string" ||
          typeof part.arguments?.path !== "string"
        ) continue;
        const operation: FileOperation = {
          callEntry: entry,
          toolCallId: part.id,
          toolName: part.name,
          path: sanitizeAndClip(part.arguments.path, 500),
        };
        operations.push(operation);
        if (byCallId.has(part.id)) {
          byCallId.delete(part.id);
          ambiguous.add(part.id);
        } else if (!ambiguous.has(part.id)) byCallId.set(part.id, operation);
      }
    } else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const operation = ambiguous.has(message.toolCallId) ? undefined : byCallId.get(message.toolCallId);
      if (operation && message.toolName === operation.toolName) operation.resultEntry = entry;
    }
  }
  return operations;
}

function operationRecord(operation: FileOperation): RecallRecord {
  return {
    key: `file:${operation.callEntry.id}:${operation.toolCallId}`,
    entry: operation.callEntry,
    role: `tool:${operation.toolName}`,
    label: "historical file-operation evidence",
    content: `${operation.toolName} ${operation.path}${operation.resultEntry ? `\nStored result entry: ${sanitizeAndClip(operation.resultEntry.id, 200)}` : ""}`,
  };
}

function resultExpansion(operation: FileOperation): RecallRecord | undefined {
  const entry = operation.resultEntry;
  if (entry?.type !== "message" || (entry.message as any).role !== "toolResult") return;
  const content = textContent((entry.message as any).content);
  if (!content) return;
  return {
    key: `file-result:${entry.id}`,
    entry,
    role: `toolResult:${operation.toolName}`,
    label: "historical file-result evidence (explicit expansion)",
    content: sanitizeAndClip(content, MAX_EXPANSION_CHARS),
  };
}

function formatRecord(record: RecallRecord, sessionId: string) {
  return [
    `[${record.label}]`,
    `session=${sanitizeAndClip(sessionId, 200)} entry=${sanitizeAndClip(record.entry.id, 200)} role=${record.role} timestamp=${sanitizeAndClip(record.entry.timestamp || "unknown", 100)}`,
    record.content,
  ].join("\n");
}

export function recallSession(input: RecallInput): RecallResult {
  const requestedScope = input.params.scope ?? "execution";
  const mode = input.params.mode ?? "text";
  const selected = selectScope(input);
  const scanEntries = selected.entries.slice(-MAX_RECALL_SCAN_ENTRIES);
  const scopedIds = new Set(scanEntries.map((entry) => entry.id));
  const requestedExpansions = [...new Set((input.params.expand ?? []).filter((id) => typeof id === "string" && id))].slice(0, 10);
  const matcher = queryMatcher(input.params.query);
  const records: RecallRecord[] = [];
  const seen = new Set<string>();
  const push = (record: RecallRecord | undefined) => {
    if (!record || seen.has(record.key) || records.length >= MAX_RECALL_RESULTS) return;
    seen.add(record.key);
    records.push(record);
  };

  if (!matcher.error && mode === "text") {
    for (const id of requestedExpansions) {
      if (!scopedIds.has(id)) continue;
      push(textRecord(scanEntries.find((entry) => entry.id === id)!, true));
    }
    for (let index = scanEntries.length - 1; index >= 0 && records.length < MAX_RECALL_RESULTS; index--) {
      const record = textRecord(scanEntries[index], false);
      if (record && matcher.test(record.searchText ?? record.content)) push(record);
    }
  } else if (!matcher.error) {
    const operations = fileOperations(scanEntries);
    for (const id of requestedExpansions) {
      const operation = operations.find((item) => item.callEntry.id === id || item.resultEntry?.id === id);
      if (!operation) continue;
      push(mode === "files" && id === operation.resultEntry?.id
        ? resultExpansion(operation)
        : operationRecord(operation));
    }
    for (let index = operations.length - 1; index >= 0 && records.length < MAX_RECALL_RESULTS; index--) {
      const record = operationRecord(operations[index]);
      if (matcher.test(record.content)) push(record);
    }
  }

  const page = Math.min(MAX_RECALL_PAGE, Math.max(1, Math.floor(input.params.page ?? 1)));
  const totalPages = Math.max(1, Math.ceil(records.length / RECALL_PAGE_SIZE));
  const pageRecords = records.slice((page - 1) * RECALL_PAGE_SIZE, page * RECALL_PAGE_SIZE);
  const outside = requestedExpansions.filter((id) => !scopedIds.has(id));
  const header = [
    "Session recall — historical evidence only; repository state and direct user instructions remain authoritative.",
    `Session: ${sanitizeAndClip(input.sessionId, 200)}`,
    `Requested scope: ${requestedScope}; effective scope: ${selected.effective}; mode: ${mode}.`,
    ...(selected.notice ? [selected.notice] : []),
    ...(selected.entries.length > scanEntries.length
      ? [`Bounded scan: newest ${scanEntries.length} of ${selected.entries.length} in-scope entries.`]
      : []),
    ...(records.length === MAX_RECALL_RESULTS
      ? [`Result limit reached: showing at most ${MAX_RECALL_RESULTS} matches.`]
      : []),
    ...(matcher.error ? [matcher.error] : []),
    ...(outside.length ? [`Ignored expansion IDs outside the bounded effective scope: ${outside.map((id) => sanitizeAndClip(id, 100)).join(", ")}`] : []),
    `Page ${page}/${totalPages}; ${records.length} result${records.length === 1 ? "" : "s"}.`,
  ].join("\n");
  let text = [header, ...pageRecords.map((record) => formatRecord(record, input.sessionId))].join("\n\n");
  if (!pageRecords.length && !matcher.error) text += "\n\nNo historical evidence matched.";
  if (text.length > MAX_RECALL_OUTPUT_CHARS)
    text = `${text.slice(0, MAX_RECALL_OUTPUT_CHARS - 34)}\n[truncated by Continuity]`;
  return {
    text,
    requestedScope,
    effectiveScope: selected.effective,
    page,
    total: records.length,
  };
}
