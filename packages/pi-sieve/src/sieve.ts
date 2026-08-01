import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

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
  "Age 0 uses independent per-result caps with active pruning; age 1 uses the threshold with active pruning or three times the threshold without it.";
export const GIANT_ERROR_TAIL_CHARS = 2_048;
export const DEFAULT_ROLLOVER_HIGH_MULTIPLIER = 8;
export const DEFAULT_ROLLOVER_LOW_MULTIPLIER = 4;
export const PROJECTION_POLICY_VERSION = 2;

export type SieveOptions = {
  pruneActive?: boolean;
  cwd?: string;
  retainedSourceCap?: number;
};

export type EligibleToolName = (typeof ELIGIBLE_TOOL_NAMES)[number];

export type ContextMessage = {
  role?: unknown;
};

export type ContentBlock = {
  type: string;
  [field: string]: unknown;
};

export type TextBlock = ContentBlock & {
  type: "text";
  text: string;
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

export type ToolTransformStats = {
  scanned: number;
  transformed: number;
  sourceChars: number;
  retainedChars: number;
  netCharsSaved: number;
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
    duplicate: number;
    errorCap: number;
    mixedText: number;
  };
  /** Source text characters omitted (or projected to be omitted). */
  omittedChars: number;
  /** Omitted text characters less the replacement marker characters. */
  netCharsSaved: number;
  byTool: Record<string, ToolTransformStats>;
  skipped: SkipStats;
};

export type RecoverableActiveResult = {
  toolCallId: string;
  toolName: string;
  isError: boolean;
};

export type TransformResult<T extends ContextMessage> = {
  messages: T[];
  stats: TransformStats;
  recoverableActiveResults: RecoverableActiveResult[];
};

export type EpochReason =
  | "session-start"
  | "session-replacement"
  | "reload"
  | "compaction"
  | "branch-navigation"
  | "model-change"
  | "prompt-fingerprint"
  | "configuration-change"
  | "explicit-reflow"
  | "budget-rollover"
  | "source-mismatch"
  | "history-mismatch"
  | "ambiguous-id";

export type EpochConfig = {
  threshold: number;
  activePruning: boolean;
  rolloverHighMultiplier: number;
  rolloverLowMultiplier: number;
  policyVersion: number;
};

export type ProjectionKind = keyof TransformStats["transformedBy"];

export type ProjectionEntry = {
  toolCallId: string;
  sourceHash: string;
  toolName: string;
  isError: boolean;
  projectedContent: ContentBlock[];
  projectedMessage: ContextMessage;
  sourceChars: number;
  retainedChars: number;
  retainedSourceChars: number;
  budgetEligible: boolean;
  recoverable: boolean;
  transformed: boolean;
  projectionKind?: ProjectionKind;
};

export type ProjectionEpoch = {
  id: string;
  reason: EpochReason;
  config: EpochConfig;
  promptFingerprint: string;
  startedAt: string;
  entries: Map<string, ProjectionEntry>;
  taintedIds: Set<string>;
  rawMessageHashes: string[];
};

export type ProjectionDiagnostics = {
  newProjections: number;
  cacheHits: number;
  ambiguousIds: number;
  sourceMismatches: number;
  historyMismatches: number;
  ambiguousReflows: number;
  softBudgetExceeded: boolean;
  earliestChangedMessageIndex?: number;
  estimatedInvalidatedChars: number;
  requiresReflow: boolean;
};

export type StableTransformResult<T extends ContextMessage> = TransformResult<T> & {
  diagnostics: ProjectionDiagnostics;
};

const eligibleTools = new Set<string>(ELIGIBLE_TOOL_NAMES);
const rankedSearchTools = new Set<string>(RANKED_SEARCH_TOOL_NAMES);

