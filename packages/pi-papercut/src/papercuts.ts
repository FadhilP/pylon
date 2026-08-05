import { randomUUID } from "node:crypto";

export const MAX_MESSAGE_LENGTH = 500;
export const MAX_NOTE_LENGTH = 500;
export const MAX_METADATA_LENGTH = 200;
export const MAX_RECORDS = 1_000;

export type PapercutStatus = "open" | "resolved" | "dismissed";
export type CaptureSource = {
  sessionId?: string;
  provider?: string;
  model?: string;
};
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

const isMetadata = (value: unknown) => value === undefined
  || typeof value === "string" && value.length <= MAX_METADATA_LENGTH;
const isSource = (value: any): value is CaptureSource => value && typeof value === "object"
  && isMetadata(value.sessionId) && isMetadata(value.provider) && isMetadata(value.model);
const boundedSource = (source: CaptureSource): CaptureSource => Object.fromEntries(
  Object.entries(source)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => [key, value.replace(/[\u0000-\u001f\u007f]/g, "�").slice(0, MAX_METADATA_LENGTH)]),
);
const isTimestamp = (value: unknown) => typeof value === "string" && !Number.isNaN(Date.parse(value));

export function isPapercutState(value: any): value is PapercutState {
  return Boolean(value && value.version === 1 && typeof value.projectRoot === "string"
    && isTimestamp(value.createdAt) && isTimestamp(value.updatedAt)
    && Array.isArray(value.records) && value.records.length <= MAX_RECORDS
    && new Set(value.records.map((record: any) => record?.id)).size === value.records.length
    && value.records.every((record: any) => record && typeof record.id === "string" && record.id
      && typeof record.message === "string" && record.message.length > 0 && record.message.length <= MAX_MESSAGE_LENGTH
      && ["open", "resolved", "dismissed"].includes(record.status)
      && Number.isSafeInteger(record.occurrences) && record.occurrences >= 1
      && isSource(record.source) && isSource(record.lastSource)
      && isTimestamp(record.createdAt) && isTimestamp(record.updatedAt) && isTimestamp(record.lastSeenAt)
      && (record.resolution === undefined || typeof record.resolution === "string" && record.resolution.length <= MAX_NOTE_LENGTH)
      && (record.resolvedAt === undefined || isTimestamp(record.resolvedAt))
      && (record.dismissal === undefined || typeof record.dismissal === "string" && record.dismissal.length <= MAX_NOTE_LENGTH)
      && (record.dismissedAt === undefined || isTimestamp(record.dismissedAt))));
}

export function emptyState(projectRoot: string, now = new Date().toISOString()): PapercutState {
  return { version: 1, projectRoot, createdAt: now, updatedAt: now, records: [] };
}

export function cleanText(value: string, maxLength: number, name: string) {
  const cleaned = value.normalize("NFKC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) throw new Error(`${name} is required`);
  if (cleaned.length > maxLength) throw new Error(`${name} must be at most ${maxLength} characters`);
  if (secretPatterns.some((pattern) => pattern.test(cleaned)))
    throw new Error(`${name} rejected: possible credential`);
  return cleaned;
}

export const normalizedMessage = (message: string) => message.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");

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
  const duplicate = next.records.find((record) =>
    record.status === "open" && normalizedMessage(record.message) === normalizedMessage(message));
  if (duplicate) {
    duplicate.occurrences++;
    duplicate.lastSeenAt = now;
    duplicate.updatedAt = now;
    duplicate.lastSource = safeSource;
    next.updatedAt = now;
    return { state: next, record: duplicate, duplicate: true };
  }
  if (next.records.length >= MAX_RECORDS)
    throw new Error(`papercut storage limit reached (${MAX_RECORDS} records)`);
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
  const selected = ids.map((prefix) => {
    const matches = records.filter((record) => record.id === prefix || record.id.startsWith(prefix));
    if (!matches.length) throw new Error(`unknown papercut id: ${prefix}`);
    if (matches.length > 1)
      throw new Error(`ambiguous papercut id: ${prefix}; matches: ${matches.map((record) => record.id).join(", ")}`);
    return matches[0];
  });
  if (new Set(selected.map((record) => record.id)).size !== selected.length)
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
  const note = rawNote === undefined || !rawNote.trim()
    ? undefined
    : cleanText(rawNote, MAX_NOTE_LENGTH, action === "resolve" ? "resolution" : "reason");
  if (action === "resolve" && !note) throw new Error("resolution is required when resolving papercuts");
  if (action === "reopen" && note) throw new Error("note is not valid when reopening papercuts");
  const next = structuredClone(state);
  const selected = selectRecords(next.records, ids);
  for (const record of selected) {
    record.updatedAt = now;
    if (action === "resolve") {
      record.status = "resolved";
      record.resolution = note;
      record.resolvedAt = now;
      delete record.dismissal;
      delete record.dismissedAt;
    } else if (action === "dismiss") {
      record.status = "dismissed";
      record.dismissal = note;
      record.dismissedAt = now;
      delete record.resolution;
      delete record.resolvedAt;
    } else {
      record.status = "open";
      delete record.resolution;
      delete record.resolvedAt;
      delete record.dismissal;
      delete record.dismissedAt;
    }
  }
  next.updatedAt = now;
  return { state: next, records: selected };
}

export function listPapercuts(state: PapercutState, status: PapercutStatus | "all" = "open", limit = 50) {
  return state.records
    .filter((record) => status === "all" || record.status === status)
    .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
    .slice(0, limit);
}
