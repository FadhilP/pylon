import { randomUUID } from "node:crypto";

export const MAX_MESSAGE_LENGTH = 500;
export const MAX_NOTE_LENGTH = 500;
export const MAX_METADATA_LENGTH = 200;
export const MAX_RECORDS = 1_000;

export type PapercutStatus = "open" | "resolved" | "dismissed";
export type CaptureSource = { sessionId?: string; provider?: string; model?: string };
export type PapercutRecord = {
  id: string;
  message: string;
  status: PapercutStatus;
  occurrences: number;
  source: CaptureSource;
  lastSource: CaptureSource;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  resolution?: string;
  resolvedAt?: string;
  dismissal?: string;
  dismissedAt?: string;
};
export type PapercutState = {
  version: 1;
  projectRoot: string;
  createdAt: string;
  updatedAt: string;
  records: PapercutRecord[];
};

const secretPatterns = [
  /-----BEGIN [^-]+PRIVATE KEY-----/i,
  /\b(?:sk-ant-|sk-proj-|ghp_|github_pat_|AIza|xox[baprs]-)[\w.-]{10,}/,
  /\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/,
  /\b(?:api[_-]?key|token|password|secret|cookie)\s*[:=]\s*\S+/i,
  /["'](?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|cookie)["']\s*:\s*["'][^"']{6,}/i,
];

const isMetadata = (value: unknown) =>
  value === undefined || (typeof value === "string" && value.length <= MAX_METADATA_LENGTH);
const isSource = (value: any): value is CaptureSource =>
  value &&
  typeof value === "object" &&
  isMetadata(value.sessionId) &&
  isMetadata(value.provider) &&
  isMetadata(value.model);
const boundedSource = (source: CaptureSource): CaptureSource =>
  Object.fromEntries(
    Object.entries(source)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, value]) => [key, value.replace(/[\u0000-\u001f\u007f]/g, "�").slice(0, MAX_METADATA_LENGTH)]),
  );
const isTimestamp = (value: unknown) => typeof value === "string" && !Number.isNaN(Date.parse(value));

const isNote = (value: unknown) =>
  value === undefined || (typeof value === "string" && value.length <= MAX_NOTE_LENGTH);
const isOptionalTimestamp = (value: unknown) => value === undefined || isTimestamp(value);

function isPapercutRecord(record: any): record is PapercutRecord {
  return (
    Boolean(record) &&
    typeof record.id === "string" &&
    record.id.length > 0 &&
    typeof record.message === "string" &&
    record.message.length > 0 &&
    record.message.length <= MAX_MESSAGE_LENGTH &&
    ["open", "resolved", "dismissed"].includes(record.status) &&
    Number.isSafeInteger(record.occurrences) &&
    record.occurrences >= 1 &&
    isSource(record.source) &&
    isSource(record.lastSource) &&
    isTimestamp(record.createdAt) &&
    isTimestamp(record.updatedAt) &&
    isTimestamp(record.lastSeenAt) &&
    isNote(record.resolution) &&
    isOptionalTimestamp(record.resolvedAt) &&
    isNote(record.dismissal) &&
    isOptionalTimestamp(record.dismissedAt)
  );
}

function hasUniqueIds(records: any[]) {
  return new Set(records.map(record => record?.id)).size === records.length;
}

export function isPapercutState(value: any): value is PapercutState {
  return (
    Boolean(value) &&
    value.version === 1 &&
    typeof value.projectRoot === "string" &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt) &&
    Array.isArray(value.records) &&
    value.records.length <= MAX_RECORDS &&
    hasUniqueIds(value.records) &&
    value.records.every(isPapercutRecord)
  );
}

export function emptyState(projectRoot: string, now = new Date().toISOString()): PapercutState {
  return { version: 1, projectRoot, createdAt: now, updatedAt: now, records: [] };
}

export function cleanText(value: string, maxLength: number, name: string) {
  const cleaned = value
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) throw new Error(`${name} is required`);
  if (cleaned.length > maxLength) throw new Error(`${name} must be at most ${maxLength} characters`);
  if (secretPatterns.some(pattern => pattern.test(cleaned))) throw new Error(`${name} rejected: possible credential`);
  return cleaned;
}

export const normalizedMessage = (message: string) =>
  message.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");

export function capturePapercut(
  state: PapercutState,
  rawMessage: string,
  source: CaptureSource,
  now = new Date().toISOString(),
  id = randomUUID(),
) {
  const message = cleanText(rawMessage, MAX_MESSAGE_LENGTH, "message");
  const safeSource = boundedSource(source);
  const next = structuredClone(state);
  const duplicate = next.records.find(
    record => record.status === "open" && normalizedMessage(record.message) === normalizedMessage(message),
  );
  if (duplicate) {
    duplicate.occurrences++;
    duplicate.lastSeenAt = now;
    duplicate.updatedAt = now;
    duplicate.lastSource = safeSource;
    next.updatedAt = now;
    return { state: next, record: duplicate, duplicate: true };
  }
  if (next.records.length >= MAX_RECORDS) throw new Error(`papercut storage limit reached (${MAX_RECORDS} records)`);
  const record: PapercutRecord = {
    id,
    message,
    status: "open",
    occurrences: 1,
    source: safeSource,
    lastSource: safeSource,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  };
  next.records.push(record);
  next.updatedAt = now;
  return { state: next, record, duplicate: false };
}