export function emptyTransformStats(): TransformStats {
  return {
    scanned: 0,
    transformed: 0,
    transformedBy: {
      ageThreshold: 0,
      budget: 0,
      giantError: 0,
      activeThreshold: 0,
      staleRead: 0,
      duplicate: 0,
      errorCap: 0,
      mixedText: 0,
    },
    omittedChars: 0,
    netCharsSaved: 0,
    byTool: {},
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
  target.transformedBy.duplicate += source.transformedBy.duplicate;
  target.transformedBy.errorCap += source.transformedBy.errorCap;
  target.transformedBy.mixedText += source.transformedBy.mixedText;
  target.omittedChars += source.omittedChars;
  target.netCharsSaved += source.netCharsSaved;
  for (const [toolName, usage] of Object.entries(source.byTool)) {
    const current = target.byTool[toolName] ?? { scanned: 0, transformed: 0, sourceChars: 0, retainedChars: 0, netCharsSaved: 0 };
    current.scanned += usage.scanned;
    current.transformed += usage.transformed;
    current.sourceChars += usage.sourceChars;
    current.retainedChars += usage.retainedChars;
    current.netCharsSaved += usage.netCharsSaved;
    target.byTool[toolName] = current;
  }
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
  return `[pi-sieve: ${toolName}; ${sourceChars} chars omitted]`;
}

export function giantErrorMarker(toolName: string, sourceChars: number) {
  return `[pi-sieve: ${toolName} error; ${sourceChars} chars truncated]\n`;
}

export function recalledOmissionMarker(toolName: string, sourceChars: number) {
  return `[pi-sieve: recalled ${toolName}; ${sourceChars} chars omitted]`;
}

export function recalledGiantErrorMarker(toolName: string, sourceChars: number) {
  return `[pi-sieve: recalled ${toolName} error; ${sourceChars} chars truncated]\n`;
}

export function partialOmissionMarker(toolName: string, sourceChars: number, omittedChars: number, recalled = false) {
  return `[pi-sieve: ${recalled ? "recalled " : ""}${toolName}; omitted ${omittedChars}/${sourceChars} chars]`;
}

export function activeOmissionMarker(
  toolName: string,
  toolCallId: string,
  sourceChars: number,
  omittedChars: number,
) {
  return `[pi-sieve: ${toolName}; omitted ${omittedChars}/${sourceChars} chars; sieve_recall ${JSON.stringify(toolCallId)}]`;
}

export function duplicateMarker(toolName: string, originalToolCallId: string, duplicateToolCallId: string | undefined, sourceChars: number) {
  return `[pi-sieve: duplicate ${toolName} (${sourceChars} chars); same as ${JSON.stringify(originalToolCallId)}${duplicateToolCallId ? `; sieve_recall ${JSON.stringify(duplicateToolCallId)}` : ""}]`;
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
  toolCallId?: string,
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
      piSieve: structuredPruneMetadata(source, text.length, "omittedLocations", locationCount - returned, toolCallId),
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
  maxRetainedChars = Number.POSITIVE_INFINITY,
): ActiveSlice | undefined {
  const text = blocks.map((block) => block.text).join("");
  const separators = source.isError ? 1 : 2;
  let omittedChars = text.length;

  // Only omittedChars' decimal width affects the next value, so this reaches a fixed point.
  for (;;) {
    const marker = activeOmissionMarker(source.toolName, toolCallId, text.length, omittedChars);
    const retainedChars = Math.min(maxRetainedChars, threshold - marker.length - separators);
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

function mixedContentBlocks(content: unknown): { blocks: ContentBlock[]; textIndexes: number[]; sourceChars: number } | undefined {
  if (!Array.isArray(content) || !content.length) return undefined;
  const blocks: ContentBlock[] = [];
  const textIndexes: number[] = [];
  let sourceChars = 0;
  for (let index = 0; index < content.length; index++) {
    const block = content[index];
    if (!block || typeof block !== "object" || typeof (block as { type?: unknown }).type !== "string") return undefined;
    const value = block as ContentBlock;
    if (value.type === "text") {
      if (typeof value.text !== "string") return undefined;
      textIndexes.push(index);
      sourceChars += value.text.length;
    }
    blocks.push(value);
  }
  return textIndexes.length && textIndexes.length !== blocks.length ? { blocks, textIndexes, sourceChars } : undefined;
}

function sliceMixedActive<T extends ContextMessage>(
  message: T,
  source: SieveSource,
  toolCallId: string,
  threshold: number,
  maxRetainedChars = Number.POSITIVE_INFINITY,
): { message: T; omittedChars: number; retainedChars: number; netCharsSaved: number } | undefined {
  const mixed = mixedContentBlocks((message as Record<string, unknown>).content);
  if (!mixed || mixed.sourceChars <= threshold) return undefined;
  const share = Math.max(1, Math.floor(threshold / mixed.textIndexes.length));
  const retainedShare = Math.max(0, Math.floor(maxRetainedChars / mixed.textIndexes.length));
  const content = mixed.blocks.map((block) => ({ ...block }));
  let omittedChars = 0;
  for (const index of mixed.textIndexes) {
    const block = mixed.blocks[index] as TextBlock;
    if (block.text.length <= share && block.text.length <= retainedShare) continue;
    const sliced = sliceActiveResult([block], source, toolCallId, share, retainedShare);
    if (!sliced) return undefined;
    content[index] = { ...block, text: sliced.outboundText };
    omittedChars += sliced.omittedText.length;
  }
  if (!omittedChars) return undefined;
  const outboundChars = mixed.textIndexes.reduce(
    (sum, index) => sum + String(content[index].text ?? "").length,
    0,
  );
  return {
    message: { ...message, content } as T,
    omittedChars,
    retainedChars: mixed.sourceChars - omittedChars,
    netCharsSaved: Math.max(0, mixed.sourceChars - outboundChars),
  };
}

function sliceMixedOld<T extends ContextMessage>(
  message: T,
  source: SieveSource,
  maxOutboundChars: number,
  maxRetainedChars: number,
): { message: T; omittedChars: number; retainedChars: number; netCharsSaved: number } | undefined {
  const mixed = mixedContentBlocks((message as Record<string, unknown>).content);
  if (!mixed) return undefined;
  const shareOutbound = Math.max(1, Math.floor(maxOutboundChars / mixed.textIndexes.length));
  const shareRetained = Math.max(0, Math.floor(maxRetainedChars / mixed.textIndexes.length));
  const content = mixed.blocks.map((block) => ({ ...block }));
  let omittedChars = 0;
  let retainedChars = 0;
  for (const index of mixed.textIndexes) {
    const block = mixed.blocks[index] as TextBlock;
    const sliced = sliceOldSuccess([block], source, shareOutbound, shareRetained);
    if (!sliced) {
      const marker = source.recalled
        ? recalledOmissionMarker(source.toolName, block.text.length)
        : omissionMarker(source.toolName, block.text.length);
      if (marker.length >= block.text.length) {
        content[index] = { ...block };
        retainedChars += block.text.length;
      } else {
        content[index] = { ...block, text: marker };
        omittedChars += block.text.length;
      }
      continue;
    }
    content[index] = { ...block, text: sliced.outboundText };
    omittedChars += sliced.omittedText.length;
    retainedChars += sliced.retainedChars;
  }
  if (!omittedChars) return undefined;
  const outboundChars = mixed.textIndexes.reduce((sum, index) => sum + String(content[index].text ?? "").length, 0);
  return {
    message: { ...message, content } as T,
    omittedChars,
    retainedChars,
    netCharsSaved: Math.max(0, mixed.sourceChars - outboundChars),
  };
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

type DuplicateReplacement<T extends ContextMessage> = {
  messageIndex: number;
  message: T;
  sourceChars: number;
  markerChars: number;
  toolName: string;
  recoverable?: RecoverableActiveResult;
};

const duplicateExcludedTools = new Set([
  "edit", "write", "continuity_update", "heartbeat_start", "heartbeat_cancel", "memory", RECALL_TOOL_NAME,
]);

function serializedContentLength(content: unknown): number {
  try {
    return JSON.stringify(content)?.length ?? 0;
  } catch {
    return 0;
  }
}

function exactDuplicateReplacements<T extends ContextMessage>(
  messages: readonly T[],
  cwd: string,
  existing: ReadonlyMap<number, T>,
  recoverable: boolean,
): DuplicateReplacement<T>[] {
  const calls: TrackedToolCall[] = [];
  const callCounts = new Map<string, number>();
  let assistantOrdinal = 0;
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const fields = messages[messageIndex] as Record<string, unknown>;
    if (fields.role !== "assistant" || !Array.isArray(fields.content)) continue;
    assistantOrdinal++;
    for (const part of fields.content) {
      const call = jsonObject(part);
      if (call?.type !== "toolCall" || typeof call.id !== "string" || !call.id || typeof call.name !== "string") continue;
      calls.push({ id: call.id, name: call.name, arguments: jsonObject(call.arguments) ?? {}, assistantOrdinal, messageIndex });
      callCounts.set(call.id, (callCounts.get(call.id) ?? 0) + 1);
    }
  }

  const results = new Map<string, TrackedToolResult>();
  const resultCounts = new Map<string, number>();
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const fields = messages[messageIndex] as Record<string, unknown>;
    if (fields.role !== "toolResult" || typeof fields.toolCallId !== "string" || !fields.toolCallId) continue;
    resultCounts.set(fields.toolCallId, (resultCounts.get(fields.toolCallId) ?? 0) + 1);
    results.set(fields.toolCallId, { fields, messageIndex });
  }

  const uniqueCalls = calls.filter((call) => callCounts.get(call.id) === 1 && resultCounts.get(call.id) === 1);
  const candidates = uniqueCalls.flatMap((call) => {
    const result = results.get(call.id);
    if (!result || result.messageIndex <= call.messageIndex || result.fields.isError === true || existing.has(result.messageIndex)) return [];
    if (!Array.isArray(result.fields.content) || !result.fields.content.length) return [];
    return [{ call, result }];
  });
  const replacements: DuplicateReplacement<T>[] = [];
  const replaced = new Set<number>();

  // Read duplicates use source identity, not only equal display text.
  const earlierReads: typeof candidates = [];
  for (const candidate of candidates.filter(({ call }) => call.name === READ_TOOL_NAME)) {
    const path = normalizedToolPath(candidate.call.arguments, cwd);
    const blocks = textOnlyBlocks(candidate.result.fields.content);
    const coverage = blocks && readCoverage(candidate.call.arguments, candidate.result.fields.details, blocks);
    if (!path || !coverage || !blocks) continue;
    const original = earlierReads.find(({ call, result }) => {
      const originalPath = normalizedToolPath(call.arguments, cwd);
      const originalBlocks = textOnlyBlocks(result.fields.content);
      const originalCoverage = originalBlocks && readCoverage(call.arguments, result.fields.details, originalBlocks);
      if (originalPath !== path || !originalCoverage || originalCoverage.start !== coverage.start || originalCoverage.end !== coverage.end
        || !isDeepStrictEqual(result.fields.content, candidate.result.fields.content)) return false;
      return !calls.some((mutation) =>
        (mutation.name === "edit" || mutation.name === "write")
        && mutation.messageIndex > result.messageIndex
        && mutation.messageIndex <= candidate.call.messageIndex
        && normalizedToolPath(mutation.arguments, cwd) === path,
      );
    });
    if (!original) {
      earlierReads.push(candidate);
      continue;
    }
    const sourceChars = blocks.reduce((sum, block) => sum + block.text.length, 0);
    const marker = duplicateMarker(READ_TOOL_NAME, original.call.id, recoverable ? candidate.call.id : undefined, sourceChars);
    if (marker.length >= sourceChars) continue;
    replacements.push({
      messageIndex: candidate.result.messageIndex,
      message: replaceWithMarker(messages[candidate.result.messageIndex], marker),
      sourceChars,
      markerChars: marker.length,
      toolName: READ_TOOL_NAME,
      ...(recoverable ? { recoverable: { toolCallId: candidate.call.id, toolName: READ_TOOL_NAME, isError: false } } : {}),
    });
    replaced.add(candidate.result.messageIndex);
  }

  // ponytail: duplicate result scans are quadratic; session result counts are small, index fingerprints if measured otherwise.
  const earlierGeneric: typeof candidates = [];
  for (const candidate of candidates) {
    if (candidate.call.name === READ_TOOL_NAME || duplicateExcludedTools.has(candidate.call.name) || replaced.has(candidate.result.messageIndex)) continue;
    const original = earlierGeneric.find(({ call, result }) =>
      call.name === candidate.call.name
      && isDeepStrictEqual(call.arguments, candidate.call.arguments)
      && isDeepStrictEqual(result.fields.details, candidate.result.fields.details)
      && isDeepStrictEqual(result.fields.content, candidate.result.fields.content),
    );
    if (!original) {
      earlierGeneric.push(candidate);
      continue;
    }
    const sourceChars = textOnlyContentLength(candidate.result.fields.content)
      ?? serializedContentLength(candidate.result.fields.content);
    const marker = duplicateMarker(candidate.call.name, original.call.id, recoverable ? candidate.call.id : undefined, sourceChars);
    if (marker.length >= serializedContentLength(candidate.result.fields.content)) continue;
    replacements.push({
      messageIndex: candidate.result.messageIndex,
      message: replaceWithMarker(messages[candidate.result.messageIndex], marker),
      sourceChars,
      markerChars: marker.length,
      toolName: candidate.call.name,
      ...(recoverable ? { recoverable: { toolCallId: candidate.call.id, toolName: candidate.call.name, isError: false } } : {}),
    });
    replaced.add(candidate.result.messageIndex);
  }
  return replacements;
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
  const recoverableActiveResults: RecoverableActiveResult[] = [];
  const cwd = options.cwd ?? process.cwd();
  const staleReads = staleReadReplacements(messages, cwd);
  const replacements = staleReads.replacements;
  stats.scanned += replacements.size;
  stats.transformed += replacements.size;
  stats.transformedBy.staleRead += replacements.size;
  stats.omittedChars += staleReads.omittedChars;
  stats.netCharsSaved += staleReads.netCharsSaved;
  for (const duplicate of exactDuplicateReplacements(messages, cwd, replacements, options.pruneActive === true)) {
    replacements.set(duplicate.messageIndex, duplicate.message);
    if (duplicate.recoverable) recoverableActiveResults.push(duplicate.recoverable);
    stats.scanned++;
    stats.transformed++;
    stats.transformedBy.duplicate++;
    stats.omittedChars += duplicate.sourceChars;
    stats.netCharsSaved += Math.max(0, duplicate.sourceChars - duplicate.markerChars);
  }
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
    if (age === 0 && options.pruneActive) {
      stats.scanned++;
      const source = sieveSource(message, false);
      if (!source) {
        stats.skipped.ineligibleTool++;
        continue;
      }
      const fields = message as Record<string, unknown>;
      const blocks = textOnlyBlocks(fields.content);
      const mixed = !blocks && source.kind === "plain" ? mixedContentBlocks(fields.content) : undefined;
      const sourceLength = blocks?.reduce((length, block) => length + block.text.length, 0) ?? mixed?.sourceChars;
      if (sourceLength === undefined) {
        stats.skipped.nonTextMixedOrEmptyContent++;
        continue;
      }
      if (source.kind === "relationshipGraph" && !source.isError) {
        stats.skipped.recentWindow++;
        continue;
      }
      const recentErrorThreshold = Math.max(SIEVE_THRESHOLD, threshold);
      if (sourceLength <= (source.isError ? recentErrorThreshold : threshold)) {
        stats.skipped.atOrBelowThreshold++;
        continue;
      }
      if (source.kind === "rankedSearch" && !source.isError && blocks && !validStructuredContent(blocks, source.kind)) {
        stats.skipped.malformedStructuredContent++;
        continue;
      }
      const toolCallId = fields.toolCallId;
      if (
        typeof toolCallId !== "string" ||
        !toolCallId ||
        activeToolCallIdCounts.get(toolCallId) !== 1
      ) {
        stats.skipped.recoveryUnavailable++;
        continue;
      }
      const recentLimit = source.isError ? recentErrorThreshold : threshold;
      if (mixed) {
        const sliced = sliceMixedActive(message, source, toolCallId, recentLimit);
        if (!sliced) {
          stats.skipped.recoveryUnavailable++;
          continue;
        }
        replacements.set(index, sliced.message);
        recoverableActiveResults.push({ toolCallId, toolName: source.toolName, isError: source.isError });
        stats.transformed++;
        stats.transformedBy.activeThreshold++;
        stats.transformedBy.mixedText++;
        if (source.isError) stats.transformedBy.errorCap++;
        stats.omittedChars += sliced.omittedChars;
        stats.netCharsSaved += sliced.netCharsSaved;
        continue;
      }
      if (!blocks) {
        stats.skipped.nonTextMixedOrEmptyContent++;
        continue;
      }
      if (source.kind === "rankedSearch" && !source.isError) {
        const sliced = sliceRankedSearch(blocks, source, recentLimit, toolCallId);
        const outboundText = sliced?.outboundText ?? structuredMarker(source, sourceLength, toolCallId);
        if (outboundText.length >= sourceLength) {
          stats.skipped.recoveryUnavailable++;
          continue;
        }
        replacements.set(index, replaceWithMarker(message, outboundText));
        recoverableActiveResults.push({ toolCallId, toolName: source.toolName, isError: false });
        stats.transformed++;
        stats.transformedBy.activeThreshold++;
        stats.omittedChars += sliced?.omittedChars ?? sourceLength;
        stats.netCharsSaved += sourceLength - outboundText.length;
        continue;
      }
      const sliced = sliceActiveResult(blocks, source, toolCallId, recentLimit);
      const outboundText = sliced?.outboundText ?? activeOmissionMarker(source.toolName, toolCallId, sourceLength, sourceLength);
      if (outboundText.length >= sourceLength) {
        stats.skipped.recoveryUnavailable++;
        continue;
      }
      replacements.set(index, replaceWithMarker(message, outboundText));
      recoverableActiveResults.push({ toolCallId, toolName: source.toolName, isError: source.isError });
      stats.transformed++;
      stats.transformedBy.activeThreshold++;
      if (source.isError) stats.transformedBy.errorCap++;
      stats.omittedChars += sliced?.omittedText.length ?? sourceLength;
      stats.netCharsSaved += Math.max(0, sourceLength - outboundText.length);
      continue;
    }
    if (age === 0) {
      stats.skipped.recentWindow++;
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

    const fields = message as Record<string, unknown>;
    const textBlocks = textOnlyBlocks(fields.content);
    const mixed = age > 1 && !source.isError && source.kind === "plain" && !textBlocks
      ? mixedContentBlocks(fields.content)
      : undefined;
    const sourceLength = textBlocks?.reduce((sum, block) => sum + block.text.length, 0) ?? mixed?.sourceChars;
    if (source.isError) {
      if (age > 1 && sourceLength !== undefined && sourceLength > threshold) {
        const marker = source.recalled
          ? recalledGiantErrorMarker(source.toolName, sourceLength)
          : giantErrorMarker(source.toolName, sourceLength);
        const available = Math.max(0, threshold - marker.length - 1);
        const headChars = Math.floor(available / 4);
        const tailChars = available - headChars;
        const text = textBlocks!.map((block) => block.text).join("");
        const outbound = marker + text.slice(0, headChars) + "\n" + text.slice(-tailChars);
        replacements.set(index, replaceWithMarker(message, outbound));
        stats.transformed++;
        stats.transformedBy.errorCap++;
        stats.omittedChars += sourceLength - headChars - tailChars;
        stats.netCharsSaved += Math.max(0, sourceLength - outbound.length);
      } else {
        stats.skipped.error++;
      }
      continue;
    }

    if (sourceLength === undefined) {
      stats.skipped.nonTextMixedOrEmptyContent++;
      continue;
    }
    if (mixed) {
      const effectiveThreshold = effectiveThresholdForAge(age, threshold);
      const remainingBudget = retainedBudget - retainedChars;
      if (sourceLength <= effectiveThreshold && sourceLength <= remainingBudget) {
        retainedChars += sourceLength;
        stats.skipped.atOrBelowThreshold++;
        continue;
      }
      const sliced = sliceMixedOld(
        message,
        source,
        sourceLength > effectiveThreshold ? effectiveThreshold : Math.max(0, sourceLength - 1),
        Math.max(0, remainingBudget),
      );
      if (!sliced) {
        stats.skipped.nonTextMixedOrEmptyContent++;
        continue;
      }
      replacements.set(index, sliced.message);
      retainedChars += sliced.retainedChars;
      stats.transformed++;
      stats.transformedBy[sourceLength > effectiveThreshold ? "ageThreshold" : "budget"]++;
      stats.transformedBy.mixedText++;
      stats.omittedChars += sliced.omittedChars;
      stats.netCharsSaved += sliced.netCharsSaved;
      continue;
    }
    const blocks = textBlocks!;

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

  const toolNames = new Set<string>();
  for (let index = 0; index < messages.length; index++) {
    const fields = messages[index] as Record<string, unknown>;
    if (fields.role !== "toolResult" || typeof fields.toolName !== "string") continue;
    const key = /^[a-zA-Z0-9_-]{1,64}$/.test(fields.toolName) && (toolNames.has(fields.toolName) || toolNames.size < 32)
      ? fields.toolName
      : "other";
    toolNames.add(key);
    const sourceChars = textOnlyContentLength(fields.content)
      ?? mixedContentBlocks(fields.content)?.sourceChars
      ?? serializedContentLength(fields.content);
    const replacement = replacements.get(index) as Record<string, unknown> | undefined;
    const retainedChars = replacement
      ? textOnlyContentLength(replacement.content)
        ?? mixedContentBlocks(replacement.content)?.sourceChars
        ?? serializedContentLength(replacement.content)
      : sourceChars;
    const usage = stats.byTool[key] ?? { scanned: 0, transformed: 0, sourceChars: 0, retainedChars: 0, netCharsSaved: 0 };
    usage.scanned++;
    usage.sourceChars += sourceChars;
    usage.retainedChars += retainedChars;
    if (replacement) usage.transformed++;
    usage.netCharsSaved += Math.max(0, sourceChars - retainedChars);
    stats.byTool[key] = usage;
  }

  return {
    messages: messages.map((message, index) => replacements.get(index) ?? message),
    stats,
    recoverableActiveResults,
  };
}

function cloneProjectionValue<T>(value: T): T {
  return structuredClone(value);
}

function canonicalProjectionValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === undefined) return { $undefined: true };
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (typeof value === "number" && !Number.isFinite(value)) return { $number: String(value) };
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return { $cycle: true };
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => canonicalProjectionValue(item, seen));
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonicalProjectionValue((value as Record<string, unknown>)[key], seen)]),
  );
}

function projectionHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalProjectionValue(value))).digest("hex");
}

export function projectionSourceHash<T extends ContextMessage>(
  messages: readonly T[],
  resultIndex: number,
  cwd = process.cwd(),
): string {
  const result = messages[resultIndex] as Record<string, unknown> | undefined;
  const toolCallId = typeof result?.toolCallId === "string" ? result.toolCallId : "";
  const calls: unknown[] = [];
  for (let index = 0; index < resultIndex; index++) {
    const fields = messages[index] as Record<string, unknown>;
    if (fields.role !== "assistant" || !Array.isArray(fields.content)) continue;
    for (const block of fields.content) {
      const call = jsonObject(block);
      if (call?.type === "toolCall" && call.id === toolCallId) calls.push(call);
    }
  }
  return projectionHash({ cwd: resolve(cwd), calls, result });
}

export function createProjectionEpoch(
  reason: EpochReason,
  config: Pick<EpochConfig, "threshold" | "activePruning"> & Partial<Omit<EpochConfig, "threshold" | "activePruning">>,
  promptFingerprint: string,
): ProjectionEpoch {
  return {
    id: randomUUID(),
    reason,
    config: {
      threshold: config.threshold,
      activePruning: config.activePruning,
      rolloverHighMultiplier: config.rolloverHighMultiplier ?? DEFAULT_ROLLOVER_HIGH_MULTIPLIER,
      rolloverLowMultiplier: config.rolloverLowMultiplier ?? DEFAULT_ROLLOVER_LOW_MULTIPLIER,
      policyVersion: config.policyVersion ?? PROJECTION_POLICY_VERSION,
    },
    promptFingerprint,
    startedAt: new Date().toISOString(),
    entries: new Map(),
    taintedIds: new Set(),
    rawMessageHashes: [],
  };
}

