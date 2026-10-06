import { createHash } from "node:crypto";
import {
  buildSessionContext,
  estimateTokens,
  type CompactionEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  MAX_COMPACTION_DISPLAY_HISTORY_ITEMS,
  MAX_COMPACTION_DISPLAY_PATH,
  MAX_COMPACTION_DISPLAY_RECORDS,
  MAX_COMPACTION_DISPLAY_SOURCE_ID,
  MAX_COMPACTION_DISPLAY_TEXT,
} from "../../shared/protocol/events.ts";
import type { CompactionDisplayReadModel, MessageReadModel } from "../../shared/protocol/events.ts";
import { projectConversation } from "./projections.ts";

/** Read models for continuity compaction entries shown in the web transcript. */

const PYLON_COMPACTION_SOURCE = "pylon-compaction";

function compactionSourceEntryCount(details: unknown): number | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const raw = details as Record<string, unknown>;
  return raw.type === "pi-continuity-compaction" &&
    (raw.version === 1 || raw.version === 2 || raw.version === 3) &&
    Number.isSafeInteger(raw.sourceEntryCount) &&
    Number(raw.sourceEntryCount) >= 0
    ? Number(raw.sourceEntryCount)
    : undefined;
}

function compactionDisplay(details: unknown): CompactionDisplayReadModel | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const raw = details as Record<string, unknown>;
  const bounded = (value: unknown, maximum: number, required = false) =>
    typeof value === "string" && value.length <= maximum && (!required || value.length > 0);
  const historyRecord = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    return (
      bounded(item.path, MAX_COMPACTION_DISPLAY_PATH, true) &&
      (item.sourceEntryId === undefined || bounded(item.sourceEntryId, MAX_COMPACTION_DISPLAY_SOURCE_ID))
    );
  };
  const record = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    return (
      bounded(item.sourceEntryId, MAX_COMPACTION_DISPLAY_SOURCE_ID, true) &&
      (item.role === "user" || item.role === "assistant" || item.role === "tool" || item.role === "summary") &&
      bounded(item.text, MAX_COMPACTION_DISPLAY_TEXT, true) &&
      (item.isError === undefined || typeof item.isError === "boolean")
    );
  };
  const supplement = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    return (
      bounded(item.sourceEntryId, MAX_COMPACTION_DISPLAY_SOURCE_ID, true) &&
      (item.role === "user" || item.role === "assistant" || item.role === "tool") &&
      (item.category === "constraint" ||
        item.category === "decision" ||
        item.category === "error" ||
        item.category === "outcome" ||
        item.category === "context") &&
      bounded(item.quote, 800, true) &&
      typeof item.sourceHash === "string" &&
      /^[a-f0-9]{64}$/.test(item.sourceHash) &&
      typeof item.quoteHash === "string" &&
      item.quoteHash ===
        createHash("sha256")
          .update(item.quote as string)
          .digest("hex")
    );
  };
  const history = raw.history as Record<string, unknown> | undefined;
  const generic = raw.mode === "generic";
  const activeWork = raw.mode === "active-work";
  // Persisted detail versions are trusted only when their exact shape is known.
  if (
    raw.type !== "pi-continuity-compaction" ||
    raw.version !== 3 ||
    (!generic && !activeWork) ||
    !Number.isSafeInteger(raw.sourceEntryCount) ||
    Number(raw.sourceEntryCount) < 0 ||
    (raw.currentTaskEntryId !== undefined && !bounded(raw.currentTaskEntryId, MAX_COMPACTION_DISPLAY_SOURCE_ID)) ||
    (activeWork &&
      (!bounded(raw.runId, MAX_COMPACTION_DISPLAY_SOURCE_ID, true) ||
        !bounded(raw.timelineId, MAX_COMPACTION_DISPLAY_SOURCE_ID, true) ||
        (raw.handoffEntryId !== undefined && !bounded(raw.handoffEntryId, MAX_COMPACTION_DISPLAY_SOURCE_ID)))) ||
    !history ||
    Array.isArray(history) ||
    !Array.isArray(history.read) ||
    history.read.length > MAX_COMPACTION_DISPLAY_HISTORY_ITEMS ||
    !history.read.every(historyRecord) ||
    !Array.isArray(history.modified) ||
    history.modified.length > MAX_COMPACTION_DISPLAY_HISTORY_ITEMS ||
    !history.modified.every(historyRecord) ||
    !Array.isArray(raw.supplements) ||
    raw.supplements.length > 8 ||
    !raw.supplements.every(supplement) ||
    ((generic || raw.records !== undefined) &&
      (!Array.isArray(raw.records) ||
        raw.records.length > MAX_COMPACTION_DISPLAY_RECORDS ||
        !raw.records.every(record)))
  )
    return undefined;
  const records = Array.isArray(raw.records)
    ? (raw.records as Array<Record<string, unknown>>)
    : (raw.supplements as Array<Record<string, unknown>>).map(item => ({
        sourceEntryId: item.sourceEntryId,
        role: item.role,
        text: item.quote,
        ...(item.category === "error" ? { isError: true } : {}),
      }));
  const source = (item: Record<string, unknown>) => ({
    sourceEntryId: item.sourceEntryId as string,
    text: item.text as string,
  });
  const historySource = (item: unknown) => {
    const record = item as Record<string, unknown>;
    return {
      path: record.path as string,
      ...(typeof record.sourceEntryId === "string" ? { sourceEntryId: record.sourceEntryId } : {}),
    };
  };
  return {
    records: records.flatMap(item =>
      item.role === "user" || item.role === "assistant" ? [{ ...source(item), role: item.role }] : [],
    ),
    failedTools: records.flatMap(item => (item.role === "tool" && item.isError === true ? [source(item)] : [])),
    toolResults: records.flatMap(item => (item.role === "tool" && item.isError !== true ? [source(item)] : [])),
    history: {
      read: (history.read as unknown[]).map(historySource),
      modified: (history.modified as unknown[]).map(historySource),
    },
  };
}

export function compactionTranscriptMessage(branch: SessionEntry[], entry: CompactionEntry): Record<string, unknown> {
  const contextAfter = buildSessionContext(branch, entry.id).messages;
  const estimatedContextAfter = contextAfter.reduce((total, message) => total + estimateTokens(message), 0);
  const contextAfterTokens = Number.isFinite(estimatedContextAfter)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, estimatedContextAfter))
    : 0;
  const contextBeforeTokens =
    Number.isSafeInteger(entry.tokensBefore) && entry.tokensBefore >= 0 ? entry.tokensBefore : undefined;
  const sourceEntryCount = compactionSourceEntryCount(entry.details);
  const display = compactionDisplay(entry.details);
  return {
    role: "custom",
    customType: PYLON_COMPACTION_SOURCE,
    display: true,
    content: entry.summary,
    entryId: entry.id,
    timestamp: entry.timestamp,
    compaction: {
      contextAfterTokens,
      ...(contextBeforeTokens === undefined ? {} : { contextBeforeTokens }),
      ...(sourceEntryCount === undefined ? {} : { sourceEntryCount }),
      ...(display ? { display } : {}),
    },
  };
}

export function projectedCompactionMessage(
  branch: SessionEntry[],
  entry: CompactionEntry,
): MessageReadModel | undefined {
  const message = projectConversation([compactionTranscriptMessage(branch, entry)], { limitMessages: false })
    .messages[0];
  return message ? { ...message, id: `compaction-${entry.id}` } : undefined;
}
