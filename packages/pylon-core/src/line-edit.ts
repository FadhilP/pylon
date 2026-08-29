import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createReadTool,
  formatSize,
  generateDiffString,
  generateUnifiedPatch,
  truncateHead,
  withFileMutationQueue,
  type EditToolDetails,
  type ExtensionAPI,
  type ReadToolDetails,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TAG_LENGTH = 12;
const MAX_SNAPSHOTS_PER_PATH = 32;
const CONTEXT_LINES = 4;

type Interval = { start: number; end: number };
type Snapshot = { tag: string; fullHash: string; seen: Interval[] };
type LineEditState = Map<string, Map<string, Snapshot>>;

type LineEditOperation = { operation: string; startLine?: number; endLine?: number; line?: number; newText: string };

/** A 1-indexed line number that exists in the snapshot the edit was resolved against. */
const validLine = (value: number | undefined, lineCount: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= lineCount;

type ParsedOperation = {
  index: number;
  remove: number;
  replacement: string[];
  shiftAt: number;
  delta: number;
  invalidated?: Interval;
};

const readSchema = Type.Object({
  path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: "Line number to start reading from (1-indexed)" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to read" })),
});

const editOperationSchema = Type.Object({
  operation: Type.String({ description: "replace, insert_before, or insert_after" }),
  startLine: Type.Optional(Type.Integer({ minimum: 1, description: "First original line for replace (inclusive)" })),
  endLine: Type.Optional(Type.Integer({ minimum: 1, description: "Last original line for replace (inclusive)" })),
  line: Type.Optional(Type.Integer({ minimum: 1, description: "Original anchor line for insertion" })),
  newText: Type.String({ description: "Final replacement or inserted text, without line-number prefixes" }),
});

const editSchema = Type.Object({
  path: Type.String({ description: "Path to the existing file to edit (relative or absolute)" }),
  revision: Type.String({ description: "Compact revision tag from the latest numbered read or edit result" }),
  edits: Type.Array(editOperationSchema, {
    minItems: 1,
    description: "Non-overlapping operations resolved against the same original numbered snapshot",
  }),
});

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function resolvePath(value: string, cwd: string): string {
  let normalized = value.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") normalized = homedir();
  else if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\")))
    normalized = resolve(homedir(), normalized.slice(2));
  if (/^file:\/\//i.test(normalized)) normalized = fileURLToPath(normalized);
  return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

async function canonicalPath(value: string, cwd: string): Promise<string> {
  const absolute = resolvePath(value, cwd);
  return realpath(absolute).catch(() => absolute);
}

function mergeIntervals(intervals: Interval[], next: Interval): Interval[] {
  const sorted = [...intervals, next].sort((left, right) => left.start - right.start);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (!previous || interval.start > previous.end + 1) merged.push({ ...interval });
    else previous.end = Math.max(previous.end, interval.end);
  }
  return merged;
}

function rangeWasSeen(snapshot: Snapshot, start: number, end: number): boolean {
  return snapshot.seen.some(interval => interval.start <= start && interval.end >= end);
}

function recordSnapshot(
  state: LineEditState,
  path: string,
  fullHash: string,
  seen?: Interval,
  reset = false,
): Snapshot {
  if (reset) state.delete(path);
  const snapshots = state.get(path) ?? new Map<string, Snapshot>();
  const existing = [...snapshots.values()].find(snapshot => snapshot.fullHash === fullHash);
  if (existing) {
    if (seen) existing.seen = mergeIntervals(existing.seen, seen);
    state.set(path, snapshots);
    return existing;
  }

  let length = TAG_LENGTH;
  let tag = fullHash.slice(0, length);
  while (snapshots.has(tag) && snapshots.get(tag)?.fullHash !== fullHash) {
    length = Math.min(fullHash.length, length + 4);
    tag = fullHash.slice(0, length);
    if (length === fullHash.length && snapshots.has(tag))
      throw new Error("Could not issue an unambiguous file revision.");
  }
  const snapshot = { tag, fullHash, seen: seen ? [seen] : [] };
  snapshots.set(tag, snapshot);
  while (snapshots.size > MAX_SNAPSHOTS_PER_PATH) snapshots.delete(snapshots.keys().next().value!);
  state.set(path, snapshots);
  return snapshot;
}

function decodeText(bytes: Uint8Array): { bom: string; text: string; ending: "\n" | "\r\n" } | undefined {
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(hasBom ? bytes.subarray(3) : bytes);
  } catch {
    return undefined;
  }
  let crlf = 0;
  let lf = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\r") {
      if (text[index + 1] !== "\n") return undefined;
      crlf++;
      index++;
    } else if (text[index] === "\n") lf++;
  }
  if (crlf > 0 && lf > 0) return undefined;
  return { bom: hasBom ? "\uFEFF" : "", text: text.replace(/\r\n/g, "\n"), ending: crlf > 0 ? "\r\n" : "\n" };
}