type NewProjection<T extends ContextMessage> = {
  message: T;
  recoverable: boolean;
  budgetEligible: boolean;
  retainedSourceChars: number;
  projectionKind?: ProjectionKind;
};

/** Projects one newly observed raw result using only history at or before it. */
export function projectNewResult<T extends ContextMessage>(
  messages: readonly T[],
  resultIndex: number,
  threshold = SIEVE_THRESHOLD,
  options: SieveOptions = {},
): NewProjection<T> {
  const message = messages[resultIndex];
  const unchanged = (budgetEligible = false, retainedSourceChars = 0): NewProjection<T> => ({
    message, recoverable: false, budgetEligible, retainedSourceChars,
  });
  const fields = message as Record<string, unknown>;
  if (fields?.role !== "toolResult") return unchanged();
  const cwd = options.cwd ?? process.cwd();
  const prefix = messages.slice(0, resultIndex + 1);
  const toolCallId = fields.toolCallId;
  if (typeof toolCallId !== "string" || !toolCallId) return unchanged();
  const resultCount = prefix.reduce((count, candidate) => {
    const value = candidate as Record<string, unknown>;
    return count + (value.role === "toolResult" && value.toolCallId === toolCallId ? 1 : 0);
  }, 0);
  if (resultCount !== 1) return unchanged();
  const duplicate = exactDuplicateReplacements(prefix, cwd, new Map(), options.pruneActive === true)
    .find((replacement) => replacement.messageIndex === resultIndex);
  if (duplicate) {
    return {
      message: duplicate.message,
      recoverable: duplicate.recoverable !== undefined,
      budgetEligible: false,
      retainedSourceChars: 0,
      projectionKind: "duplicate",
    };
  }
  if (!options.pruneActive) return unchanged();

  const source = sieveSource(message, false);
  if (!source) return unchanged();
  const blocks = textOnlyBlocks(fields.content);
  const mixed = !blocks && source.kind === "plain" ? mixedContentBlocks(fields.content) : undefined;
  const sourceLength = blocks?.reduce((length, block) => length + block.text.length, 0) ?? mixed?.sourceChars;
  if (sourceLength === undefined) return unchanged();
  const budgetEligible = !source.isError;
  const retainedCap = budgetEligible
    ? Math.max(0, Math.min(sourceLength, options.retainedSourceCap ?? sourceLength))
    : sourceLength;
  const cap = source.isError ? Math.max(SIEVE_THRESHOLD, threshold) : threshold;
  if (sourceLength <= cap && sourceLength <= retainedCap) return unchanged(budgetEligible, sourceLength);
  if (source.kind !== "plain" && (!blocks || !validStructuredContent(blocks, source.kind))) return unchanged();
  const projectionKind: ProjectionKind = retainedCap < Math.min(sourceLength, cap) ? "budget" : "activeThreshold";

  if (mixed) {
    const sliced = sliceMixedActive(message, source, toolCallId, cap, retainedCap);
    return sliced
      ? {
        message: sliced.message,
        recoverable: true,
        budgetEligible,
        retainedSourceChars: budgetEligible ? sliced.retainedChars : 0,
        projectionKind: source.isError ? "errorCap" : "mixedText",
      }
      : unchanged();
  }
  if (!blocks) return unchanged();
  if (source.kind === "rankedSearch" && !source.isError) {
    const sliced = sliceRankedSearch(blocks, source, cap, toolCallId, retainedCap);
    const outbound = sliced?.outboundText ?? structuredMarker(source, sourceLength, toolCallId);
    return outbound.length < sourceLength
      ? {
        message: replaceWithMarker(message, outbound), recoverable: true, budgetEligible: true,
        retainedSourceChars: sliced?.retainedChars ?? 0, projectionKind,
      }
      : unchanged();
  }
  if (source.kind === "relationshipGraph" && !source.isError) {
    const sliced = sliceRelationshipGraph(blocks, source, cap, retainedCap, toolCallId);
    const outbound = sliced?.outboundText ?? structuredMarker(source, sourceLength, toolCallId);
    return outbound.length < sourceLength
      ? {
        message: replaceWithMarker(message, outbound), recoverable: true, budgetEligible: true,
        retainedSourceChars: sliced?.retainedChars ?? 0, projectionKind,
      }
      : unchanged();
  }
  const sliced = sliceActiveResult(blocks, source, toolCallId, cap, retainedCap);
  const outbound = sliced?.outboundText ?? activeOmissionMarker(source.toolName, toolCallId, sourceLength, sourceLength);
  return outbound.length < sourceLength
    ? {
      message: replaceWithMarker(message, outbound),
      recoverable: true,
      budgetEligible,
      retainedSourceChars: budgetEligible && sliced ? sourceLength - sliced.omittedText.length : 0,
      projectionKind: source.isError ? "errorCap" : projectionKind,
    }
    : unchanged();
}

