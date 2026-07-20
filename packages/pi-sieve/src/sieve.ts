export const SIEVE_THRESHOLD = 8_192;
export const ELIGIBLE_TOOL_NAMES = ["bash", "grep", "find", "ls", "rg", "fd"] as const;
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

type SieveSource = { toolName: string; isError: boolean; recalled: boolean };

function sieveSource(message: ContextMessage, allowRecall: boolean): SieveSource | undefined {
  const fields = message as Record<string, unknown>;
  if (fields.role !== "toolResult" || typeof fields.toolName !== "string") return undefined;
  if (eligibleTools.has(fields.toolName)) {
    return { toolName: fields.toolName, isError: fields.isError === true, recalled: false };
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
  return { toolName: recall.sourceToolName, isError: recall.sourceIsError, recalled: true };
}

function replaceWithMarker<T extends ContextMessage>(message: T, marker: string): T {
  return { ...message, content: [{ type: "text", text: marker }] } as T;
}

type ActiveSlice = { outboundText: string; omittedText: string };
type OldSuccessSlice = ActiveSlice & { retainedChars: number };

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
      if (sourceLength <= threshold) {
        stats.skipped.atOrBelowThreshold++;
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

    const effectiveThreshold = age === 1
      ? (options.pruneActive ? threshold : 3 * threshold)
      : effectiveThresholdForAge(age, threshold);
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
    const blocks = textOnlyBlocks((message as Record<string, unknown>).content)!;
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