function restoreText(text: string, bom: string, ending: "\n" | "\r\n"): string {
  return bom + (ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text);
}

function numbered(text: string, startLine: number): string {
  return text
    .split("\n")
    .map((line, index) => `${startLine + index}:${line}`)
    .join("\n");
}

function normalizeNewText(text: string): string[] {
  return text.replace(/\r\n|\r/g, "\n").split("\n");
}

/** A parsed operation plus the original lines it claims exclusively. */
type Claimed = { operation: ParsedOperation; claimed: Interval };

function parseReplace(edit: LineEditOperation, position: number, lineCount: number, snapshot: Snapshot): Claimed {
  const start = edit.startLine;
  const end = edit.endLine;
  if (!validLine(start, lineCount) || !validLine(end, lineCount) || end < start)
    throw new Error(`edits[${position}] has an invalid replace range.`);
  if (!rangeWasSeen(snapshot, start, end))
    throw new Error(`Lines ${start}-${end} were not displayed for revision #${snapshot.tag}. Read that range first.`);
  const replacement = edit.newText === "" ? [] : normalizeNewText(edit.newText);
  const remove = end - start + 1;
  return {
    operation: {
      index: start - 1,
      remove,
      replacement,
      shiftAt: end + 1,
      delta: replacement.length - remove,
      invalidated: { start, end },
    },
    claimed: { start, end },
  };
}

function parseInsert(edit: LineEditOperation, position: number, lineCount: number, snapshot: Snapshot): Claimed {
  const line = edit.line;
  if (!validLine(line, lineCount)) throw new Error(`edits[${position}] has an invalid insertion anchor.`);
  if (!edit.newText) throw new Error(`edits[${position}] insertion text must not be empty.`);
  if (!rangeWasSeen(snapshot, line, line))
    throw new Error(`Line ${line} was not displayed for revision #${snapshot.tag}. Read that line first.`);
  const replacement = normalizeNewText(edit.newText);
  const before = edit.operation === "insert_before";
  return {
    operation: {
      index: before ? line - 1 : line,
      remove: 0,
      replacement,
      shiftAt: before ? line : line + 1,
      delta: replacement.length,
    },
    claimed: { start: line, end: line },
  };
}

/**
 * Validates every operation against the same original snapshot and returns them ordered from the
 * end of the file backwards, so applying them in sequence never shifts a later operation's index.
 */
function parseOperations(edits: LineEditOperation[], lineCount: number, snapshot: Snapshot): ParsedOperation[] {
  const parsed: ParsedOperation[] = [];
  const claimedLines = new Set<number>();
  const spliceIndexes = new Set<number>();
  for (const [position, edit] of edits.entries()) {
    if (edit.operation !== "replace" && edit.operation !== "insert_before" && edit.operation !== "insert_after")
      throw new Error(`edits[${position}].operation must be replace, insert_before, or insert_after.`);
    const { operation, claimed } =
      edit.operation === "replace"
        ? parseReplace(edit, position, lineCount, snapshot)
        : parseInsert(edit, position, lineCount, snapshot);

    for (let line = claimed.start; line <= claimed.end; line++) {
      if (!claimedLines.has(line)) {
        claimedLines.add(line);
        continue;
      }
      throw new Error(
        edit.operation === "replace"
          ? `edits[${position}] overlaps another operation at line ${line}.`
          : `edits[${position}] shares an anchor with another operation at line ${line}.`,
      );
    }
    if (spliceIndexes.has(operation.index))
      throw new Error(`edits[${position}] touches the same boundary as another operation; merge the nearby changes.`);
    spliceIndexes.add(operation.index);
    parsed.push(operation);
  }
  return parsed.sort((left, right) => right.index - left.index);
}