function contentCharacters(content: unknown): number {
  return textOnlyContentLength(content)
    ?? mixedContentBlocks(content)?.sourceChars
    ?? serializedContentLength(content);
}

function projectionEntry<T extends ContextMessage>(
  messages: readonly T[],
  index: number,
  decision: NewProjection<T>,
  cwd?: string,
): ProjectionEntry {
  const fields = messages[index] as Record<string, unknown>;
  const projectedMessage = cloneProjectionValue(decision.message);
  const projectedFields = projectedMessage as Record<string, unknown>;
  return {
    toolCallId: fields.toolCallId as string,
    sourceHash: projectionSourceHash(messages, index, cwd),
    toolName: typeof fields.toolName === "string" ? fields.toolName : "unknown",
    isError: fields.isError === true,
    projectedContent: cloneProjectionValue((projectedFields.content as ContentBlock[]) ?? []),
    projectedMessage,
    sourceChars: contentCharacters(fields.content),
    retainedChars: contentCharacters(projectedFields.content),
    retainedSourceChars: decision.retainedSourceChars,
    budgetEligible: decision.budgetEligible,
    recoverable: decision.recoverable,
    transformed: !isDeepStrictEqual(fields.content, projectedFields.content),
    ...(decision.projectionKind ? { projectionKind: decision.projectionKind } : {}),
  };
}

