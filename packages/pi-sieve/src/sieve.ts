import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SIEVE_THRESHOLD = 8_192;
export const PLAIN_ELIGIBLE_TOOL_NAMES = ["bash", "grep", "find", "ls", "rg", "fd", "heartbeat_status", "memory"] as const;
export const RANKED_SEARCH_TOOL_NAMES = ["symbol_search", "code_search"] as const;
export const RELATIONSHIP_GRAPH_TOOL_NAME = "relationship_graph";
export const ELIGIBLE_TOOL_NAMES = [
  ...PLAIN_ELIGIBLE_TOOL_NAMES,
  ...RANKED_SEARCH_TOOL_NAMES,
  RELATIONSHIP_GRAPH_TOOL_NAME,
] as const;
export const READ_TOOL_NAME = "read";
export const RECALL_TOOL_NAME = "sieve_recall";
export const RECENT_WINDOW_POLICY =
  "Age 0 is preserved when active pruning is disabled; successful eligible age-1 output is capped at the threshold with active pruning, or three times the threshold without it.";
export const GIANT_ERROR_TAIL_CHARS = 2_048;

export type SieveOptions = {
  pruneActive?: boolean;
  cwd?: string;
};

export type EligibleToolName = (typeof ELIGIBLE_TOOL_NAMES)[number];

export type ContextMessage = {
  role?: unknown;
};

export type TextBlock = {
  type: "text";
  text: string;
  [field: string]: unknown;
};

export type SkipStats = {
  recentWindow: number;
  ineligibleTool: number;
  error: number;
  nonTextMixedOrEmptyContent: number;
  malformedStructuredContent: number;
  atOrBelowThreshold: number;
  recoveryUnavailable: number;
};

export type TransformStats = {
  /** Tool results inspected by the sieve. */
  scanned: number;
  /** Results that qualify for replacement (or projection in observe mode). */
  transformed: number;
  /** Classification of transformations. */
  transformedBy: {
    ageThreshold: number;
    budget: number;
    giantError: number;
    activeThreshold: number;
    staleRead: number;
  };
  /** Source text characters omitted (or projected to be omitted). */
  omittedChars: number;
  /** Omitted text characters less the replacement marker characters. */
  netCharsSaved: number;
  skipped: SkipStats;
};

export type RecoverableActiveResult = {
  toolCallId: string;
  toolName: string;
  content: TextBlock[];
  isError: boolean;
};

export type TransformResult<T extends ContextMessage> = {
  messages: T[];
  stats: TransformStats;
  recoverableActiveResults: RecoverableActiveResult[];
};

const eligibleTools = new Set<string>(ELIGIBLE_TOOL_NAMES);
const rankedSearchTools = new Set<string>(RANKED_SEARCH_TOOL_NAMES);

export function emptyTransformStats(): TransformStats {
  return {
    scanned: 0,
    transformed: 0,
    transformedBy: { ageThreshold: 0, budget: 0, giantError: 0, activeThreshold: 0, staleRead: 0 },
    omittedChars: 0,
    netCharsSaved: 0,
    skipped: {
      recentWindow: 0,
      ineligibleTool: 0,
      error: 0,
      nonTextMixedOrEmptyContent: 0,
      malformedStructuredContent: 0,
      atOrBelowThreshold: 0,
      recoveryUnavailable: 0,
    },
  };
}

/** Adds source stats to target, preserving the target object for runtime totals. */
export function addTransformStats(target: TransformStats, source: TransformStats): TransformStats {
  target.scanned += source.scanned;
  target.transformed += source.transformed;
  target.transformedBy.ageThreshold += source.transformedBy.ageThreshold;
  target.transformedBy.budget += source.transformedBy.budget;
  target.transformedBy.giantError += source.transformedBy.giantError;
  target.transformedBy.activeThreshold += source.transformedBy.activeThreshold;
  target.transformedBy.staleRead += source.transformedBy.staleRead;
  target.omittedChars += source.omittedChars;
  target.netCharsSaved += source.netCharsSaved;
  target.skipped.recentWindow += source.skipped.recentWindow;
  target.skipped.ineligibleTool += source.skipped.ineligibleTool;
  target.skipped.error += source.skipped.error;
  target.skipped.nonTextMixedOrEmptyContent += source.skipped.nonTextMixedOrEmptyContent;
  target.skipped.malformedStructuredContent += source.skipped.malformedStructuredContent;
  target.skipped.atOrBelowThreshold += source.skipped.atOrBelowThreshold;
  target.skipped.recoveryUnavailable += source.skipped.recoveryUnavailable;
  return target;
}