/** How far a line at `line` moves once every operation before it has been applied. */
const shiftFor = (line: number, operations: ParsedOperation[], exclude?: ParsedOperation) =>
  operations.reduce(
    (sum, operation) => (operation !== exclude && line >= operation.shiftAt ? sum + operation.delta : sum),
    0,
  );

/** True when an operation replaced the whole span, so the model can no longer vouch for it. */
const isInvalidated = (start: number, end: number, operations: ParsedOperation[]) =>
  operations.some(
    operation => operation.invalidated && operation.invalidated.start <= start && operation.invalidated.end >= end,
  );

/**
 * Maps the ranges the model has already seen onto the edited file, dropping spans an operation
 * replaced and shifting the rest by the net line delta ahead of them.
 */
function carrySeenLines(seen: Interval[], operations: ParsedOperation[]): Interval[] {
  const carried: Interval[] = [];
  for (const interval of seen) {
    const boundaries = new Set([interval.start, interval.end + 1]);
    const within = (line: number) => line > interval.start && line <= interval.end;
    for (const operation of operations) {
      if (within(operation.shiftAt)) boundaries.add(operation.shiftAt);
      if (!operation.invalidated) continue;
      if (within(operation.invalidated.start)) boundaries.add(operation.invalidated.start);
      if (within(operation.invalidated.end + 1)) boundaries.add(operation.invalidated.end + 1);
    }
    const points = [...boundaries].sort((left, right) => left - right);
    for (let index = 0; index < points.length - 1; index++) {
      const start = points[index];
      const end = points[index + 1] - 1;
      if (isInvalidated(start, end, operations)) continue;
      const shift = shiftFor(start, operations);
      const mapped = { start: start + shift, end: end + shift };
      if (mapped.start >= 1 && mapped.end >= mapped.start)
        carried.splice(0, carried.length, ...mergeIntervals(carried, mapped));
    }
  }
  return carried;
}

/** Ranges the model authored in this edit; it may edit those again without re-reading them. */
function authoredSeenLines(operations: ParsedOperation[]): Interval[] {
  const authored: Interval[] = [];
  for (const operation of operations) {
    if (operation.replacement.length === 0) continue;
    const base = operation.index + 1;
    const start = base + shiftFor(base, operations, operation);
    const interval = { start, end: start + operation.replacement.length - 1 };
    authored.splice(0, authored.length, ...mergeIntervals(authored, interval));
  }
  return authored;
}

function lineContext(text: string, firstChangedLine: number | undefined): { text: string; interval: Interval } {
  const lines = text.split("\n");
  const center = Math.max(1, Math.min(firstChangedLine ?? 1, lines.length));
  const start = Math.max(1, center - CONTEXT_LINES);
  const end = Math.min(lines.length, center + CONTEXT_LINES);
  return { text: numbered(lines.slice(start - 1, end).join("\n"), start), interval: { start, end } };
}

const READ_GUIDELINES = [
  "Use read before edit; copy the returned revision tag and absolute line numbers into edit.",
  "Use read offset/limit to re-ground only the range needed after lines shift.",
];
const EDIT_GUIDELINES = [
  "Use edit only with a revision and line numbers returned by numbered read or the latest edit result.",
  "All edits in one edit call refer to the same original snapshot; use replace for inclusive ranges and insert_before/insert_after for additions.",
  "Combine disjoint changes to one file in one edit call. Re-read a small range when a prior edit shifted unknown line numbers.",
];

/** Appends the continuation hint that tells the model how to read the rest of the file. */
function continuationNote(
  truncation: ReturnType<typeof truncateHead>,
  bounds: { startLine: number; endLine: number; selectedEnd: number; totalLines: number },
): string {
  const { startLine, endLine, selectedEnd, totalLines } = bounds;
  if (truncation.truncated) {
    const range = `Showing lines ${startLine}-${endLine} of ${totalLines}`;
    const limit = truncation.truncatedBy === "lines" ? "" : ` (${formatSize(truncation.maxBytes)} limit)`;
    return `\n\n[${range}${limit}. Use offset=${endLine + 1} to continue.]`;
  }
  if (selectedEnd < totalLines)
    return `\n\n[${totalLines - selectedEnd} more lines in file. Use offset=${selectedEnd + 1} to continue.]`;
  return "";
}