export function retainedProjectionBudget(epoch: ProjectionEpoch): number {
  return [...epoch.entries.values()].reduce(
    (sum, entry) => sum + (entry.budgetEligible ? entry.retainedSourceChars : 0),
    0,
  );
}

function recordProjectionStats(stats: TransformStats, entry: ProjectionEntry) {
  stats.scanned++;
  if (entry.transformed) {
    stats.transformed++;
    if (entry.projectionKind) stats.transformedBy[entry.projectionKind]++;
    stats.omittedChars += Math.max(0, entry.sourceChars - entry.retainedChars);
    stats.netCharsSaved += Math.max(0, entry.sourceChars - entry.retainedChars);
  } else {
    stats.skipped.atOrBelowThreshold++;
  }
  const key = /^[a-zA-Z0-9_-]{1,64}$/.test(entry.toolName) ? entry.toolName : "other";
  const usage = stats.byTool[key] ?? { scanned: 0, transformed: 0, sourceChars: 0, retainedChars: 0, netCharsSaved: 0 };
  usage.scanned++;
  usage.sourceChars += entry.sourceChars;
  usage.retainedChars += entry.retainedChars;
  if (entry.transformed) usage.transformed++;
  usage.netCharsSaved += Math.max(0, entry.sourceChars - entry.retainedChars);
  stats.byTool[key] = usage;
}