export function omissionMarker(toolName: string, sourceChars: number) {
  return `[pi-sieve: ${toolName} ${sourceChars} chars omitted]`;
}

export function giantErrorMarker(toolName: string, sourceChars: number) {
  return `[pi-sieve: ${toolName} error ${sourceChars} chars truncated]\n`;
}

export function recalledOmissionMarker(toolName: string, sourceChars: number) {
  return `[pi-sieve: recalled ${toolName} ${sourceChars} chars omitted]`;
}

export function recalledGiantErrorMarker(toolName: string, sourceChars: number) {
  return `[pi-sieve: recalled ${toolName} error ${sourceChars} chars truncated]\n`;
}

export function partialOmissionMarker(toolName: string, sourceChars: number, omittedChars: number, recalled = false) {
  return `[pi-sieve: ${recalled ? "recalled " : ""}${toolName} ${sourceChars} chars; ${omittedChars} chars omitted]`;
}

export function activeOmissionMarker(
  toolName: string,
  toolCallId: string,
  sourceChars: number,
  omittedChars: number,
) {
  return `[pi-sieve: OUTPUT TRUNCATED for ${toolName}; ${omittedChars} of ${sourceChars} chars omitted. Recover via sieve_recall(toolCallId=${JSON.stringify(toolCallId)}).]`;
}

export function staleReadMarker(path: string, sourceChars: number) {
  return `[pi-sieve: stale read of ${JSON.stringify(path)} (${sourceChars} chars) omitted; superseded by a post-mutation read]`;
}

function textOnlyBlocks(content: unknown): TextBlock[] | undefined {
  if (!Array.isArray(content) || !content.length) return undefined;
  if (
    content.some(
      (block) =>
        !block ||
        typeof block !== "object" ||
        (block as { type?: unknown }).type !== "text" ||
        typeof (block as { text?: unknown }).text !== "string",
    )
  )
    return undefined;
  return content as TextBlock[];
}

export function textOnlyContentLength(content: unknown): number | undefined {
  const blocks = textOnlyBlocks(content);
  return blocks?.reduce((length, block) => length + block.text.length, 0);
}

function textOnlyContentTail(content: unknown, characters: number): string | undefined {
  const blocks = textOnlyBlocks(content);
  if (!blocks) return undefined;
  let tail = "";
  for (let index = blocks.length - 1; index >= 0 && tail.length < characters; index--) {
    tail = blocks[index].text.slice(-(characters - tail.length)) + tail;
  }
  return tail;
}

export function effectiveThresholdForAge(age: number, threshold: number) {
  if (age <= 5) return threshold;
  return Math.max(1_000, Math.floor(threshold / 2));
}

type SieveKind = "plain" | "rankedSearch" | "relationshipGraph";
type SieveSource = { toolName: string; isError: boolean; recalled: boolean; kind: SieveKind };

function sourceKind(toolName: string): SieveKind {
  if (rankedSearchTools.has(toolName)) return "rankedSearch";
  if (toolName === RELATIONSHIP_GRAPH_TOOL_NAME) return "relationshipGraph";
  return "plain";
}

function sieveSource(message: ContextMessage, allowRecall: boolean): SieveSource | undefined {
  const fields = message as Record<string, unknown>;
  if (fields.role !== "toolResult" || typeof fields.toolName !== "string") return undefined;
  if (eligibleTools.has(fields.toolName)) {
    const details = fields.details;
    if (fields.toolName === "memory"
      && (!details || typeof details !== "object" || Array.isArray(details) || (details as Record<string, unknown>).memoryList !== true)) return undefined;
    return { toolName: fields.toolName, isError: fields.isError === true, recalled: false, kind: sourceKind(fields.toolName) };
  }
  if (!allowRecall || fields.toolName !== RECALL_TOOL_NAME || fields.isError === true) return undefined;
  const details = fields.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const recall = details as Record<string, unknown>;
  if (
    recall.found !== true ||
    typeof recall.sourceToolName !== "string" ||
    !eligibleTools.has(recall.sourceToolName) ||
    typeof recall.sourceIsError !== "boolean"
  ) return undefined;
  return {
    toolName: recall.sourceToolName,
    isError: recall.sourceIsError,
    recalled: true,
    kind: sourceKind(recall.sourceToolName),
  };
}

function replaceWithMarker<T extends ContextMessage>(message: T, marker: string): T {
  return { ...message, content: [{ type: "text", text: marker }] } as T;
}