export type LifecycleAction = "resolve" | "dismiss" | "reopen";

function selectRecords(records: PapercutRecord[], ids: string[]) {
  if (!ids.length) throw new Error("at least one papercut id is required");
  const selected = ids.map(prefix => {
    const matches = records.filter(record => record.id === prefix || record.id.startsWith(prefix));
    if (!matches.length) throw new Error(`unknown papercut id: ${prefix}`);
    if (matches.length > 1)
      throw new Error(`ambiguous papercut id: ${prefix}; matches: ${matches.map(record => record.id).join(", ")}`);
    return matches[0];
  });
  if (new Set(selected.map(record => record.id)).size !== selected.length)
    throw new Error("papercut ids must identify distinct records");
  return selected;
}

export function updatePapercuts(
  state: PapercutState,
  action: LifecycleAction,
  ids: string[],
  rawNote?: string,
  now = new Date().toISOString(),
) {
  const note =
    rawNote === undefined || !rawNote.trim()
      ? undefined
      : cleanText(rawNote, MAX_NOTE_LENGTH, action === "resolve" ? "resolution" : "reason");
  if (action === "resolve" && !note) throw new Error("resolution is required when resolving papercuts");
  if (action === "reopen" && note) throw new Error("note is not valid when reopening papercuts");
  const next = structuredClone(state);
  const selected = selectRecords(next.records, ids);
  for (const record of selected) {
    record.updatedAt = now;
    // Every lifecycle move clears both outcomes first, then writes at most one back.
    delete record.resolution;
    delete record.resolvedAt;
    delete record.dismissal;
    delete record.dismissedAt;
    if (action === "resolve") {
      record.status = "resolved";
      record.resolution = note;
      record.resolvedAt = now;
    } else if (action === "dismiss") {
      record.status = "dismissed";
      record.dismissal = note;
      record.dismissedAt = now;
    } else {
      record.status = "open";
    }
  }
  next.updatedAt = now;
  return { state: next, records: selected };
}

export type PapercutMutation =
  | { action: "edit"; id: string; expectedUpdatedAt: string; message: string }
  | { action: "delete"; id: string; expectedUpdatedAt: string };
export type PapercutMutationErrorCode = "stale" | "duplicate" | "invalid";

export class PapercutMutationError extends Error {
  readonly code: PapercutMutationErrorCode;
  constructor(code: PapercutMutationErrorCode, message: string) {
    super(message);
    this.name = "PapercutMutationError";
    this.code = code;
  }
}
export function mutatePapercut(state: PapercutState, input: PapercutMutation, now = new Date().toISOString()) {
  const next = structuredClone(state);
  const index = next.records.findIndex(record => record.id === input.id);
  const record = next.records[index];
  if (!record || record.updatedAt !== input.expectedUpdatedAt)
    throw new PapercutMutationError("stale", "Papercut changed or was removed");
  const mutationAt = new Date(Math.max(Date.parse(now), Date.parse(record.updatedAt) + 1)).toISOString();
  if (input.action === "delete") {
    next.records.splice(index, 1);
    next.updatedAt = mutationAt;
    return { state: next };
  }
  let message: string;
  try {
    message = cleanText(input.message, MAX_MESSAGE_LENGTH, "message");
  } catch {
    throw new PapercutMutationError("invalid", "Papercut message is invalid");
  }
  if (
    record.status === "open" &&
    next.records.some(
      (item, itemIndex) =>
        itemIndex !== index && item.status === "open" && normalizedMessage(item.message) === normalizedMessage(message),
    )
  ) {
    throw new PapercutMutationError("duplicate", "Another open papercut already uses this message");
  }
  record.message = message;
  record.updatedAt = mutationAt;
  next.updatedAt = mutationAt;
  return { state: next, record };
}

export function listPapercuts(state: PapercutState, status: PapercutStatus | "all" = "open", limit = 50) {
  return [...state.records]
    .filter(record => status === "all" || record.status === status)
    .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt) || left.id.localeCompare(right.id))
    .slice(0, limit);
}

export function queryPapercuts(
  state: PapercutState,
  status: PapercutStatus | "all" = "open",
  query = "",
  offset = 0,
  limit = 25,
) {
  const needle = normalizedMessage(query);
  const records = [...state.records]
    .filter(record => status === "all" || record.status === status)
    .filter(
      record =>
        !needle ||
        [record.message, record.resolution, record.dismissal].some(
          value => value && normalizedMessage(value).includes(needle),
        ),
    )
    .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt) || left.id.localeCompare(right.id));
  return { records: records.slice(offset, offset + limit), total: records.length };
}