async function numberedRead(
  snapshots: LineEditState,
  toolCallId: string,
  params: any,
  signal: any,
  onUpdate: any,
  ctx: any,
) {
  const path = await canonicalPath(params.path, ctx.cwd);
  const before = await readFile(path);
  const result = await createReadTool(ctx.cwd).execute(toolCallId, params, signal, onUpdate);
  const after = await readFile(path);
  const fullHash = hashBytes(before);
  if (hashBytes(after) !== fullHash) throw new Error(`File changed while reading ${params.path}. Read it again.`);
  if (result.content.some(block => block.type !== "text")) return result;

  const decoded = decodeText(before);
  if (!decoded) {
    return {
      ...result,
      content: result.content.map(block =>
        block.type === "text"
          ? {
              ...block,
              text: `${block.text}\n\n[Numbered line editing is unavailable for this encoding or mixed line endings.]`,
            }
          : block,
      ),
    };
  }

  const lines = decoded.text.split("\n");
  const startIndex = params.offset ? Math.max(0, params.offset - 1) : 0;
  const selectedEnd = params.limit === undefined ? lines.length : Math.min(lines.length, startIndex + params.limit);
  const truncation = truncateHead(lines.slice(startIndex, selectedEnd).join("\n"));
  if (truncation.firstLineExceedsLimit || truncation.outputLines < 1) return result;

  const startLine = startIndex + 1;
  const endLine = startLine + truncation.outputLines - 1;
  const snapshot = recordSnapshot(snapshots, path, fullHash, { start: startLine, end: endLine });
  const output =
    `[${params.path}#${snapshot.tag}]\n${numbered(truncation.content, startLine)}` +
    continuationNote(truncation, { startLine, endLine, selectedEnd, totalLines: lines.length });
  const details: ReadToolDetails & { lineEdit: { version: 1; revision: string; startLine: number; endLine: number } } =
    { ...(result.details ?? {}), lineEdit: { version: 1, revision: snapshot.tag, startLine, endLine } };
  return { content: [{ type: "text" as const, text: output }], details };
}

/**
 * Reports what actually landed on disk. When the persisted bytes survived unchanged the model keeps
 * the ranges it has already seen; otherwise something transformed the file and it gets a fresh,
 * narrow context window around the first change instead.
 */
function describeEditOutcome(
  params: any,
  path: string,
  snapshots: LineEditState,
  outcome: {
    persistedMatches: boolean;
    afterBytes: Uint8Array;
    afterText: string | undefined;
    carriedSeen: Interval[];
    operations: ParsedOperation[];
    firstChangedLine: number | undefined;
  },
) {
  const { persistedMatches, afterBytes, afterText, carriedSeen, operations, firstChangedLine } = outcome;
  const details: { revision?: string; coverage?: Interval } = {};
  let message = persistedMatches
    ? `Successfully applied ${params.edits.length} line operation(s) to ${params.path}.`
    : `Applied ${params.edits.length} line operation(s) to ${params.path}, but the file was transformed while saving.`;

  if (afterText === undefined) {
    message += "\n\nThe persisted file encoding or line endings changed; read it again before another edit.";
    return { message, details };
  }
  const currentHash = hashBytes(afterBytes);
  if (persistedMatches) {
    const next = recordSnapshot(snapshots, path, currentHash, undefined, true);
    for (const interval of [...carriedSeen, ...authoredSeenLines(operations)])
      recordSnapshot(snapshots, path, currentHash, interval);
    details.revision = next.tag;
    message += ` New revision: [${params.path}#${next.tag}].`;
    return { message, details };
  }
  const context = lineContext(afterText, firstChangedLine);
  const next = recordSnapshot(snapshots, path, currentHash, context.interval, true);
  details.revision = next.tag;
  details.coverage = context.interval;
  message += `\n[${params.path}#${next.tag}]\n${context.text}`;
  message += "\n\n[The revision and context above describe what actually persisted.]";
  return { message, details };
}