type ActiveSlice = { outboundText: string; omittedText: string };
type OldSuccessSlice = ActiveSlice & { retainedChars: number };
type StructuredSlice = { outboundText: string; omittedChars: number; retainedChars: number };

type JsonObject = Record<string, unknown>;

function jsonObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function structuredPruneMetadata(
  source: SieveSource,
  sourceChars: number,
  omittedKey: "omittedResults" | "omittedLocations",
  omittedCount: number,
  toolCallId?: string,
): JsonObject {
  return {
    pruned: true,
    sourceToolName: source.toolName,
    sourceChars,
    [omittedKey]: omittedCount,
    ...(toolCallId ? { recoverVia: { tool: RECALL_TOOL_NAME, toolCallId } } : {}),
  };
}

function structuredMarker(source: SieveSource, sourceChars: number, toolCallId?: string): string {
  return JSON.stringify({
    piSieve: {
      pruned: true,
      sourceToolName: source.toolName,
      sourceChars,
      omitted: true,
      ...(toolCallId ? { recoverVia: { tool: RECALL_TOOL_NAME, toolCallId } } : {}),
    },
  });
}

function parseJsonText(blocks: TextBlock[]): JsonObject | undefined {
  try {
    return jsonObject(JSON.parse(blocks.map((block) => block.text).join("")));
  } catch {
    return undefined;
  }
}

function validStructuredContent(blocks: TextBlock[], kind: Exclude<SieveKind, "plain">): boolean {
  const parsed = parseJsonText(blocks);
  if (!parsed) return false;
  if (kind === "rankedSearch")
    return Array.isArray(parsed.results) && parsed.results.every((result) => jsonObject(result) !== undefined);
  if (!Array.isArray(parsed.files)) return false;
  const paths = new Set<string>();
  for (const file of parsed.files) {
    const value = jsonObject(file);
    if (!value || typeof value.path !== "string" || paths.has(value.path) || !Array.isArray(value.locations)) return false;
    paths.add(value.path);
    for (const location of value.locations) {
      const item = jsonObject(location);
      if (!item || typeof item.line !== "number" || typeof item.text !== "string" || !Array.isArray(item.roles)
        || item.roles.some((role) => typeof role !== "string")) return false;
    }
  }
  return true;
}

function sliceRankedSearch(
  blocks: TextBlock[],
  source: SieveSource,
  maxOutboundChars: number,
  toolCallId?: string,
  maxRetainedChars = Number.POSITIVE_INFINITY,
): StructuredSlice | undefined {
  const text = blocks.map((block) => block.text).join("");
  const parsed = parseJsonText(blocks);
  if (!parsed || !Array.isArray(parsed.results)) return undefined;
  const results = parsed.results;
  const base = { ...parsed };
  delete base.results;
  delete base.piSieve;
  for (let returned = results.length; returned >= 0; returned--) {
    const selected = results.slice(0, returned);
    const ranked = {
      ...base,
      results: selected,
      returned,
      truncated: base.truncated === true || returned < results.length,
    };
    const withoutMarker = JSON.stringify(ranked);
    const outboundText = JSON.stringify({
      ...ranked,
      piSieve: structuredPruneMetadata(source, text.length, "omittedResults", results.length - returned, toolCallId),
    });
    if (outboundText.length <= maxOutboundChars && withoutMarker.length <= maxRetainedChars) {
      return {
        outboundText,
        omittedChars: Math.max(0, text.length - withoutMarker.length),
        retainedChars: withoutMarker.length,
      };
    }
  }
  return undefined;
}

function sliceRelationshipGraph(
  blocks: TextBlock[],
  source: SieveSource,
  maxOutboundChars: number,
  maxRetainedChars = Number.POSITIVE_INFINITY,
): StructuredSlice | undefined {
  const text = blocks.map((block) => block.text).join("");
  const parsed = parseJsonText(blocks);
  if (!parsed || !Array.isArray(parsed.files)) return undefined;
  const locationCount = parsed.files.reduce((count, file) => {
    const value = jsonObject(file);
    return count + (Array.isArray(value?.locations) ? value.locations.length : 0);
  }, 0);
  const base = { ...parsed };
  delete base.files;
  delete base.piSieve;

  for (let returned = locationCount; returned >= 0; returned--) {
    let remaining = returned;
    const selectedFiles: JsonObject[] = [];
    for (const file of parsed.files) {
      if (remaining <= 0) break;
      const value = jsonObject(file)!;
      const locations = (value.locations as unknown[]).slice(0, remaining);
      if (locations.length) selectedFiles.push({ ...value, locations });
      remaining -= locations.length;
    }
    const originalMetadata = jsonObject(parsed.metadata) ?? {};
    const graph = {
      ...base,
      files: selectedFiles,
      metadata: {
        ...originalMetadata,
        returnedCount: returned,
        truncated: originalMetadata.truncated === true || returned < locationCount,
      },
    };
    const withoutMarker = JSON.stringify(graph);
    const outboundText = JSON.stringify({
      ...graph,
      piSieve: structuredPruneMetadata(source, text.length, "omittedLocations", locationCount - returned),
    });
    if (outboundText.length <= maxOutboundChars && withoutMarker.length <= maxRetainedChars) {
      return {
        outboundText,
        omittedChars: Math.max(0, text.length - withoutMarker.length),
        retainedChars: withoutMarker.length,
      };
    }
  }
  return undefined;
}

