import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const SIEVE_THRESHOLD = 8_192;
export const HELIOS_BROWSER_TOOL_NAME = "helios_browser";
export const PLAIN_ELIGIBLE_TOOL_NAMES = [
  "bash",
  "grep",
  "find",
  "ls",
  "rg",
  "fd",
  "heartbeat_status",
  "memory",
  HELIOS_BROWSER_TOOL_NAME,
] as const;
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
export const DEFAULT_ROLLOVER_HIGH_MULTIPLIER = 8;
export const DEFAULT_ROLLOVER_LOW_MULTIPLIER = 4;
export const PROJECTION_POLICY_VERSION = 2;

export type SieveOptions = { pruneActive?: boolean; cwd?: string; retainedSourceCap?: number };

export type StandardProjectionKind =
  "activeThreshold" | "ageThreshold" | "budget" | "staleRead" | "duplicate" | "errorCap";

export type StandardProjectionDiagnostics = {
  replacements: Array<{ messageIndex: number; kind: StandardProjectionKind }>;
};

export type EligibleToolName = (typeof ELIGIBLE_TOOL_NAMES)[number];

export type ContextMessage = { role?: unknown };

export type ContentBlock = { type: string; [field: string]: unknown };

export type TextBlock = ContentBlock & { type: "text"; text: string };

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
  transformedBy: {
    ageThreshold: number;
    budget: number;
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

export type RecoverableActiveResult = { toolCallId: string; toolName: string; isError: boolean };

export type TransformResult<T extends ContextMessage> = {
  messages: T[];
  stats: TransformStats;
  recoverableActiveResults: RecoverableActiveResult[];
};

export type StandardV2TransformResult<T extends ContextMessage> = TransformResult<T> & {
  diagnostics: StandardProjectionDiagnostics;
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

export function emptyToolTransformStats(): ToolTransformStats {
  return { scanned: 0, transformed: 0, sourceChars: 0, retainedChars: 0, netCharsSaved: 0 };
}

export function emptyTransformStats(): TransformStats {
  return {
    scanned: 0,
    transformed: 0,
    transformedBy: {
      ageThreshold: 0,
      budget: 0,
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

/** Sums every counter of a flat numeric record, so new counters need no separate wiring. */
function addCounters<T extends Record<string, number>>(target: T, source: T) {
  for (const key of Object.keys(target) as Array<keyof T>) {
    target[key] = (target[key] + source[key]) as T[keyof T];
  }
}

/** Adds source stats to target, preserving the target object for runtime totals. */
export function addTransformStats(target: TransformStats, source: TransformStats): TransformStats {
  target.scanned += source.scanned;
  target.transformed += source.transformed;
  target.omittedChars += source.omittedChars;
  target.netCharsSaved += source.netCharsSaved;
  addCounters(target.transformedBy, source.transformedBy);
  addCounters(target.skipped, source.skipped);
  for (const [toolName, usage] of Object.entries(source.byTool)) {
    const current = target.byTool[toolName] ?? emptyToolTransformStats();
    addCounters(current, usage);
    target.byTool[toolName] = current;
  }
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

export function activeOmissionMarker(toolName: string, toolCallId: string, sourceChars: number, omittedChars: number) {
  return `[pi-sieve: ${toolName}; omitted ${omittedChars}/${sourceChars} chars; sieve_recall ${JSON.stringify(toolCallId)}]`;
}

/** A deliberately content-free recovery marker for Continuity's retained suffix. */
export function continuityOmissionMarker(toolName: string, toolCallId: string, omittedChars: number) {
  return `[pi-sieve: ${toolName}; ${omittedChars} chars omitted; sieve_recall ${JSON.stringify(toolCallId)}]`;
}

export function duplicateMarker(
  toolName: string,
  originalToolCallId: string,
  duplicateToolCallId: string | undefined,
  sourceChars: number,
) {
  return `[pi-sieve: duplicate ${toolName} (${sourceChars} chars); same as ${JSON.stringify(originalToolCallId)}${duplicateToolCallId ? `; sieve_recall ${JSON.stringify(duplicateToolCallId)}` : ""}]`;
}

export function staleReadMarker(path: string, sourceChars: number) {
  return `[pi-sieve: stale read of ${JSON.stringify(path)} (${sourceChars} chars) omitted; superseded by a post-mutation read]`;
}

function textOnlyBlocks(content: unknown): TextBlock[] | undefined {
  if (!Array.isArray(content) || !content.length) return undefined;
  if (
    content.some(
      block =>
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

export function effectiveThresholdForAge(age: number, threshold: number) {
  if (age <= 5) return threshold;
  return Math.max(1_000, Math.floor(threshold / 2));
}

function standardV2BudgetCapacity(remaining: number, desired: number, threshold: number) {
  if (remaining >= desired) return desired;
  const half = Math.min(desired, Math.max(1, Math.floor(threshold / 2)));
  return remaining >= half ? half : 0;
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
    if (fields.toolName === HELIOS_BROWSER_TOOL_NAME && !textOnlyBlocks(fields.content)) return undefined;
    const details = fields.details;
    if (
      fields.toolName === "memory" &&
      (!details ||
        typeof details !== "object" ||
        Array.isArray(details) ||
        (details as Record<string, unknown>).memoryList !== true)
    )
      return undefined;
    return {
      toolName: fields.toolName,
      isError: fields.isError === true,
      recalled: false,
      kind: sourceKind(fields.toolName),
    };
  }
  if (!allowRecall || fields.toolName !== RECALL_TOOL_NAME || fields.isError === true) return undefined;
  const details = fields.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const recall = details as Record<string, unknown>;
  if (
    recall.found !== true ||
    typeof recall.sourceToolName !== "string" ||
    !eligibleTools.has(recall.sourceToolName) ||
    typeof recall.sourceIsError !== "boolean" ||
    (recall.sourceToolName === HELIOS_BROWSER_TOOL_NAME && !textOnlyBlocks(fields.content))
  )
    return undefined;
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
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
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
    return jsonObject(JSON.parse(blocks.map(block => block.text).join("")));
  } catch {
    return undefined;
  }
}

function validStructuredContent(blocks: TextBlock[], kind: Exclude<SieveKind, "plain">): boolean {
  const parsed = parseJsonText(blocks);
  if (!parsed) return false;
  if (kind === "rankedSearch")
    return Array.isArray(parsed.results) && parsed.results.every(result => jsonObject(result) !== undefined);
  if (!Array.isArray(parsed.files)) return false;
  const paths = new Set<string>();
  for (const file of parsed.files) {
    const value = jsonObject(file);
    if (!value || typeof value.path !== "string" || paths.has(value.path) || !Array.isArray(value.locations))
      return false;
    paths.add(value.path);
    for (const location of value.locations) {
      const item = jsonObject(location);
      if (
        !item ||
        typeof item.line !== "number" ||
        typeof item.text !== "string" ||
        !Array.isArray(item.roles) ||
        item.roles.some(role => typeof role !== "string")
      )
        return false;
    }
  }
  return true;
}

/**
 * Shrinks a structured result to the largest item count whose outbound and retained
 * forms both fit. `build` returns the projection for a given count, newest count first.
 */
function shrinkUntilFits(
  itemCount: number,
  sourceChars: number,
  build: (returned: number) => { withoutMarker: string; outboundText: string },
  maxOutboundChars: number,
  maxRetainedChars: number,
): StructuredSlice | undefined {
  for (let returned = itemCount; returned >= 0; returned--) {
    const { withoutMarker, outboundText } = build(returned);
    if (outboundText.length <= maxOutboundChars && withoutMarker.length <= maxRetainedChars) {
      return {
        outboundText,
        omittedChars: Math.max(0, sourceChars - withoutMarker.length),
        retainedChars: withoutMarker.length,
      };
    }
  }
  return undefined;
}

/** Named so the retained budget and the recall id can never be passed in the wrong order. */
type StructuredSliceOptions = { maxRetainedChars?: number; toolCallId?: string };

function sliceRankedSearch(
  blocks: TextBlock[],
  source: SieveSource,
  maxOutboundChars: number,
  { maxRetainedChars = Number.POSITIVE_INFINITY, toolCallId }: StructuredSliceOptions = {},
): StructuredSlice | undefined {
  const text = blocks.map(block => block.text).join("");
  const parsed = parseJsonText(blocks);
  if (!parsed || !Array.isArray(parsed.results)) return undefined;
  const results = parsed.results;
  const base = { ...parsed };
  delete base.results;
  delete base.piSieve;
  return shrinkUntilFits(
    results.length,
    text.length,
    returned => {
      const ranked = {
        ...base,
        results: results.slice(0, returned),
        returned,
        truncated: base.truncated === true || returned < results.length,
      };
      return {
        withoutMarker: JSON.stringify(ranked),
        outboundText: JSON.stringify({
          ...ranked,
          piSieve: structuredPruneMetadata(
            source,
            text.length,
            "omittedResults",
            results.length - returned,
            toolCallId,
          ),
        }),
      };
    },
    maxOutboundChars,
    maxRetainedChars,
  );
}

function sliceRelationshipGraph(
  blocks: TextBlock[],
  source: SieveSource,
  maxOutboundChars: number,
  { maxRetainedChars = Number.POSITIVE_INFINITY, toolCallId }: StructuredSliceOptions = {},
): StructuredSlice | undefined {
  const text = blocks.map(block => block.text).join("");
  const parsed = parseJsonText(blocks);
  if (!parsed || !Array.isArray(parsed.files)) return undefined;
  const files = parsed.files;
  const locationCount = files.reduce((count, file) => {
    const value = jsonObject(file);
    return count + (Array.isArray(value?.locations) ? value.locations.length : 0);
  }, 0);
  const originalMetadata = jsonObject(parsed.metadata) ?? {};
  const base = { ...parsed };
  delete base.files;
  delete base.piSieve;

  return shrinkUntilFits(
    locationCount,
    text.length,
    returned => {
      let remaining = returned;
      const selectedFiles: JsonObject[] = [];
      for (const file of files) {
        if (remaining <= 0) break;
        const value = jsonObject(file)!;
        const locations = (value.locations as unknown[]).slice(0, remaining);
        if (locations.length) selectedFiles.push({ ...value, locations });
        remaining -= locations.length;
      }
      const graph = {
        ...base,
        files: selectedFiles,
        metadata: {
          ...originalMetadata,
          returnedCount: returned,
          truncated: originalMetadata.truncated === true || returned < locationCount,
        },
      };
      return {
        withoutMarker: JSON.stringify(graph),
        outboundText: JSON.stringify({
          ...graph,
          piSieve: structuredPruneMetadata(
            source,
            text.length,
            "omittedLocations",
            locationCount - returned,
            toolCallId,
          ),
        }),
      };
    },
    maxOutboundChars,
    maxRetainedChars,
  );
}

/** Where the retained text sits relative to the marker. Errors keep only their tail. */
type SliceLayout = "head-tail" | "tail-only";

/**
 * Fits `text` plus an inline marker into the outbound and retained budgets.
 * The marker names the omitted char count, so its own width shifts that count;
 * only the decimal width matters, so re-deriving it reaches a fixed point.
 */
function sliceTextWithMarker(
  text: string,
  makeMarker: (omittedChars: number) => string,
  maxOutboundChars: number,
  maxRetainedChars: number,
  layout: SliceLayout,
): { outboundText: string; omittedText: string; retainedChars: number } | undefined {
  if (maxRetainedChars <= 0) return undefined;
  const separators = layout === "tail-only" ? 1 : 2;
  let omittedChars = text.length;
  for (;;) {
    const marker = makeMarker(omittedChars);
    const retainedChars = Math.min(maxRetainedChars, maxOutboundChars - marker.length - separators);
    if (retainedChars <= 0) return undefined;
    const nextOmittedChars = text.length - retainedChars;
    if (nextOmittedChars !== omittedChars) {
      omittedChars = nextOmittedChars;
      continue;
    }
    if (layout === "tail-only") {
      return {
        outboundText: marker + "\n" + text.slice(-retainedChars),
        omittedText: text.slice(0, -retainedChars),
        retainedChars,
      };
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

function sliceOldSuccess(
  blocks: TextBlock[],
  source: SieveSource,
  maxOutboundChars: number,
  maxRetainedChars: number,
): OldSuccessSlice | undefined {
  const text = blocks.map(block => block.text).join("");
  return sliceTextWithMarker(
    text,
    omittedChars => partialOmissionMarker(source.toolName, text.length, omittedChars, source.recalled),
    maxOutboundChars,
    maxRetainedChars,
    "head-tail",
  );
}

function sliceActiveResult(
  blocks: TextBlock[],
  source: SieveSource,
  toolCallId: string,
  threshold: number,
  maxRetainedChars = Number.POSITIVE_INFINITY,
): ActiveSlice | undefined {
  const text = blocks.map(block => block.text).join("");
  return sliceTextWithMarker(
    text,
    omittedChars => activeOmissionMarker(source.toolName, toolCallId, text.length, omittedChars),
    threshold,
    maxRetainedChars,
    source.isError ? "tail-only" : "head-tail",
  );
}

function mixedContentBlocks(
  content: unknown,
): { blocks: ContentBlock[]; textIndexes: number[]; sourceChars: number } | undefined {
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

type MixedSlice<T> = { message: T; omittedChars: number; retainedChars: number; netCharsSaved: number };
/** What one text block became. `text` absent leaves the block untouched. */
type MixedBlockOutcome = { text?: string; omittedChars: number; retainedChars: number };

/**
 * Splits the outbound and retained budgets evenly across a message's text blocks and
 * rewrites each one through `sliceBlock`. A block strategy returning undefined aborts
 * the whole message, so callers that must not partially prune can say so.
 */
function sliceMixedContent<T extends ContextMessage>(
  message: T,
  maxOutboundChars: number,
  maxRetainedChars: number,
  sliceBlock: (block: TextBlock, shareOutbound: number, shareRetained: number) => MixedBlockOutcome | undefined,
): MixedSlice<T> | undefined {
  const mixed = mixedContentBlocks((message as Record<string, unknown>).content);
  if (!mixed) return undefined;
  const shareOutbound = Math.max(1, Math.floor(maxOutboundChars / mixed.textIndexes.length));
  const shareRetained = Math.max(0, Math.floor(maxRetainedChars / mixed.textIndexes.length));
  const content = mixed.blocks.map(block => ({ ...block }));
  let omittedChars = 0;
  let retainedChars = 0;
  for (const index of mixed.textIndexes) {
    const block = mixed.blocks[index] as TextBlock;
    const outcome = sliceBlock(block, shareOutbound, shareRetained);
    if (!outcome) return undefined;
    if (outcome.text !== undefined) content[index] = { ...block, text: outcome.text };
    omittedChars += outcome.omittedChars;
    retainedChars += outcome.retainedChars;
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

function sliceMixedActive<T extends ContextMessage>(
  message: T,
  source: SieveSource,
  toolCallId: string,
  threshold: number,
  maxRetainedChars = Number.POSITIVE_INFINITY,
): MixedSlice<T> | undefined {
  const mixed = mixedContentBlocks((message as Record<string, unknown>).content);
  if (!mixed || mixed.sourceChars <= threshold) return undefined;
  return sliceMixedContent(message, threshold, maxRetainedChars, (block, shareOutbound, shareRetained) => {
    if (block.text.length <= shareOutbound && block.text.length <= shareRetained)
      return { omittedChars: 0, retainedChars: block.text.length };
    const sliced = sliceActiveResult([block], source, toolCallId, shareOutbound, shareRetained);
    // Active results must stay wholly recoverable, so a block that will not fit aborts the message.
    if (!sliced) return undefined;
    return {
      text: sliced.outboundText,
      omittedChars: sliced.omittedText.length,
      retainedChars: block.text.length - sliced.omittedText.length,
    };
  });
}

function sliceMixedOld<T extends ContextMessage>(
  message: T,
  source: SieveSource,
  maxOutboundChars: number,
  maxRetainedChars: number,
): MixedSlice<T> | undefined {
  return sliceMixedContent(message, maxOutboundChars, maxRetainedChars, (block, shareOutbound, shareRetained) => {
    const sliced = sliceOldSuccess([block], source, shareOutbound, shareRetained);
    if (sliced) {
      return {
        text: sliced.outboundText,
        omittedChars: sliced.omittedText.length,
        retainedChars: sliced.retainedChars,
      };
    }
    const marker = source.recalled
      ? recalledOmissionMarker(source.toolName, block.text.length)
      : omissionMarker(source.toolName, block.text.length);
    return marker.length >= block.text.length
      ? { omittedChars: 0, retainedChars: block.text.length }
      : { text: marker, omittedChars: block.text.length, retainedChars: 0 };
  });
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
  return Number.isSafeInteger(value) && (value as number) >= 1 ? (value as number) : undefined;
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
  return (
    !!edits?.length &&
    edits.every(value => {
      const edit = jsonObject(value);
      if (!edit) return false;
      if (typeof edit.oldText === "string" && typeof edit.newText === "string") {
        const oldLines = edit.oldText.match(/\r\n|\r|\n/g)?.length ?? 0;
        const newLines = edit.newText.match(/\r\n|\r|\n/g)?.length ?? 0;
        return oldLines === newLines;
      }
      if (edit.operation !== "replace" || typeof edit.newText !== "string") return false;
      const start = positiveInteger(edit.startLine);
      const end = positiveInteger(edit.endLine);
      if (start === undefined || end === undefined || end < start) return false;
      const replacementLines = edit.newText === "" ? 0 : edit.newText.split(/\r\n|\r|\n/).length;
      return replacementLines === end - start + 1;
    })
  );
}

function readCoverage(argumentsValue: JsonObject, details: unknown, blocks: TextBlock[]): ReadCoverage | undefined {
  if (blocks.length !== 1) return undefined;
  const detailFields = jsonObject(details);
  const lineEdit = jsonObject(detailFields?.lineEdit);
  if (lineEdit?.version === 1) {
    const startLine = positiveInteger(lineEdit.startLine);
    const endLine = positiveInteger(lineEdit.endLine);
    if (startLine !== undefined && endLine !== undefined && endLine >= startLine)
      return { start: startLine, end: endLine };
    return undefined;
  }
  const start = argumentsValue.offset === undefined ? 1 : positiveInteger(argumentsValue.offset);
  const limit = argumentsValue.limit === undefined ? undefined : positiveInteger(argumentsValue.limit);
  if (start === undefined || (argumentsValue.limit !== undefined && limit === undefined)) return undefined;

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
  "edit",
  "write",
  "continuity_update",
  "heartbeat_start",
  "heartbeat_cancel",
  "memory",
  RECALL_TOOL_NAME,
]);

function serializedContentLength(content: unknown): number {
  try {
    return JSON.stringify(content)?.length ?? 0;
  } catch {
    return 0;
  }
}

function supportsDuplicateFingerprint(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || value === undefined || ["string", "boolean", "number"].includes(typeof value)) return true;
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key === "symbol" || (key !== "length" && !/^\d+$/.test(key)))) return false;
    return keys.every(key => key === "length" || supportsDuplicateFingerprint(value[Number(key)], seen));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !supportsDuplicateFingerprint(descriptor.value, seen)) return false;
  }
  return true;
}

function genericDuplicateFingerprint(call: TrackedToolCall, result: TrackedToolResult): string | undefined {
  const value = [call.arguments, result.fields.details, result.fields.content];
  return supportsDuplicateFingerprint(value) ? projectionHash(value) : undefined;
}

type ToolCallIndex = {
  calls: TrackedToolCall[];
  callCounts: Map<string, number>;
  results: Map<string, TrackedToolResult>;
  resultCounts: Map<string, number>;
  /** A call is unambiguous when exactly one call and one result carry its id. */
  isUnique(toolCallId: string): boolean;
};

/** One pass over the transcript pairing tool calls with their results. */
function indexToolCalls<T extends ContextMessage>(messages: readonly T[]): ToolCallIndex {
  const calls: TrackedToolCall[] = [];
  const callCounts = new Map<string, number>();
  const results = new Map<string, TrackedToolResult>();
  const resultCounts = new Map<string, number>();
  let assistantOrdinal = 0;
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const fields = messages[messageIndex] as Record<string, unknown>;
    if (fields.role === "assistant" && Array.isArray(fields.content)) {
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
      continue;
    }
    if (fields.role !== "toolResult" || typeof fields.toolCallId !== "string" || !fields.toolCallId) continue;
    resultCounts.set(fields.toolCallId, (resultCounts.get(fields.toolCallId) ?? 0) + 1);
    results.set(fields.toolCallId, { fields, messageIndex });
  }
  return {
    calls,
    callCounts,
    results,
    resultCounts,
    isUnique: toolCallId => callCounts.get(toolCallId) === 1 && resultCounts.get(toolCallId) === 1,
  };
}

/** Counts tool results per toolCallId; ids seen more than once are ambiguous. */
function toolResultCounts<T extends ContextMessage>(messages: readonly T[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const fields = message as Record<string, unknown>;
    if (fields.role === "toolResult" && typeof fields.toolCallId === "string" && fields.toolCallId)
      counts.set(fields.toolCallId, (counts.get(fields.toolCallId) ?? 0) + 1);
  }
  return counts;
}

function exactDuplicateReplacements<T extends ContextMessage>(
  messages: readonly T[],
  cwd: string,
  existing: ReadonlyMap<number, T>,
  recoverable: boolean,
): DuplicateReplacement<T>[] {
  const { calls, results, isUnique } = indexToolCalls(messages);
  const uniqueCalls = calls.filter(call => isUnique(call.id));
  const candidates = uniqueCalls.flatMap(call => {
    const result = results.get(call.id);
    if (
      !result ||
      result.messageIndex <= call.messageIndex ||
      result.fields.isError === true ||
      existing.has(result.messageIndex)
    )
      return [];
    if (!Array.isArray(result.fields.content) || !result.fields.content.length) return [];
    return [{ call, result }];
  });
  const replacements: DuplicateReplacement<T>[] = [];
  const replaced = new Set<number>();

  // Read duplicates use source identity and the path's mutation generation.
  const mutationIndexes = new Map<string, number[]>();
  for (const call of calls) {
    if (call.name !== "edit" && call.name !== "write") continue;
    const path = normalizedToolPath(call.arguments, cwd);
    if (!path) continue;
    const indexes = mutationIndexes.get(path) ?? [];
    indexes.push(call.messageIndex);
    mutationIndexes.set(path, indexes);
  }
  const mutationGeneration = (path: string, messageIndex: number) => {
    const indexes = mutationIndexes.get(path) ?? [];
    let low = 0,
      high = indexes.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (indexes[middle]! <= messageIndex) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const earlierReads = new Map<string, (typeof candidates)[number]>();
  for (const candidate of candidates.filter(({ call }) => call.name === READ_TOOL_NAME)) {
    const path = normalizedToolPath(candidate.call.arguments, cwd);
    const blocks = textOnlyBlocks(candidate.result.fields.content);
    const coverage = blocks && readCoverage(candidate.call.arguments, candidate.result.fields.details, blocks);
    if (!path || !coverage || !blocks) continue;
    const fingerprint = projectionHash(candidate.result.fields.content);
    const originalKey = `${path}\0${coverage.start}\0${coverage.end}\0${fingerprint}\0${mutationGeneration(path, candidate.result.messageIndex)}`;
    const lookupKey = `${path}\0${coverage.start}\0${coverage.end}\0${fingerprint}\0${mutationGeneration(path, candidate.call.messageIndex)}`;
    const original = earlierReads.get(lookupKey);
    if (!original || !isDeepStrictEqual(original.result.fields.content, candidate.result.fields.content)) {
      earlierReads.set(originalKey, candidate);
      continue;
    }
    const sourceChars = blocks.reduce((sum, block) => sum + block.text.length, 0);
    const marker = duplicateMarker(
      READ_TOOL_NAME,
      original.call.id,
      recoverable ? candidate.call.id : undefined,
      sourceChars,
    );
    if (marker.length >= sourceChars) continue;
    replacements.push({
      messageIndex: candidate.result.messageIndex,
      message: replaceWithMarker(messages[candidate.result.messageIndex], marker),
      sourceChars,
      markerChars: marker.length,
      toolName: READ_TOOL_NAME,
      ...(recoverable
        ? { recoverable: { toolCallId: candidate.call.id, toolName: READ_TOOL_NAME, isError: false } }
        : {}),
    });
    replaced.add(candidate.result.messageIndex);
  }

  const earlierGeneric: typeof candidates = [];
  const fingerprintBuckets = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const nonTextHelios =
      candidate.call.name === HELIOS_BROWSER_TOOL_NAME && !textOnlyBlocks(candidate.result.fields.content);
    if (
      candidate.call.name === READ_TOOL_NAME ||
      duplicateExcludedTools.has(candidate.call.name) ||
      nonTextHelios ||
      replaced.has(candidate.result.messageIndex)
    )
      continue;
    const fingerprint = genericDuplicateFingerprint(candidate.call, candidate.result);
    const bucketKey = fingerprint ? `${candidate.call.name}\0${fingerprint}` : undefined;
    const pool = bucketKey ? (fingerprintBuckets.get(bucketKey) ?? []) : earlierGeneric;
    const original = pool.find(
      ({ call, result }) =>
        call.name === candidate.call.name &&
        isDeepStrictEqual(call.arguments, candidate.call.arguments) &&
        isDeepStrictEqual(result.fields.details, candidate.result.fields.details) &&
        isDeepStrictEqual(result.fields.content, candidate.result.fields.content),
    );
    if (!original) {
      earlierGeneric.push(candidate);
      if (bucketKey) {
        const bucket = fingerprintBuckets.get(bucketKey) ?? [];
        bucket.push(candidate);
        fingerprintBuckets.set(bucketKey, bucket);
      }
      continue;
    }
    const sourceChars =
      textOnlyContentLength(candidate.result.fields.content) ??
      serializedContentLength(candidate.result.fields.content);
    const marker = duplicateMarker(
      candidate.call.name,
      original.call.id,
      recoverable ? candidate.call.id : undefined,
      sourceChars,
    );
    if (marker.length >= serializedContentLength(candidate.result.fields.content)) continue;
    replacements.push({
      messageIndex: candidate.result.messageIndex,
      message: replaceWithMarker(messages[candidate.result.messageIndex], marker),
      sourceChars,
      markerChars: marker.length,
      toolName: candidate.call.name,
      ...(recoverable
        ? { recoverable: { toolCallId: candidate.call.id, toolName: candidate.call.name, isError: false } }
        : {}),
    });
    replaced.add(candidate.result.messageIndex);
  }
  return replacements;
}

function staleReadReplacements<T extends ContextMessage>(messages: readonly T[], cwd: string) {
  const { calls, callCounts, results, resultCounts } = indexToolCalls(messages);
  const uniqueCalls = new Map(calls.filter(call => callCounts.get(call.id) === 1).map(call => [call.id, call]));

  const reads: TrackedRead[] = [];
  for (const [toolCallId, call] of uniqueCalls) {
    const result = results.get(toolCallId);
    if (
      call.name !== READ_TOOL_NAME ||
      resultCounts.get(toolCallId) !== 1 ||
      !result ||
      result.messageIndex <= call.messageIndex ||
      result.fields.isError !== false
    )
      continue;
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
    const result = callCounts.get(call.id) === 1 && resultCounts.get(call.id) === 1 ? results.get(call.id) : undefined;
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

  const readsByPath = groupBy(reads, read => read.path);
  const mutationsByPath = groupBy(mutations, mutation => mutation.path);
  const replacements = new Map<number, T>();
  let omittedChars = 0;
  let netCharsSaved = 0;
  for (const oldRead of reads) {
    const superseded = (readsByPath.get(oldRead.path) ?? []).some(newRead =>
      supersedes(newRead, oldRead, mutationsByPath.get(oldRead.path) ?? []),
    );
    if (!superseded) continue;
    const marker = staleReadMarker(oldRead.displayPath, oldRead.sourceChars);
    if (marker.length >= oldRead.sourceChars) continue;
    replacements.set(oldRead.messageIndex, replaceWithMarker(messages[oldRead.messageIndex], marker));
    omittedChars += oldRead.sourceChars;
    netCharsSaved += oldRead.sourceChars - marker.length;
  }
  return { replacements, omittedChars, netCharsSaved };
}

function groupBy<V, K>(values: readonly V[], keyOf: (value: V) => K): Map<K, V[]> {
  const grouped = new Map<K, V[]>();
  for (const value of values) {
    const key = keyOf(value);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(value);
    else grouped.set(key, [value]);
  }
  return grouped;
}

/**
 * Whether `newRead` makes `oldRead` stale: it must come strictly later, a confirmed
 * mutation must sit between them, and it must cover at least what the old read covered
 * (either by rereading the whole file, or because every intervening edit kept line numbers).
 */
function supersedes(newRead: TrackedRead, oldRead: TrackedRead, pathMutations: readonly TrackedMutation[]): boolean {
  if (newRead.assistantOrdinal <= oldRead.assistantOrdinal || newRead.messageIndex <= oldRead.messageIndex)
    return false;
  const intervening = pathMutations.filter(
    mutation =>
      mutation.assistantOrdinal > oldRead.assistantOrdinal &&
      mutation.assistantOrdinal < newRead.assistantOrdinal &&
      mutation.callMessageIndex > oldRead.messageIndex &&
      mutation.callMessageIndex < newRead.messageIndex,
  );
  const confirmed = intervening.some(
    mutation =>
      mutation.successful &&
      mutation.resultMessageIndex !== undefined &&
      mutation.resultMessageIndex > oldRead.messageIndex &&
      mutation.resultMessageIndex < newRead.messageIndex,
  );
  if (!confirmed) return false;
  const readsWholeFile = newRead.coverage.start === 1 && newRead.coverage.end === Number.POSITIVE_INFINITY;
  if (readsWholeFile) return true;
  const lineNumbersHeld = intervening.every(
    mutation =>
      mutation.successful &&
      mutation.preservesLineNumbers &&
      mutation.resultMessageIndex !== undefined &&
      mutation.resultMessageIndex < newRead.messageIndex,
  );
  return (
    lineNumbersHeld && newRead.coverage.start <= oldRead.coverage.start && newRead.coverage.end >= oldRead.coverage.end
  );
}

/**
 * How a projection mode treats result age. Legacy tightens the threshold for old results
 * and collapses very old relationship graphs; standard v2 holds one fixed threshold and
 * quantizes the retained budget instead.
 */
type AgePolicy = {
  /** Newest ages eligible for recall-backed active pruning. */
  activeWindow: 0 | 1;
  thresholdForAge(age: number, threshold: number): number;
  budgetCapacity(remaining: number, desired: number, threshold: number): number;
  /** Legacy collapses old relationship graphs to a bare marker from this age onward. */
  relationshipGraphMarkerAge?: number;
};

const LEGACY_AGE_POLICY: AgePolicy = {
  activeWindow: 0,
  thresholdForAge: effectiveThresholdForAge,
  budgetCapacity: remaining => remaining,
  relationshipGraphMarkerAge: 6,
};

const STANDARD_V2_AGE_POLICY: AgePolicy = {
  activeWindow: 1,
  thresholdForAge: (_age, threshold) => threshold,
  budgetCapacity: standardV2BudgetCapacity,
};

type TransformCounter = keyof TransformStats["transformedBy"];

/** Mutable state shared by the phases of one standard projection pass. */
type StandardPass<T extends ContextMessage> = {
  messages: readonly T[];
  threshold: number;
  policy: AgePolicy;
  pruneActive: boolean;
  stats: TransformStats;
  replacements: Map<number, T>;
  replacementKinds: Map<number, StandardProjectionKind>;
  recoverableActiveResults: RecoverableActiveResult[];
  /** Records one replacement together with every counter it belongs to. */
  replace(
    index: number,
    message: T,
    kind: StandardProjectionKind,
    counters: readonly TransformCounter[],
    omittedChars: number,
    netCharsSaved: number,
  ): void;
};

function createStandardPass<T extends ContextMessage>(
  messages: readonly T[],
  threshold: number,
  policy: AgePolicy,
  pruneActive: boolean,
): StandardPass<T> {
  const stats = emptyTransformStats();
  const replacements = new Map<number, T>();
  const replacementKinds = new Map<number, StandardProjectionKind>();
  return {
    messages,
    threshold,
    policy,
    pruneActive,
    stats,
    replacements,
    replacementKinds,
    recoverableActiveResults: [],
    replace(index, message, kind, counters, omittedChars, netCharsSaved) {
      replacements.set(index, message);
      replacementKinds.set(index, kind);
      stats.transformed++;
      for (const counter of counters) stats.transformedBy[counter]++;
      stats.omittedChars += omittedChars;
      stats.netCharsSaved += netCharsSaved;
    },
  };
}

/** How many user messages follow each index, plus the second-newest user index. */
function messageAges<T extends ContextMessage>(messages: readonly T[]) {
  const usersAfter: number[] = [];
  const userIndexes: number[] = [];
  let userCount = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    usersAfter[index] = userCount;
    if (messages[index].role === "user") {
      userCount++;
      userIndexes.unshift(index);
    }
  }
  return { usersAfter, cutoff: userIndexes.at(-2) };
}

/** Applies the two whole-transcript passes that do not depend on age or budget. */
function recordSupersededResults<T extends ContextMessage>(pass: StandardPass<T>, cwd: string) {
  const { stats, replacements, replacementKinds } = pass;
  const staleReads = staleReadReplacements(pass.messages, cwd);
  for (const [index, message] of staleReads.replacements) {
    replacements.set(index, message);
    replacementKinds.set(index, "staleRead");
  }
  stats.scanned += staleReads.replacements.size;
  stats.transformed += staleReads.replacements.size;
  stats.transformedBy.staleRead += staleReads.replacements.size;
  stats.omittedChars += staleReads.omittedChars;
  stats.netCharsSaved += staleReads.netCharsSaved;

  for (const duplicate of exactDuplicateReplacements(pass.messages, cwd, replacements, pass.pruneActive)) {
    stats.scanned++;
    if (duplicate.recoverable) pass.recoverableActiveResults.push(duplicate.recoverable);
    pass.replace(
      duplicate.messageIndex,
      duplicate.message,
      "duplicate",
      ["duplicate"],
      duplicate.sourceChars,
      Math.max(0, duplicate.sourceChars - duplicate.markerChars),
    );
  }
}

/** Result ids inside the active window; only unambiguous ones can be recalled. */
function activeResultIdCounts<T extends ContextMessage>(
  messages: readonly T[],
  usersAfter: readonly number[],
  activeWindow: number,
) {
  const counts = new Map<string, number>();
  for (let index = 0; index < messages.length; index++) {
    const fields = messages[index] as Record<string, unknown>;
    if (fields.role !== "toolResult" || usersAfter[index] > activeWindow) continue;
    if (typeof fields.toolCallId !== "string" || !fields.toolCallId) continue;
    counts.set(fields.toolCallId, (counts.get(fields.toolCallId) ?? 0) + 1);
  }
  return counts;
}

/** The text length of a result, whether its content is all text or mixed. */
function sourceContentLength(content: unknown, mixed: ReturnType<typeof mixedContentBlocks>) {
  return textOnlyContentLength(content) ?? mixed?.sourceChars;
}

/**
 * Projects a result still inside the active window. These stay fully recoverable through
 * sieve_recall, so anything that cannot be registered for recall is left untouched.
 */
function projectActiveResult<T extends ContextMessage>(
  pass: StandardPass<T>,
  index: number,
  message: T,
  activeIdCounts: ReadonlyMap<string, number>,
) {
  const { stats, threshold } = pass;
  stats.scanned++;
  const source = sieveSource(message, false);
  if (!source) {
    stats.skipped.ineligibleTool++;
    return;
  }
  const fields = message as Record<string, unknown>;
  const blocks = textOnlyBlocks(fields.content);
  const mixed = !blocks && source.kind === "plain" ? mixedContentBlocks(fields.content) : undefined;
  const sourceLength = sourceContentLength(fields.content, mixed);
  if (sourceLength === undefined) {
    stats.skipped.nonTextMixedOrEmptyContent++;
    return;
  }
  if (source.kind === "relationshipGraph" && !source.isError) {
    stats.skipped.recentWindow++;
    return;
  }
  const errorThreshold = Math.max(SIEVE_THRESHOLD, threshold);
  const limit = source.isError ? errorThreshold : threshold;
  if (sourceLength <= limit) {
    stats.skipped.atOrBelowThreshold++;
    return;
  }
  if (source.kind === "rankedSearch" && !source.isError && blocks && !validStructuredContent(blocks, source.kind)) {
    stats.skipped.malformedStructuredContent++;
    return;
  }
  const toolCallId = fields.toolCallId;
  if (typeof toolCallId !== "string" || !toolCallId || activeIdCounts.get(toolCallId) !== 1) {
    stats.skipped.recoveryUnavailable++;
    return;
  }
  const recoverable = () =>
    pass.recoverableActiveResults.push({ toolCallId, toolName: source.toolName, isError: source.isError });
  const kind: StandardProjectionKind = source.isError ? "errorCap" : "activeThreshold";
  const errorCounters: TransformCounter[] = source.isError ? ["errorCap"] : [];

  if (mixed) {
    const sliced = sliceMixedActive(message, source, toolCallId, limit);
    if (!sliced) {
      stats.skipped.recoveryUnavailable++;
      return;
    }
    recoverable();
    pass.replace(
      index,
      sliced.message,
      kind,
      ["activeThreshold", "mixedText", ...errorCounters],
      sliced.omittedChars,
      sliced.netCharsSaved,
    );
    return;
  }
  if (!blocks) {
    stats.skipped.nonTextMixedOrEmptyContent++;
    return;
  }
  if (source.kind === "rankedSearch" && !source.isError) {
    const sliced = sliceRankedSearch(blocks, source, limit, { toolCallId });
    const outboundText = sliced?.outboundText ?? structuredMarker(source, sourceLength, toolCallId);
    if (outboundText.length >= sourceLength) {
      stats.skipped.recoveryUnavailable++;
      return;
    }
    recoverable();
    pass.replace(
      index,
      replaceWithMarker(message, outboundText),
      "activeThreshold",
      ["activeThreshold"],
      sliced?.omittedChars ?? sourceLength,
      sourceLength - outboundText.length,
    );
    return;
  }
  const sliced = sliceActiveResult(blocks, source, toolCallId, limit);
  const outboundText =
    sliced?.outboundText ?? activeOmissionMarker(source.toolName, toolCallId, sourceLength, sourceLength);
  if (outboundText.length >= sourceLength) {
    stats.skipped.recoveryUnavailable++;
    return;
  }
  recoverable();
  pass.replace(
    index,
    replaceWithMarker(message, outboundText),
    kind,
    ["activeThreshold", ...errorCounters],
    sliced?.omittedText.length ?? sourceLength,
    Math.max(0, sourceLength - outboundText.length),
  );
}

/** Caps a large old error to a head and tail around a marker. */
function projectAgedError<T extends ContextMessage>(
  pass: StandardPass<T>,
  index: number,
  message: T,
  source: SieveSource,
  textBlocks: TextBlock[] | undefined,
  sourceLength: number | undefined,
  age: number,
) {
  const { stats, threshold } = pass;
  if (age <= 1 || sourceLength === undefined || sourceLength <= threshold) {
    stats.skipped.error++;
    return;
  }
  const marker = source.recalled
    ? recalledGiantErrorMarker(source.toolName, sourceLength)
    : giantErrorMarker(source.toolName, sourceLength);
  const available = Math.max(0, threshold - marker.length - 1);
  const headChars = Math.floor(available / 4);
  const tailChars = available - headChars;
  const text = textBlocks!.map(block => block.text).join("");
  const outbound = marker + text.slice(0, headChars) + "\n" + text.slice(-tailChars);
  pass.replace(
    index,
    replaceWithMarker(message, outbound),
    "errorCap",
    ["errorCap"],
    sourceLength - headChars - tailChars,
    Math.max(0, sourceLength - outbound.length),
  );
}

/**
 * Projects a result past the active window, spending from the shared retained budget.
 * Returns the retained characters this result consumed.
 */
function projectAgedResult<T extends ContextMessage>(
  pass: StandardPass<T>,
  index: number,
  message: T,
  age: number,
  budgetRemaining: number,
): number {
  const { stats, threshold, policy } = pass;
  stats.scanned++;
  const source = sieveSource(message, true);
  if (!source) {
    stats.skipped.ineligibleTool++;
    return 0;
  }

  const fields = message as Record<string, unknown>;
  const textBlocks = textOnlyBlocks(fields.content);
  const mixed =
    age > 1 && !source.isError && source.kind === "plain" && !textBlocks
      ? mixedContentBlocks(fields.content)
      : undefined;
  const sourceLength = sourceContentLength(fields.content, mixed);
  if (source.isError) {
    projectAgedError(pass, index, message, source, textBlocks, sourceLength, age);
    return 0;
  }
  if (sourceLength === undefined) {
    stats.skipped.nonTextMixedOrEmptyContent++;
    return 0;
  }

  if (mixed) {
    const effectiveThreshold = policy.thresholdForAge(age, threshold);
    const desiredRetained = Math.min(sourceLength, effectiveThreshold);
    const availableBudget = policy.budgetCapacity(budgetRemaining, desiredRetained, threshold);
    if (sourceLength <= effectiveThreshold && sourceLength <= availableBudget) {
      stats.skipped.atOrBelowThreshold++;
      return sourceLength;
    }
    const overThreshold = sourceLength > effectiveThreshold;
    const sliced = sliceMixedOld(
      message,
      source,
      overThreshold ? effectiveThreshold : Math.max(0, sourceLength - 1),
      Math.max(0, availableBudget),
    );
    if (!sliced) {
      stats.skipped.nonTextMixedOrEmptyContent++;
      return 0;
    }
    const counter: TransformCounter = overThreshold ? "ageThreshold" : "budget";
    pass.replace(
      index,
      sliced.message,
      overThreshold && availableBudget >= desiredRetained ? "ageThreshold" : "budget",
      [counter, "mixedText"],
      sliced.omittedChars,
      sliced.netCharsSaved,
    );
    return sliced.retainedChars;
  }

  const blocks = textBlocks!;
  if (source.kind === "relationshipGraph" && age === 1) {
    stats.skipped.recentWindow++;
    return 0;
  }
  if (source.kind !== "plain" && !validStructuredContent(blocks, source.kind)) {
    stats.skipped.malformedStructuredContent++;
    return 0;
  }

  const effectiveThreshold =
    age === 1 ? (pass.pruneActive ? threshold : 3 * threshold) : policy.thresholdForAge(age, threshold);
  if (
    source.kind === "relationshipGraph" &&
    policy.relationshipGraphMarkerAge !== undefined &&
    age >= policy.relationshipGraphMarkerAge
  ) {
    const marker = structuredMarker(source, sourceLength);
    if (marker.length >= sourceLength) {
      stats.skipped.atOrBelowThreshold++;
      return sourceLength;
    }
    pass.replace(
      index,
      replaceWithMarker(message, marker),
      "ageThreshold",
      ["ageThreshold"],
      sourceLength,
      sourceLength - marker.length,
    );
    return 0;
  }
  if (age === 1 && sourceLength <= effectiveThreshold) {
    stats.skipped.atOrBelowThreshold++;
    return 0;
  }

  // Age 1 is measured against its own size, so it never draws on the shared budget.
  const remainingBudget = age === 1 ? sourceLength : budgetRemaining;
  const desiredRetained = Math.min(sourceLength, effectiveThreshold);
  const availableBudget =
    age > 1 ? policy.budgetCapacity(remainingBudget, desiredRetained, threshold) : remainingBudget;
  if (age > 1 && sourceLength <= effectiveThreshold && sourceLength <= availableBudget) {
    stats.skipped.atOrBelowThreshold++;
    return sourceLength;
  }

  const byAgeThreshold = sourceLength > effectiveThreshold;
  const kind: StandardProjectionKind = byAgeThreshold && availableBudget >= desiredRetained ? "ageThreshold" : "budget";
  const counters: TransformCounter[] = [byAgeThreshold ? "ageThreshold" : "budget"];
  const maxOutboundChars = byAgeThreshold ? effectiveThreshold : Math.max(0, sourceLength - 1);

  if (source.kind !== "plain") {
    const maxRetainedChars = age === 1 ? Number.POSITIVE_INFINITY : Math.max(0, availableBudget);
    const sliced =
      source.kind === "rankedSearch"
        ? sliceRankedSearch(blocks, source, maxOutboundChars, { maxRetainedChars })
        : sliceRelationshipGraph(blocks, source, maxOutboundChars, { maxRetainedChars });
    if (sliced && sliced.outboundText.length < sourceLength) {
      pass.replace(
        index,
        replaceWithMarker(message, sliced.outboundText),
        kind,
        counters,
        sliced.omittedChars,
        sourceLength - sliced.outboundText.length,
      );
      return age > 1 ? sliced.retainedChars : 0;
    }
    const marker = structuredMarker(source, sourceLength);
    if (marker.length >= sourceLength) {
      stats.skipped.atOrBelowThreshold++;
      return age > 1 ? sourceLength : 0;
    }
    pass.replace(index, replaceWithMarker(message, marker), kind, counters, sourceLength, sourceLength - marker.length);
    return 0;
  }

  const sliced = sliceOldSuccess(blocks, source, maxOutboundChars, availableBudget);
  if (sliced) {
    pass.replace(
      index,
      replaceWithMarker(message, sliced.outboundText),
      kind,
      counters,
      sliced.omittedText.length,
      Math.max(0, sourceLength - sliced.outboundText.length),
    );
    return age > 1 ? sliced.retainedChars : 0;
  }
  const marker = source.recalled
    ? recalledOmissionMarker(source.toolName, sourceLength)
    : omissionMarker(source.toolName, sourceLength);
  if (marker.length >= sourceLength) {
    stats.skipped.atOrBelowThreshold++;
    return age > 1 ? sourceLength : 0;
  }
  pass.replace(index, replaceWithMarker(message, marker), kind, counters, sourceLength, sourceLength - marker.length);
  return 0;
}

const TOOL_NAME_KEY = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_TRACKED_TOOL_NAMES = 32;

/** Per-tool source and retained totals, bucketing unusual or excess tool names as "other". */
function recordToolUsage<T extends ContextMessage>(
  stats: TransformStats,
  messages: readonly T[],
  replacements: ReadonlyMap<number, T>,
) {
  const toolNames = new Set<string>();
  for (let index = 0; index < messages.length; index++) {
    const fields = messages[index] as Record<string, unknown>;
    if (fields.role !== "toolResult" || typeof fields.toolName !== "string") continue;
    const key =
      TOOL_NAME_KEY.test(fields.toolName) && (toolNames.has(fields.toolName) || toolNames.size < MAX_TRACKED_TOOL_NAMES)
        ? fields.toolName
        : "other";
    toolNames.add(key);
    const sourceChars = contentCharacters(fields.content);
    const replacement = replacements.get(index) as Record<string, unknown> | undefined;
    const retainedChars = replacement ? contentCharacters(replacement.content) : sourceChars;
    const usage = stats.byTool[key] ?? emptyToolTransformStats();
    usage.scanned++;
    usage.sourceChars += sourceChars;
    usage.retainedChars += retainedChars;
    if (replacement) usage.transformed++;
    usage.netCharsSaved += Math.max(0, sourceChars - retainedChars);
    stats.byTool[key] = usage;
  }
}

/**
 * Creates an outbound-only context view. The supplied session messages and all
 * ineligible message objects remain untouched. The optional threshold keeps
 * existing callers on the default while allowing runtime configuration.
 */
function standardSieveMessages<T extends ContextMessage>(
  messages: readonly T[],
  threshold: number,
  options: SieveOptions,
  policy: AgePolicy,
): StandardV2TransformResult<T> {
  const { usersAfter, cutoff } = messageAges(messages);
  const pass = createStandardPass(messages, threshold, policy, options.pruneActive === true);
  recordSupersededResults(pass, options.cwd ?? process.cwd());
  const activeIdCounts = pass.pruneActive
    ? activeResultIdCounts(messages, usersAfter, policy.activeWindow)
    : new Map<string, number>();

  const retainedBudget = 3 * threshold;
  let retainedChars = 0;
  // Budget selection is deliberately newest-to-oldest, unlike outbound order.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "toolResult" || pass.replacements.has(index)) continue;
    const age = usersAfter[index];
    if (age <= policy.activeWindow && pass.pruneActive) {
      projectActiveResult(pass, index, message, activeIdCounts);
      continue;
    }
    if (age === 0 || cutoff === undefined) {
      pass.stats.skipped.recentWindow++;
      continue;
    }
    retainedChars += projectAgedResult(pass, index, message, age, retainedBudget - retainedChars);
  }

  recordToolUsage(pass.stats, messages, pass.replacements);
  return {
    messages: messages.map((message, index) => pass.replacements.get(index) ?? message),
    stats: pass.stats,
    recoverableActiveResults: pass.recoverableActiveResults,
    diagnostics: { replacements: [...pass.replacementKinds].map(([messageIndex, kind]) => ({ messageIndex, kind })) },
  };
}

export function sieveMessages<T extends ContextMessage>(
  messages: readonly T[],
  threshold = SIEVE_THRESHOLD,
  options: SieveOptions = {},
): TransformResult<T> {
  const { diagnostics: _diagnostics, ...result } = standardSieveMessages(
    messages,
    threshold,
    options,
    LEGACY_AGE_POLICY,
  );
  return result;
}

export function standardV2SieveMessages<T extends ContextMessage>(
  messages: readonly T[],
  threshold = SIEVE_THRESHOLD,
  options: SieveOptions = {},
): StandardV2TransformResult<T> {
  return standardSieveMessages(messages, threshold, options, STANDARD_V2_AGE_POLICY);
}

export type ContinuityProjectionBoundary = { frozenToolCallIds: Set<string> };

/**
 * Finds the retained suffix owned by the latest active Continuity v3 compaction.
 * The session branch, not Sieve state, is the authority so reload is deterministic.
 */
export function continuityProjectionBoundary(entries: readonly unknown[]): ContinuityProjectionBoundary | undefined {
  let compactionIndex = -1;
  let compaction: Record<string, unknown> | undefined;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index] as Record<string, unknown> | undefined;
    if (entry?.type === "compaction") {
      compactionIndex = index;
      compaction = entry;
      break;
    }
  }
  if (compactionIndex < 0 || !compaction) return;
  const details = jsonObject(compaction.details);
  const firstKeptEntryId = compaction.firstKeptEntryId;
  if (
    details?.type !== "pi-continuity-compaction" ||
    details.version !== 3 ||
    typeof firstKeptEntryId !== "string" ||
    !firstKeptEntryId
  )
    return;
  const firstKeptIndex = entries.findIndex(
    entry => (entry as Record<string, unknown> | undefined)?.id === firstKeptEntryId,
  );
  if (firstKeptIndex < 0 || firstKeptIndex >= compactionIndex) return;
  const retained = entries.slice(firstKeptIndex, compactionIndex);
  const calls = new Map<string, Array<{ name: string; index: number }>>();
  const results = new Map<string, Array<{ name: string; index: number }>>();
  for (let index = 0; index < retained.length; index++) {
    const message = (retained[index] as Record<string, unknown> | undefined)?.message as
      Record<string, unknown> | undefined;
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        const call = jsonObject(block);
        if (call?.type === "toolCall" && typeof call.id === "string" && call.id && typeof call.name === "string")
          calls.set(call.id, [...(calls.get(call.id) ?? []), { name: call.name, index }]);
      }
    } else if (
      message?.role === "toolResult" &&
      typeof message.toolCallId === "string" &&
      message.toolCallId &&
      typeof message.toolName === "string"
    ) {
      results.set(message.toolCallId, [...(results.get(message.toolCallId) ?? []), { name: message.toolName, index }]);
    }
  }
  const frozenToolCallIds = new Set<string>();
  for (const [id, matchingCalls] of calls) {
    const matchingResults = results.get(id);
    if (
      matchingCalls.length === 1 &&
      matchingResults?.length === 1 &&
      matchingResults[0].index > matchingCalls[0].index &&
      matchingResults[0].name === matchingCalls[0].name
    )
      frozenToolCallIds.add(id);
  }
  return { frozenToolCallIds };
}

type ContinuityCall = { id: string; name: string; messageIndex: number; batchIndex: number };
type ContinuityBatch = { calls: ContinuityCall[]; valid: boolean };
export type ContinuityTransformResult<T extends ContextMessage> = TransformResult<T> & {
  preservedToolCallIds: Set<string>;
};

/**
 * Projects only proven old Continuity pairs. `baselineMessages` lets all runtime
 * modes apply this after their normal policy without touching raw input.
 */
export function continuitySieveMessages<T extends ContextMessage>(
  messages: readonly T[],
  frozenToolCallIds: ReadonlySet<string>,
  baselineMessages: readonly T[] = messages,
): ContinuityTransformResult<T> {
  const stats = emptyTransformStats();
  const empty = (): ContinuityTransformResult<T> => ({
    messages: [...messages],
    stats,
    recoverableActiveResults: [],
    preservedToolCallIds: new Set(),
  });
  if (baselineMessages.length !== messages.length) return empty();
  for (let index = 0; index < messages.length; index++) {
    const raw = messages[index] as Record<string, unknown>;
    const baseline = baselineMessages[index] as Record<string, unknown>;
    if (raw.role !== baseline.role) return empty();
    const rawMetadata = { ...raw },
      baselineMetadata = { ...baseline };
    delete rawMetadata.content;
    delete baselineMetadata.content;
    if (!isDeepStrictEqual(rawMetadata, baselineMetadata)) return empty();
    if (raw.role !== "assistant") continue;
    const callIdentity = (message: Record<string, unknown>) =>
      Array.isArray(message.content)
        ? message.content.flatMap(block => {
            const call = jsonObject(block);
            return call?.type === "toolCall" ? [{ id: call.id, name: call.name }] : [];
          })
        : [];
    if (!isDeepStrictEqual(callIdentity(raw), callIdentity(baseline))) return empty();
  }

  // Batches mirror one assistant turn, so a malformed call taints only its own turn.
  const calls: ContinuityCall[] = [];
  const batches: ContinuityBatch[] = [];
  const callCounts = new Map<string, number>();
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const fields = messages[messageIndex] as Record<string, unknown>;
    if (fields.role !== "assistant" || !Array.isArray(fields.content)) continue;
    const batch: ContinuityBatch = { calls: [], valid: true };
    for (const block of fields.content) {
      const call = jsonObject(block);
      if (call?.type !== "toolCall") continue;
      if (typeof call.id !== "string" || !call.id || typeof call.name !== "string") {
        batch.valid = false;
        continue;
      }
      const tracked = { id: call.id, name: call.name, messageIndex, batchIndex: batches.length };
      calls.push(tracked);
      batch.calls.push(tracked);
      callCounts.set(call.id, (callCounts.get(call.id) ?? 0) + 1);
    }
    if (batch.calls.length || !batch.valid) batches.push(batch);
  }
  const { results, resultCounts } = indexToolCalls(messages);
  const completed = (call: ContinuityCall) => {
    const result = results.get(call.id);
    return (
      callCounts.get(call.id) === 1 &&
      resultCounts.get(call.id) === 1 &&
      !!result &&
      result.messageIndex > call.messageIndex &&
      result.fields.toolName === call.name
    );
  };
  const batchComplete = (batch: ContinuityBatch) =>
    batch.valid &&
    batch.calls.length > 0 &&
    batch.calls.every(call => frozenToolCallIds.has(call.id) && completed(call));
  let newestCompletedBatch = -1;
  for (let index = 0; index < batches.length; index++) if (batchComplete(batches[index])) newestCompletedBatch = index;

  const output = [...baselineMessages];
  for (let index = 0; index < messages.length; index++)
    if (messages[index].role === "assistant") output[index] = messages[index];
  const preservedToolCallIds = new Set<string>();
  const preserve = (call: ContinuityCall) => {
    const result = results.get(call.id);
    if (completed(call) && result) output[result.messageIndex] = messages[result.messageIndex];
    preservedToolCallIds.add(call.id);
  };
  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index];
    if (
      !batch.calls.some(call => frozenToolCallIds.has(call.id)) ||
      (batchComplete(batch) && index !== newestCompletedBatch)
    )
      continue;
    for (const call of batch.calls) preserve(call);
  }
  const recoverableActiveResults: RecoverableActiveResult[] = [];
  for (const call of calls) {
    if (
      !frozenToolCallIds.has(call.id) ||
      call.batchIndex === newestCompletedBatch ||
      !batchComplete(batches[call.batchIndex]) ||
      !completed(call)
    )
      continue;
    const result = results.get(call.id)!;
    const fields = result.fields;
    const source = fields.isError === false ? sieveSource(fields as ContextMessage, false) : undefined;
    const supported = call.name === READ_TOOL_NAME || source?.toolName === call.name;
    const sourceChars = textOnlyContentLength(fields.content);
    const sourceBlocks = textOnlyBlocks(fields.content);
    if (!supported || !sourceChars || !sourceBlocks || sourceBlocks.length !== (fields.content as unknown[]).length) {
      preserve(call);
      continue;
    }
    if (
      sourceBlocks.length === 1 &&
      sourceBlocks[0].text.startsWith(`[pi-sieve: ${call.name}; `) &&
      sourceBlocks[0].text.endsWith(`; sieve_recall ${JSON.stringify(call.id)}]`)
    ) {
      preserve(call);
      continue;
    }
    const marker = continuityOmissionMarker(call.name, call.id, sourceChars);
    const baselineLength = contentCharacters((output[result.messageIndex] as Record<string, unknown>).content);
    if (marker.length >= sourceChars || marker.length >= baselineLength) {
      preserve(call);
      continue;
    }
    output[result.messageIndex] = replaceWithMarker(output[result.messageIndex], marker);
    stats.scanned++;
    stats.transformed++;
    // Reuse the existing bounded-output classification to retain telemetry compatibility.
    stats.transformedBy.budget++;
    stats.omittedChars += baselineLength - marker.length;
    stats.netCharsSaved += baselineLength - marker.length;
    const usage = stats.byTool[call.name] ?? emptyToolTransformStats();
    usage.scanned++;
    usage.transformed++;
    usage.sourceChars += baselineLength;
    usage.retainedChars += marker.length;
    usage.netCharsSaved += baselineLength - marker.length;
    stats.byTool[call.name] = usage;
    recoverableActiveResults.push({ toolCallId: call.id, toolName: call.name, isError: false });
  }
  return { messages: output, stats, recoverableActiveResults, preservedToolCallIds };
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
  if (Array.isArray(value)) return value.map(item => canonicalProjectionValue(item, seen));
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map(key => [key, canonicalProjectionValue((value as Record<string, unknown>)[key], seen)]),
  );
}

function projectionHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalProjectionValue(value)))
    .digest("hex");
}

function projectionSourceHashes<T extends ContextMessage>(
  messages: readonly T[],
  cwd = process.cwd(),
): Map<number, string> {
  const calls = new Map<string, unknown[]>();
  const hashes = new Map<number, string>();
  const resolvedCwd = resolve(cwd);
  for (let index = 0; index < messages.length; index++) {
    const fields = messages[index] as Record<string, unknown>;
    if (fields.role === "assistant" && Array.isArray(fields.content)) {
      for (const block of fields.content) {
        const call = jsonObject(block);
        if (call?.type !== "toolCall" || typeof call.id !== "string") continue;
        const matching = calls.get(call.id) ?? [];
        matching.push(call);
        calls.set(call.id, matching);
      }
      continue;
    }
    const toolCallId = typeof fields.toolCallId === "string" ? fields.toolCallId : "";
    if (fields.role === "toolResult") {
      hashes.set(index, projectionHash({ cwd: resolvedCwd, calls: calls.get(toolCallId) ?? [], result: fields }));
    }
  }
  return hashes;
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

type PreparedProjection<T extends ContextMessage> = { resultCount: number; duplicate?: DuplicateReplacement<T> };

/** Projects one newly observed raw result using only history at or before it. */
function projectNewResultPrepared<T extends ContextMessage>(
  messages: readonly T[],
  resultIndex: number,
  threshold: number,
  options: SieveOptions,
  prepared?: PreparedProjection<T>,
): NewProjection<T> {
  const message = messages[resultIndex];
  const unchanged = (budgetEligible = false, retainedSourceChars = 0): NewProjection<T> => ({
    message,
    recoverable: false,
    budgetEligible,
    retainedSourceChars,
  });
  const fields = message as Record<string, unknown>;
  if (fields?.role !== "toolResult") return unchanged();
  const cwd = options.cwd ?? process.cwd();
  const toolCallId = fields.toolCallId;
  if (typeof toolCallId !== "string" || !toolCallId) return unchanged();
  const prefix = prepared ? undefined : messages.slice(0, resultIndex + 1);
  const resultCount =
    prepared?.resultCount ??
    prefix!.reduce((count, candidate) => {
      const value = candidate as Record<string, unknown>;
      return count + (value.role === "toolResult" && value.toolCallId === toolCallId ? 1 : 0);
    }, 0);
  if (resultCount !== 1) return unchanged();
  const duplicate = prepared
    ? prepared.duplicate
    : exactDuplicateReplacements(prefix!, cwd, new Map(), options.pruneActive === true).find(
        replacement => replacement.messageIndex === resultIndex,
      );
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
    const sliced = sliceRankedSearch(blocks, source, cap, { maxRetainedChars: retainedCap, toolCallId });
    const outbound = sliced?.outboundText ?? structuredMarker(source, sourceLength, toolCallId);
    return outbound.length < sourceLength
      ? {
          message: replaceWithMarker(message, outbound),
          recoverable: true,
          budgetEligible: true,
          retainedSourceChars: sliced?.retainedChars ?? 0,
          projectionKind,
        }
      : unchanged();
  }
  if (source.kind === "relationshipGraph" && !source.isError) {
    const sliced = sliceRelationshipGraph(blocks, source, cap, { maxRetainedChars: retainedCap, toolCallId });
    const outbound = sliced?.outboundText ?? structuredMarker(source, sourceLength, toolCallId);
    return outbound.length < sourceLength
      ? {
          message: replaceWithMarker(message, outbound),
          recoverable: true,
          budgetEligible: true,
          retainedSourceChars: sliced?.retainedChars ?? 0,
          projectionKind,
        }
      : unchanged();
  }
  const sliced = sliceActiveResult(blocks, source, toolCallId, cap, retainedCap);
  const outbound =
    sliced?.outboundText ?? activeOmissionMarker(source.toolName, toolCallId, sourceLength, sourceLength);
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

export function projectNewResult<T extends ContextMessage>(
  messages: readonly T[],
  resultIndex: number,
  threshold = SIEVE_THRESHOLD,
  options: SieveOptions = {},
): NewProjection<T> {
  return projectNewResultPrepared(messages, resultIndex, threshold, options);
}

function contentCharacters(content: unknown): number {
  return textOnlyContentLength(content) ?? mixedContentBlocks(content)?.sourceChars ?? serializedContentLength(content);
}

function projectionEntry<T extends ContextMessage>(
  messages: readonly T[],
  index: number,
  decision: NewProjection<T>,
  cwd?: string,
  knownSourceHash?: string,
): ProjectionEntry {
  const fields = messages[index] as Record<string, unknown>;
  const projectedMessage = cloneProjectionValue(decision.message);
  const projectedFields = projectedMessage as Record<string, unknown>;
  return {
    toolCallId: fields.toolCallId as string,
    sourceHash: knownSourceHash ?? projectionSourceHash(messages, index, cwd),
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
  const usage = stats.byTool[key] ?? emptyToolTransformStats();
  usage.scanned++;
  usage.sourceChars += entry.sourceChars;
  usage.retainedChars += entry.retainedChars;
  if (entry.transformed) usage.transformed++;
  usage.netCharsSaved += Math.max(0, entry.sourceChars - entry.retainedChars);
  stats.byTool[key] = usage;
}

/** Serialized size of everything from `index` onward, i.e. the prefix a reflow invalidates. */
function invalidatedCharsFrom<T extends ContextMessage>(messages: readonly T[], index: number): number {
  let total = 0;
  for (let position = index; position < messages.length; position++)
    total += serializedContentLength(messages[position]);
  return total;
}

// TODO(pi-sieve): compare restored legacy and rollover epochs across more retained real sessions before choosing a long-term default.
/** Applies an immutable epoch ledger to an outbound-only raw context copy. */
export function stableSieveMessages<T extends ContextMessage>(
  messages: readonly T[],
  epoch: ProjectionEpoch,
  options: SieveOptions = {},
): StableTransformResult<T> {
  const threshold = epoch.config.threshold;
  const counts = toolResultCounts(messages);

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
  const rawMessageHashes = messages.map(message => projectionHash(message));
  const sourceHashes = projectionSourceHashes(messages, options.cwd);
  /** Records that the epoch can no longer be trusted from `index` onward. */
  const markReflow = (kind: "ambiguousReflows" | "sourceMismatches" | "historyMismatches", index: number) => {
    diagnostics[kind]++;
    diagnostics.requiresReflow = true;
    diagnostics.earliestChangedMessageIndex = index;
    diagnostics.estimatedInvalidatedChars = invalidatedCharsFrom(messages, index);
    return { messages: output, stats, recoverableActiveResults, diagnostics };
  };

  for (let index = 0; index < messages.length; index++) {
    const fields = messages[index] as Record<string, unknown>;
    const toolCallId = fields.toolCallId;
    if (fields.role !== "toolResult" || typeof toolCallId !== "string" || !toolCallId) continue;
    const existing = epoch.entries.get(toolCallId);
    if (!existing) continue;
    if (counts.get(toolCallId)! > 1 && existing.transformed) return markReflow("ambiguousReflows", index);
    if (counts.get(toolCallId) === 1 && existing.sourceHash !== sourceHashes.get(index))
      return markReflow("sourceMismatches", index);
  }

  const historicalLength = epoch.rawMessageHashes.length;
  const changedIndex = rawMessageHashes
    .slice(0, historicalLength)
    .findIndex((hash, index) => hash !== epoch.rawMessageHashes[index]);
  if (changedIndex >= 0) return markReflow("historyMismatches", changedIndex);
  if (rawMessageHashes.length < historicalLength) return markReflow("historyMismatches", rawMessageHashes.length);

  const usedIds = new Set<string>();
  let duplicateReplacements: Map<number, DuplicateReplacement<T>> | undefined;
  for (let index = 0; index < messages.length; index++) {
    const raw = messages[index];
    const fields = raw as Record<string, unknown>;
    if (fields.role !== "toolResult") continue;
    const toolCallId = fields.toolCallId;
    if (typeof toolCallId !== "string" || !toolCallId) {
      diagnostics.ambiguousIds++;
      continue;
    }
    const sourceHash = sourceHashes.get(index)!;
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
        diagnostics.estimatedInvalidatedChars += invalidatedCharsFrom(messages, index);
        continue;
      }
      output[index] = cloneProjectionValue(existing.projectedMessage) as T;
      diagnostics.cacheHits++;
      recordProjectionStats(stats, existing);
      if (existing.recoverable && !epoch.taintedIds.has(toolCallId))
        recoverableActiveResults.push({ toolCallId, toolName: existing.toolName, isError: existing.isError });
      continue;
    }

    duplicateReplacements ??= new Map(
      exactDuplicateReplacements(messages, options.cwd ?? process.cwd(), new Map(), epoch.config.activePruning).map(
        replacement => [replacement.messageIndex, replacement],
      ),
    );
    const decision = projectNewResultPrepared(
      messages,
      index,
      threshold,
      { pruneActive: epoch.config.activePruning, cwd: options.cwd },
      { resultCount: counts.get(toolCallId)!, duplicate: duplicateReplacements.get(index) },
    );
    const entry = projectionEntry(messages, index, decision, options.cwd, sourceHash);
    epoch.entries.set(toolCallId, entry);
    output[index] = cloneProjectionValue(entry.projectedMessage) as T;
    diagnostics.newProjections++;
    recordProjectionStats(stats, entry);
    if (entry.recoverable)
      recoverableActiveResults.push({ toolCallId, toolName: entry.toolName, isError: entry.isError });
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
  const counts = toolResultCounts(messages);

  const duplicateReplacements = new Map(
    exactDuplicateReplacements(messages, options.cwd ?? process.cwd(), new Map(), epoch.config.activePruning).map(
      replacement => [replacement.messageIndex, replacement],
    ),
  );
  const sourceHashes = projectionSourceHashes(messages, options.cwd);
  let remaining = Math.max(0, retainedSourceTarget);
  let seeded = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const fields = messages[index] as Record<string, unknown>;
    const toolCallId = fields.toolCallId;
    if (fields.role !== "toolResult" || typeof toolCallId !== "string" || !toolCallId || counts.get(toolCallId) !== 1)
      continue;
    const decision = projectNewResultPrepared(
      messages,
      index,
      epoch.config.threshold,
      { pruneActive: epoch.config.activePruning, cwd: options.cwd, retainedSourceCap: remaining },
      { resultCount: counts.get(toolCallId)!, duplicate: duplicateReplacements.get(index) },
    );
    const entry = projectionEntry(messages, index, decision, options.cwd, sourceHashes.get(index));
    epoch.entries.set(toolCallId, entry);
    if (entry.budgetEligible) remaining = Math.max(0, remaining - entry.retainedSourceChars);
    seeded++;
  }

  const result = stableSieveMessages(messages, epoch, options);
  result.diagnostics.newProjections = seeded;
  result.diagnostics.cacheHits = Math.max(0, result.diagnostics.cacheHits - seeded);
  return result;
}