async function numberedEdit(snapshots: LineEditState, params: any, signal: AbortSignal | undefined, ctx: any) {
  if (!params.edits.length) throw new Error("edits must contain at least one operation.");
  const path = await canonicalPath(params.path, ctx.cwd);
  return withFileMutationQueue(path, async () => {
    const throwIfAborted = () => {
      if (signal?.aborted) throw new Error("Operation aborted");
    };
    throwIfAborted();
    await access(path, constants.R_OK | constants.W_OK);
    const beforeBytes = await readFile(path);
    throwIfAborted();

    const snapshot = snapshots.get(path)?.get(params.revision);
    if (!snapshot)
      throw new Error(`Revision #${params.revision} was not issued for ${params.path}. Read the file again.`);
    if (hashBytes(beforeBytes) !== snapshot.fullHash)
      throw new Error(`File changed after revision #${params.revision}. Read the affected range again.`);
    const decoded = decodeText(beforeBytes);
    if (!decoded) throw new Error("Numbered editing supports UTF-8 files with consistent LF or CRLF line endings.");

    const original = decoded.text;
    const lines = original.split("\n");
    const operations = parseOperations(params.edits, lines.length, snapshot);
    const nextLines = [...lines];
    for (const operation of operations) nextLines.splice(operation.index, operation.remove, ...operation.replacement);
    const intended = nextLines.join("\n");
    if (intended === original) throw new Error(`No changes made to ${params.path}.`);

    const persisted = restoreText(intended, decoded.bom, decoded.ending);
    throwIfAborted();
    const latestBytes = await readFile(path);
    if (hashBytes(latestBytes) !== snapshot.fullHash)
      throw new Error(`File changed while preparing the edit for revision #${params.revision}. Read it again.`);
    throwIfAborted();
    await writeFile(path, persisted, "utf8");

    const afterBytes = await readFile(path);
    const afterText = decodeText(afterBytes)?.text;
    const diff = generateDiffString(original, afterText ?? intended);
    const persistedMatches = Buffer.from(persisted, "utf8").compare(afterBytes) === 0;
    const carriedSeen = persistedMatches ? carrySeenLines(snapshot.seen, operations) : [];
    snapshots.delete(path);

    const outcome = describeEditOutcome(params, path, snapshots, {
      persistedMatches,
      afterBytes,
      afterText,
      carriedSeen,
      operations,
      firstChangedLine: diff.firstChangedLine,
    });
    const details: EditToolDetails & { revision?: string; coverage?: Interval } = {
      diff: diff.diff,
      patch: generateUnifiedPatch(params.path, original, afterText ?? intended),
      firstChangedLine: diff.firstChangedLine,
      ...outcome.details,
    };
    return { content: [{ type: "text" as const, text: outcome.message }], details };
  });
}

export function registerLineEditTools(pi: ExtensionAPI): void {
  const snapshots: LineEditState = new Map();

  pi.registerTool({
    name: "read",
    label: "read (numbered)",
    description:
      "Read a file with absolute line numbers and a compact revision tag for guarded line edits. Text output is truncated to 2000 lines or 50KB. Images pass through unchanged.",
    promptSnippet: "Read files with numbered lines and revision tags for guarded edits",
    promptGuidelines: READ_GUIDELINES,
    parameters: readSchema,
    execute: (toolCallId, params, signal, onUpdate, ctx) =>
      numberedRead(snapshots, toolCallId, params, signal, onUpdate, ctx),
  });

  pi.registerTool({
    name: "edit",
    label: "edit (numbered)",
    description:
      "Edit an existing text file by guarded absolute line ranges. A revision from the latest numbered read or edit result is required. All operations use the original line numbers and apply together.",
    promptSnippet: "Edit numbered file lines with compact revision guards",
    promptGuidelines: EDIT_GUIDELINES,
    parameters: editSchema,
    execute: (_toolCallId, params, signal, _onUpdate, ctx) => numberedEdit(snapshots, params, signal, ctx),
  });
}