function sliceOldSuccess(
  blocks: TextBlock[],
  source: SieveSource,
  maxOutboundChars: number,
  maxRetainedChars: number,
): OldSuccessSlice | undefined {
  if (maxRetainedChars <= 0) return undefined;
  const text = blocks.map((block) => block.text).join("");
  let omittedChars = text.length;

  // Only omittedChars' decimal width affects the next value, so this reaches a fixed point.
  for (;;) {
    const marker = partialOmissionMarker(source.toolName, text.length, omittedChars, source.recalled);
    const retainedChars = Math.min(maxRetainedChars, maxOutboundChars - marker.length - 2);
    if (retainedChars <= 0) return undefined;
    const nextOmittedChars = text.length - retainedChars;
    if (nextOmittedChars !== omittedChars) {
      omittedChars = nextOmittedChars;
      continue;
    }
    const headChars = Math.floor(retainedChars / 2);
    const tailChars = retainedChars - headChars;
    return {
      outboundText: text.slice(0, headChars) + "\n" + marker + "\n" + text.slice(-tailChars),
      omittedText: text.slice(headChars, text.length - tailChars),
      retainedChars,
    };
  }
}

function sliceActiveResult(
  blocks: TextBlock[],
  source: SieveSource,
  toolCallId: string,
  threshold: number,
): ActiveSlice | undefined {
  const text = blocks.map((block) => block.text).join("");
  const separators = source.isError ? 1 : 2;
  let omittedChars = text.length;

  // Only omittedChars' decimal width affects the next value, so this reaches a fixed point.
  for (;;) {
    const marker = activeOmissionMarker(source.toolName, toolCallId, text.length, omittedChars);
    const retainedChars = threshold - marker.length - separators;
    if (retainedChars <= 0) return undefined;
    const nextOmittedChars = text.length - retainedChars;
    if (nextOmittedChars !== omittedChars) {
      omittedChars = nextOmittedChars;
      continue;
    }
    if (source.isError) {
      return {
        outboundText: marker + "\n" + text.slice(-retainedChars),
        omittedText: text.slice(0, -retainedChars),
      };
    }
    const headChars = Math.floor(retainedChars / 2);
    const tailChars = retainedChars - headChars;
    return {
      outboundText: text.slice(0, headChars) + "\n" + marker + "\n" + text.slice(-tailChars),
      omittedText: text.slice(headChars, text.length - tailChars),
    };
  }
}

type TrackedToolCall = {
  id: string;
  name: string;
  arguments: JsonObject;
  assistantOrdinal: number;
  messageIndex: number;
};

type ReadCoverage = { start: number; end: number };
type TrackedRead = {
  messageIndex: number;
  assistantOrdinal: number;
  path: string;
  displayPath: string;
  coverage: ReadCoverage;
  sourceChars: number;
};
type TrackedMutation = {
  assistantOrdinal: number;
  callMessageIndex: number;
  resultMessageIndex?: number;
  path: string;
  successful: boolean;
  preservesLineNumbers: boolean;
};
type TrackedToolResult = { fields: Record<string, unknown>; messageIndex: number };

function rawToolPath(argumentsValue: JsonObject): string | undefined {
  const value = argumentsValue.path ?? argumentsValue.file_path;
  return typeof value === "string" && value ? value : undefined;
}

function normalizedToolPath(argumentsValue: JsonObject, cwd: string): string | undefined {
  const raw = rawToolPath(argumentsValue);
  if (!raw) return undefined;
  // Match resolveToCwd(): normalize Unicode spaces, strip model-supplied @, expand ~, and accept file URLs.
  let normalized = raw.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") normalized = homedir();
  else if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\")))
    normalized = join(homedir(), normalized.slice(2));
  if (/^file:\/\//.test(normalized)) {
    try {
      normalized = fileURLToPath(normalized);
    } catch {
      return undefined;
    }
  }
  return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 1 ? value as number : undefined;
}

