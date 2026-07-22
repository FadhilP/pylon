export const SIEVE_THRESHOLD = 8_192;
export const PLAIN_ELIGIBLE_TOOL_NAMES = ["bash", "grep", "find", "ls", "rg", "fd"] as const;
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
  "Age 0 is preserved unless opt-in active pruning is enabled; successful eligible age-1 output is capped at the threshold with active pruning, or three times the threshold without it.";
export const GIANT_ERROR_TAIL_CHARS = 2_048;

export type SieveOptions = {
  pruneActive?: boolean;
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
    transformedBy: { ageThreshold: 0, budget: 0, giantError: 0, activeThreshold: 0 },
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
  if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return false;
  const nodeIds = new Set<string>();
  for (const node of parsed.nodes) {
    const value = jsonObject(node);
    if (!value || typeof value.id !== "string" || typeof value.kind !== "string" || nodeIds.has(value.id)) return false;
    nodeIds.add(value.id);
  }
  return parsed.edges.every((edge) => {
    const value = jsonObject(edge);
    return value !== undefined &&
      typeof value.from === "string" &&
      typeof value.to === "string" &&
      typeof value.type === "string" &&
      nodeIds.has(value.from) &&
      nodeIds.has(value.to);
  });
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
    const withoutMarker = JSON.stringify({ ...base, results: selected });
    const outboundText = JSON.stringify({
      ...base,
      results: selected,
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
  if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return undefined;
  const locations = parsed.nodes.filter((node) => jsonObject(node)?.kind === "location");
  const base = { ...parsed };
  delete base.nodes;
  delete base.edges;
  delete base.piSieve;

  for (let returned = locations.length; returned >= 0; returned--) {
    const selectedLocationIds = new Set(
      locations.slice(0, returned).map((node) => jsonObject(node)?.id).filter((id): id is string => typeof id === "string"),
    );
    const selectedEdges = parsed.edges.filter((edge) => {
      const value = jsonObject(edge);
      return value && (
        (value.type === "contains" && selectedLocationIds.has(String(value.to))) ||
        (value.type === "mentions" && selectedLocationIds.has(String(value.from)))
      );
    });
    const selectedNodeIds = new Set<string>();
    for (const edge of selectedEdges) {
      const value = jsonObject(edge)!;
      selectedNodeIds.add(String(value.from));
      selectedNodeIds.add(String(value.to));
    }
    const selectedNodes = parsed.nodes.filter((node) => {
      const value = jsonObject(node);
      return typeof value?.id === "string" && selectedNodeIds.has(value.id);
    });
    const originalMetadata = jsonObject(parsed.metadata) ?? {};
    const graph = {
      ...base,
      nodes: selectedNodes,
      edges: selectedEdges,
      metadata: {
        ...originalMetadata,
        returnedCount: returned,
        truncated: originalMetadata.truncated === true || returned < locations.length,
      },
    };
    const withoutMarker = JSON.stringify(graph);
    const outboundText = JSON.stringify({
      ...graph,
      piSieve: structuredPruneMetadata(source, text.length, "omittedLocations", locations.length - returned),
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
  const replacements = new Map<number, T>();
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
    if (message.role !== "toolResult") continue;
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