// TODO(pi-sieve): compare restored legacy and rollover epochs across more retained real sessions before choosing a long-term default.
/** Applies an immutable epoch ledger to an outbound-only raw context copy. */
export function stableSieveMessages<T extends ContextMessage>(
  messages: readonly T[],
  epoch: ProjectionEpoch,
  options: SieveOptions = {},
): StableTransformResult<T> {
  const threshold = epoch.config.threshold;
  const counts = new Map<string, number>();
  for (const message of messages) {
    const fields = message as Record<string, unknown>;
    if (fields.role === "toolResult" && typeof fields.toolCallId === "string" && fields.toolCallId)
      counts.set(fields.toolCallId, (counts.get(fields.toolCallId) ?? 0) + 1);
  }

  const output = [...messages];
  const stats = emptyTransformStats();
  const recoverableActiveResults: RecoverableActiveResult[] = [];
  const diagnostics: ProjectionDiagnostics = {
    newProjections: 0,
    cacheHits: 0,
    ambiguousIds: 0,
    sourceMismatches: 0,
    historyMismatches: 0,
    ambiguousReflows: 0,
    softBudgetExceeded: false,
    estimatedInvalidatedChars: 0,
    requiresReflow: false,
  };
  const rawMessageHashes = messages.map((message) => projectionHash(message));

  for (let index = 0; index < messages.length; index++) {
    const fields = messages[index] as Record<string, unknown>;
    const toolCallId = fields.toolCallId;
    if (fields.role !== "toolResult" || typeof toolCallId !== "string" || !toolCallId) continue;
    const existing = epoch.entries.get(toolCallId);
    if (counts.get(toolCallId)! > 1 && existing?.transformed) {
      diagnostics.ambiguousReflows++;
      diagnostics.requiresReflow = true;
      diagnostics.earliestChangedMessageIndex = index;
      diagnostics.estimatedInvalidatedChars = messages.slice(index).reduce(
        (sum, value) => sum + serializedContentLength(value),
        0,
      );
      return { messages: output, stats, recoverableActiveResults, diagnostics };
    }
    if (counts.get(toolCallId) === 1 && existing
      && existing.sourceHash !== projectionSourceHash(messages, index, options.cwd)) {
      diagnostics.sourceMismatches++;
      diagnostics.requiresReflow = true;
      diagnostics.earliestChangedMessageIndex = index;
      diagnostics.estimatedInvalidatedChars = messages.slice(index).reduce(
        (sum, value) => sum + serializedContentLength(value),
        0,
      );
      return { messages: output, stats, recoverableActiveResults, diagnostics };
    }
  }

  const historicalLength = epoch.rawMessageHashes.length;
  let changedIndex: number | undefined;
  for (let index = 0; index < historicalLength; index++) {
    if (rawMessageHashes[index] !== epoch.rawMessageHashes[index]) {
      changedIndex = index;
      break;
    }
  }
  if (changedIndex !== undefined || rawMessageHashes.length < historicalLength) {
    diagnostics.historyMismatches++;
    diagnostics.requiresReflow = true;
    diagnostics.earliestChangedMessageIndex = changedIndex ?? rawMessageHashes.length;
    diagnostics.estimatedInvalidatedChars = messages.slice(diagnostics.earliestChangedMessageIndex).reduce(
      (sum, value) => sum + serializedContentLength(value),
      0,
    );
    return { messages: output, stats, recoverableActiveResults, diagnostics };
  }

  const usedIds = new Set<string>();
  for (let index = 0; index < messages.length; index++) {
    const raw = messages[index];
    const fields = raw as Record<string, unknown>;
    if (fields.role !== "toolResult") continue;
    const toolCallId = fields.toolCallId;
    if (typeof toolCallId !== "string" || !toolCallId) {
      diagnostics.ambiguousIds++;
      continue;
    }
    const sourceHash = projectionSourceHash(messages, index, options.cwd);
    const existing = epoch.entries.get(toolCallId);
    if (counts.get(toolCallId) !== 1) {
      epoch.taintedIds.add(toolCallId);
      diagnostics.ambiguousIds++;
      if (existing && !usedIds.has(toolCallId) && existing.sourceHash === sourceHash) {
        output[index] = cloneProjectionValue(existing.projectedMessage) as T;
        usedIds.add(toolCallId);
        diagnostics.cacheHits++;
        recordProjectionStats(stats, existing);
      }
      continue;
    }
    if (existing) {
      if (existing.sourceHash !== sourceHash) {
        diagnostics.sourceMismatches++;
        diagnostics.requiresReflow = true;
        diagnostics.earliestChangedMessageIndex ??= index;
        diagnostics.estimatedInvalidatedChars += messages.slice(index).reduce(
          (sum, value) => sum + serializedContentLength(value),
          0,
        );
        continue;
      }
      output[index] = cloneProjectionValue(existing.projectedMessage) as T;
      diagnostics.cacheHits++;
      recordProjectionStats(stats, existing);
      if (existing.recoverable && !epoch.taintedIds.has(toolCallId))
        recoverableActiveResults.push({ toolCallId, toolName: existing.toolName, isError: existing.isError });
      continue;
    }

    const decision = projectNewResult(messages, index, threshold, {
      pruneActive: epoch.config.activePruning,
      cwd: options.cwd,
    });
    const entry = projectionEntry(messages, index, decision, options.cwd);
    epoch.entries.set(toolCallId, entry);
    output[index] = cloneProjectionValue(entry.projectedMessage) as T;
    diagnostics.newProjections++;
    recordProjectionStats(stats, entry);
    if (entry.recoverable) recoverableActiveResults.push({ toolCallId, toolName: entry.toolName, isError: entry.isError });
  }

  epoch.rawMessageHashes = rawMessageHashes;
  diagnostics.softBudgetExceeded = retainedProjectionBudget(epoch) > epoch.config.rolloverHighMultiplier * threshold;
  return { messages: output, stats, recoverableActiveResults, diagnostics };
}