function safeRangeEnd(start: number, length: number): number | undefined {
  const end = start + length - 1;
  return Number.isSafeInteger(end) ? end : undefined;
}

function editPreservesLineNumbers(argumentsValue: JsonObject): boolean {
  const rawEdits = argumentsValue.edits;
  const edits = Array.isArray(rawEdits)
    ? rawEdits
    : typeof argumentsValue.oldText === "string" && typeof argumentsValue.newText === "string"
      ? [{ oldText: argumentsValue.oldText, newText: argumentsValue.newText }]
      : undefined;
  return !!edits?.length && edits.every((value) => {
    const edit = jsonObject(value);
    if (typeof edit?.oldText !== "string" || typeof edit.newText !== "string") return false;
    const oldLines = edit.oldText.match(/\r\n|\r|\n/g)?.length ?? 0;
    const newLines = edit.newText.match(/\r\n|\r|\n/g)?.length ?? 0;
    return oldLines === newLines;
  });
}

function readCoverage(argumentsValue: JsonObject, details: unknown, blocks: TextBlock[]): ReadCoverage | undefined {
  if (blocks.length !== 1) return undefined;
  const start = argumentsValue.offset === undefined ? 1 : positiveInteger(argumentsValue.offset);
  const limit = argumentsValue.limit === undefined ? undefined : positiveInteger(argumentsValue.limit);
  if (start === undefined || (argumentsValue.limit !== undefined && limit === undefined)) return undefined;

  const detailFields = jsonObject(details);
  const rawTruncation = detailFields?.truncation;
  const truncation = rawTruncation === undefined ? undefined : jsonObject(rawTruncation);
  if (rawTruncation !== undefined && !truncation) return undefined;
  if (truncation?.truncated === true) {
    if (truncation.firstLineExceedsLimit === true) return undefined;
    const outputLines = positiveInteger(truncation.outputLines);
    const end = outputLines === undefined ? undefined : safeRangeEnd(start, outputLines);
    return end === undefined ? undefined : { start, end };
  }
  if (truncation && truncation.truncated !== false) return undefined;
  if (limit === undefined) return { start, end: Number.POSITIVE_INFINITY };
  // Built-in limited reads append a continuation notice when more lines exist; min() still yields the requested limit.
  // At EOF the output is shorter, so counting returned lines avoids overstating coverage.
  const returnedLines = Math.min(limit, blocks[0].text.split("\n").length);
  const end = safeRangeEnd(start, returnedLines);
  return end === undefined ? undefined : { start, end };
}

function staleReadReplacements<T extends ContextMessage>(messages: readonly T[], cwd: string) {
  const calls: TrackedToolCall[] = [];
  const callCounts = new Map<string, number>();
  let assistantOrdinal = 0;
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const fields = messages[messageIndex] as Record<string, unknown>;
    if (fields.role !== "assistant" || !Array.isArray(fields.content)) continue;
    assistantOrdinal++;
    for (const part of fields.content) {
      const call = jsonObject(part);
      if (call?.type !== "toolCall" || typeof call.id !== "string" || !call.id || typeof call.name !== "string")
        continue;
      calls.push({
        id: call.id,
        name: call.name,
        arguments: jsonObject(call.arguments) ?? {},
        assistantOrdinal,
        messageIndex,
      });
      callCounts.set(call.id, (callCounts.get(call.id) ?? 0) + 1);
    }
  }
  const uniqueCalls = new Map(calls.filter((call) => callCounts.get(call.id) === 1).map((call) => [call.id, call]));

  const results = new Map<string, TrackedToolResult>();
  const resultCounts = new Map<string, number>();
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const fields = messages[messageIndex] as Record<string, unknown>;
    if (fields.role !== "toolResult" || typeof fields.toolCallId !== "string" || !fields.toolCallId) continue;
    resultCounts.set(fields.toolCallId, (resultCounts.get(fields.toolCallId) ?? 0) + 1);
    results.set(fields.toolCallId, { fields, messageIndex });
  }

  const reads: TrackedRead[] = [];
  for (const [toolCallId, call] of uniqueCalls) {
    const result = results.get(toolCallId);
    if (
      call.name !== READ_TOOL_NAME ||
      resultCounts.get(toolCallId) !== 1 ||
      !result ||
      result.messageIndex <= call.messageIndex ||
      result.fields.isError !== false
    ) continue;
    const path = normalizedToolPath(call.arguments, cwd);
    const blocks = textOnlyBlocks(result.fields.content);
    const coverage = blocks && readCoverage(call.arguments, result.fields.details, blocks);
    if (!path || !blocks || !coverage) continue;
    reads.push({
      messageIndex: result.messageIndex,
      assistantOrdinal: call.assistantOrdinal,
      path,
      displayPath: rawToolPath(call.arguments)!,
      coverage,
      sourceChars: blocks.reduce((length, block) => length + block.text.length, 0),
    });
  }

  const mutations: TrackedMutation[] = [];
  for (const call of calls) {
    if (call.name !== "edit" && call.name !== "write") continue;
    const path = normalizedToolPath(call.arguments, cwd);
    if (!path) continue;
    const result = callCounts.get(call.id) === 1 && resultCounts.get(call.id) === 1
      ? results.get(call.id)
      : undefined;
    const successful = !!result && result.messageIndex > call.messageIndex && result.fields.isError === false;
    mutations.push({
      assistantOrdinal: call.assistantOrdinal,
      callMessageIndex: call.messageIndex,
      resultMessageIndex: result?.messageIndex,
      path,
      successful,
      preservesLineNumbers: successful && call.name === "edit" && editPreservesLineNumbers(call.arguments),
    });
  }

  const replacements = new Map<number, T>();
  let omittedChars = 0;
  let netCharsSaved = 0;
  for (const oldRead of reads) {
    const superseded = reads.some((newRead) => {
      if (
        newRead.path !== oldRead.path ||
        newRead.assistantOrdinal <= oldRead.assistantOrdinal ||
        newRead.messageIndex <= oldRead.messageIndex
      ) return false;
      const interveningMutations = mutations.filter((mutation) =>
        mutation.path === oldRead.path &&
        mutation.assistantOrdinal > oldRead.assistantOrdinal &&
        mutation.assistantOrdinal < newRead.assistantOrdinal &&
        mutation.callMessageIndex > oldRead.messageIndex &&
        mutation.callMessageIndex < newRead.messageIndex,
      );
      const confirmedMutation = interveningMutations.some((mutation) =>
        mutation.successful &&
        mutation.resultMessageIndex !== undefined &&
        mutation.resultMessageIndex > oldRead.messageIndex &&
        mutation.resultMessageIndex < newRead.messageIndex,
      );
      if (!confirmedMutation) return false;
      const currentWholeFile = newRead.coverage.start === 1 && newRead.coverage.end === Number.POSITIVE_INFINITY;
      return currentWholeFile || (
        interveningMutations.every((mutation) =>
          mutation.successful &&
          mutation.preservesLineNumbers &&
          mutation.resultMessageIndex !== undefined &&
          mutation.resultMessageIndex < newRead.messageIndex,
        ) &&
        newRead.coverage.start <= oldRead.coverage.start &&
        newRead.coverage.end >= oldRead.coverage.end
      );
    });
    if (!superseded) continue;
    const marker = staleReadMarker(oldRead.displayPath, oldRead.sourceChars);
    if (marker.length >= oldRead.sourceChars) continue;
    replacements.set(oldRead.messageIndex, replaceWithMarker(messages[oldRead.messageIndex], marker));
    omittedChars += oldRead.sourceChars;
    netCharsSaved += oldRead.sourceChars - marker.length;
  }
  return { replacements, omittedChars, netCharsSaved };
}

/**
 * Creates an outbound-only context view. The supplied session messages and all
 * ineligible message objects remain untouched. The optional threshold keeps
 * existing callers on the default while allowing runtime configuration.
 */