/** Seeds an empty stable epoch newest-to-oldest under one retained-source target, then freezes it. */
export function rolloverStableSieveMessages<T extends ContextMessage>(
  messages: readonly T[],
  epoch: ProjectionEpoch,
  retainedSourceTarget: number,
  options: SieveOptions = {},
): StableTransformResult<T> {
  if (epoch.entries.size || epoch.rawMessageHashes.length) throw new Error("rollover epoch must be empty");
  const counts = new Map<string, number>();
  for (const message of messages) {
    const fields = message as Record<string, unknown>;
    if (fields.role === "toolResult" && typeof fields.toolCallId === "string" && fields.toolCallId)
      counts.set(fields.toolCallId, (counts.get(fields.toolCallId) ?? 0) + 1);
  }

  let remaining = Math.max(0, retainedSourceTarget);
  let seeded = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const fields = messages[index] as Record<string, unknown>;
    const toolCallId = fields.toolCallId;
    if (fields.role !== "toolResult" || typeof toolCallId !== "string" || !toolCallId || counts.get(toolCallId) !== 1) continue;
    const decision = projectNewResult(messages, index, epoch.config.threshold, {
      pruneActive: epoch.config.activePruning,
      cwd: options.cwd,
      retainedSourceCap: remaining,
    });
    const entry = projectionEntry(messages, index, decision, options.cwd);
    epoch.entries.set(toolCallId, entry);
    if (entry.budgetEligible) remaining = Math.max(0, remaining - entry.retainedSourceChars);
    seeded++;
  }

  const result = stableSieveMessages(messages, epoch, options);
  result.diagnostics.newProjections = seeded;
  result.diagnostics.cacheHits = Math.max(0, result.diagnostics.cacheHits - seeded);
  return result;
}