export function sieveMessages<T extends ContextMessage>(
  messages: readonly T[],
  threshold = SIEVE_THRESHOLD,
  options: SieveOptions = {},
): TransformResult<T> {
  const userIndexes = messages.reduce<number[]>((indexes, message, index) => {
    if (message.role === "user") indexes.push(index);
    return indexes;
  }, []);
  const cutoff = userIndexes.at(-2);
  const usersAfter: number[] = [];
  let userCount = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    usersAfter[index] = userCount;
    if (messages[index].role === "user") userCount++;
  }

  const stats = emptyTransformStats();
  const staleReads = staleReadReplacements(messages, options.cwd ?? process.cwd());
  const replacements = staleReads.replacements;
  stats.scanned += replacements.size;
  stats.transformed += replacements.size;
  stats.transformedBy.staleRead += replacements.size;
  stats.omittedChars += staleReads.omittedChars;
  stats.netCharsSaved += staleReads.netCharsSaved;
  const recoverableActiveResults: RecoverableActiveResult[] = [];
  const activeToolCallIdCounts = new Map<string, number>();
  if (options.pruneActive) {
    for (let index = 0; index < messages.length; index++) {
      const fields = messages[index] as Record<string, unknown>;
      if (fields.role !== "toolResult" || usersAfter[index] !== 0) continue;
      if (typeof fields.toolCallId !== "string" || !fields.toolCallId) continue;
      activeToolCallIdCounts.set(fields.toolCallId, (activeToolCallIdCounts.get(fields.toolCallId) ?? 0) + 1);
    }
  }
  const retainedBudget = 3 * threshold;
  let retainedChars = 0;

  // Budget selection is deliberately newest-to-oldest, unlike outbound order.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "toolResult" || replacements.has(index)) continue;
    const age = usersAfter[index];
    if (age === 0) {
      if (!options.pruneActive) {
        stats.skipped.recentWindow++;
        continue;
      }
      stats.scanned++;
      const source = sieveSource(message, false);
      if (!source) {
        stats.skipped.ineligibleTool++;
        continue;
      }
      const blocks = textOnlyBlocks((message as Record<string, unknown>).content);
      const sourceLength = blocks?.reduce((length, block) => length + block.text.length, 0);
      if (!blocks || sourceLength === undefined) {
        stats.skipped.nonTextMixedOrEmptyContent++;
        continue;
      }
      if (source.kind === "relationshipGraph" && !source.isError) {
        stats.skipped.recentWindow++;
        continue;
      }
      if (sourceLength <= threshold) {
        stats.skipped.atOrBelowThreshold++;
        continue;
      }
      if (source.kind === "rankedSearch" && !source.isError && !validStructuredContent(blocks, source.kind)) {
        stats.skipped.malformedStructuredContent++;
        continue;
      }
      const toolCallId = (message as Record<string, unknown>).toolCallId;
      if (
        typeof toolCallId !== "string" ||
        !toolCallId ||
        activeToolCallIdCounts.get(toolCallId) !== 1
      ) {
        stats.skipped.recoveryUnavailable++;
        continue;
      }
      if (source.kind === "rankedSearch" && !source.isError) {
        const sliced = sliceRankedSearch(blocks, source, threshold, toolCallId);
        if (!sliced || sliced.outboundText.length >= sourceLength) {
          stats.skipped.recoveryUnavailable++;
          continue;
        }
        replacements.set(index, replaceWithMarker(message, sliced.outboundText));
        recoverableActiveResults.push({
          toolCallId,
          toolName: source.toolName,
          content: blocks.map((block) => ({ ...block })),
          isError: false,
        });
        stats.transformed++;
        stats.transformedBy.activeThreshold++;
        stats.omittedChars += sliced.omittedChars;
        stats.netCharsSaved += sourceLength - sliced.outboundText.length;
        continue;
      }
      const sliced = sliceActiveResult(blocks, source, toolCallId, threshold);
      if (!sliced) {
        stats.skipped.recoveryUnavailable++;
        continue;
      }
      replacements.set(index, replaceWithMarker(message, sliced.outboundText));
      recoverableActiveResults.push({
        toolCallId,
        toolName: source.toolName,
        content: [{ type: "text", text: sliced.omittedText }],
        isError: source.isError,
      });
      stats.transformed++;
      stats.transformedBy.activeThreshold++;
      stats.omittedChars += sliced.omittedText.length;
      stats.netCharsSaved += Math.max(0, sourceLength - sliced.outboundText.length);
      continue;
    }
    if (cutoff === undefined) {
      stats.skipped.recentWindow++;
      continue;
    }

    stats.scanned++;
    const source = sieveSource(message, true);
    if (!source) {
      stats.skipped.ineligibleTool++;
      continue;
    }

    const sourceLength = textOnlyContentLength((message as Record<string, unknown>).content);
    if (source.isError) {
      const giantThreshold = Math.max(32_000, 4 * threshold);
      if (age > 1 && sourceLength !== undefined && sourceLength > giantThreshold) {
        const marker = source.recalled
          ? recalledGiantErrorMarker(source.toolName, sourceLength)
          : giantErrorMarker(source.toolName, sourceLength);
        const tail = textOnlyContentTail((message as Record<string, unknown>).content, GIANT_ERROR_TAIL_CHARS)!;
        replacements.set(index, replaceWithMarker(message, marker + tail));
        stats.transformed++;
        stats.transformedBy.giantError++;
        stats.omittedChars += sourceLength - tail.length;
        stats.netCharsSaved += Math.max(0, sourceLength - tail.length - marker.length);
      } else {
        stats.skipped.error++;
      }
      continue;
    }

    if (sourceLength === undefined) {
      stats.skipped.nonTextMixedOrEmptyContent++;
      continue;
    }
    const blocks = textOnlyBlocks((message as Record<string, unknown>).content)!;

    if (source.kind === "relationshipGraph" && age === 1) {
      stats.skipped.recentWindow++;
      continue;
    }
    if (source.kind !== "plain" && !validStructuredContent(blocks, source.kind)) {
      stats.skipped.malformedStructuredContent++;
      continue;
    }

    const effectiveThreshold = age === 1
      ? (options.pruneActive ? threshold : 3 * threshold)
      : effectiveThresholdForAge(age, threshold);
    if (source.kind === "relationshipGraph" && age >= 6) {
      const marker = structuredMarker(source, sourceLength);
      if (marker.length >= sourceLength) {
        retainedChars += sourceLength;
        stats.skipped.atOrBelowThreshold++;
        continue;
      }
      replacements.set(index, replaceWithMarker(message, marker));
      stats.transformed++;
      stats.transformedBy.ageThreshold++;
      stats.omittedChars += sourceLength;
      stats.netCharsSaved += sourceLength - marker.length;
      continue;
    }
    if (age === 1 && sourceLength <= effectiveThreshold) {
      stats.skipped.atOrBelowThreshold++;
      continue;
    }

    const remainingBudget = age === 1 ? sourceLength : retainedBudget - retainedChars;
    if (age > 1 && sourceLength <= effectiveThreshold && sourceLength <= remainingBudget) {
      retainedChars += sourceLength;
      stats.skipped.atOrBelowThreshold++;
      continue;
    }

    const byAgeThreshold = sourceLength > effectiveThreshold;
    const maxOutboundChars = byAgeThreshold ? effectiveThreshold : Math.max(0, sourceLength - 1);
    if (source.kind !== "plain") {
      const maxRetainedChars = age === 1 ? Number.POSITIVE_INFINITY : Math.max(0, remainingBudget);
      const sliced = source.kind === "rankedSearch"
        ? sliceRankedSearch(blocks, source, maxOutboundChars, undefined, maxRetainedChars)
        : sliceRelationshipGraph(blocks, source, maxOutboundChars, maxRetainedChars);
      if (sliced && sliced.outboundText.length < sourceLength) {
        replacements.set(index, replaceWithMarker(message, sliced.outboundText));
        if (age > 1) retainedChars += sliced.retainedChars;
        stats.omittedChars += sliced.omittedChars;
        stats.netCharsSaved += sourceLength - sliced.outboundText.length;
      } else {
        const marker = structuredMarker(source, sourceLength);
        if (marker.length >= sourceLength) {
          if (age > 1) retainedChars += sourceLength;
          stats.skipped.atOrBelowThreshold++;
          continue;
        }
        replacements.set(index, replaceWithMarker(message, marker));
        stats.omittedChars += sourceLength;
        stats.netCharsSaved += sourceLength - marker.length;
      }
      stats.transformed++;
      if (byAgeThreshold) stats.transformedBy.ageThreshold++;
      else stats.transformedBy.budget++;
      continue;
    }

    const sliced = sliceOldSuccess(blocks, source, maxOutboundChars, remainingBudget);
    if (sliced) {
      replacements.set(index, replaceWithMarker(message, sliced.outboundText));
      if (age > 1) retainedChars += sliced.retainedChars;
      stats.omittedChars += sliced.omittedText.length;
      stats.netCharsSaved += Math.max(0, sourceLength - sliced.outboundText.length);
    } else {
      const marker = source.recalled
        ? recalledOmissionMarker(source.toolName, sourceLength)
        : omissionMarker(source.toolName, sourceLength);
      if (marker.length >= sourceLength) {
        if (age > 1) retainedChars += sourceLength;
        stats.skipped.atOrBelowThreshold++;
        continue;
      }
      replacements.set(index, replaceWithMarker(message, marker));
      stats.omittedChars += sourceLength;
      stats.netCharsSaved += sourceLength - marker.length;
    }
    stats.transformed++;
    if (byAgeThreshold) stats.transformedBy.ageThreshold++;
    else stats.transformedBy.budget++;
  }

  return {
    messages: messages.map((message, index) => replacements.get(index) ?? message),
    stats,
    recoverableActiveResults,
  };
}
