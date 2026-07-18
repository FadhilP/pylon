export const SIEVE_THRESHOLD = 8_000;
export const ELIGIBLE_TOOL_NAMES = ["bash", "grep", "find", "ls", "rg", "fd"] as const;
export const READ_TOOL_NAME = "read";
export const RECENT_WINDOW_POLICY =
  "Age 0 is preserved; successful eligible age-1 output is capped at three times the threshold.";
export const GIANT_ERROR_TAIL_CHARS = 2_000;

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
};

export type TransformStats = {
  /** Old tool results inspected by the sieve. */
  scanned: number;
  /** Results that qualify for replacement (or projection in observe mode). */
  transformed: number;
  /** Classification of transformations. */
  transformedBy: {
    ageThreshold: number;
    budget: number;
    giantError: number;
  };
  /** Source text characters omitted (or projected to be omitted). */
  omittedChars: number;
  /** Omitted text characters less the replacement marker characters. */
  netCharsSaved: number;
  skipped: SkipStats;
};

export type TransformResult<T extends ContextMessage> = {
  messages: T[];
  stats: TransformStats;
};

const eligibleTools = new Set<string>(ELIGIBLE_TOOL_NAMES);

export function emptyTransformStats(): TransformStats {
  return {
    scanned: 0,
    transformed: 0,
    transformedBy: { ageThreshold: 0, budget: 0, giantError: 0 },
    omittedChars: 0,
    netCharsSaved: 0,
    skipped: {
      recentWindow: 0,
      ineligibleTool: 0,
      error: 0,
      nonTextMixedOrEmptyContent: 0,
      atOrBelowThreshold: 0,
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
  target.omittedChars += source.omittedChars;
  target.netCharsSaved += source.netCharsSaved;
  target.skipped.recentWindow += source.skipped.recentWindow;
  target.skipped.ineligibleTool += source.skipped.ineligibleTool;
  target.skipped.error += source.skipped.error;
  target.skipped.nonTextMixedOrEmptyContent += source.skipped.nonTextMixedOrEmptyContent;
  target.skipped.atOrBelowThreshold += source.skipped.atOrBelowThreshold;
  return target;
}

export function omissionMarker(toolName: string, sourceChars: number) {
  return `[pi-sieve: ${toolName} ${sourceChars} chars omitted]`;
}

export function giantErrorMarker(toolName: string, sourceChars: number) {
  return `[pi-sieve: ${toolName} error ${sourceChars} chars truncated]\n`;
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

function isEligibleTool(message: ContextMessage): message is ContextMessage & {
  role: "toolResult";
  toolName: string;
  content: unknown;
  isError?: unknown;
} {
  const fields = message as Record<string, unknown>;
  return typeof fields.toolName === "string" &&
    eligibleTools.has(fields.toolName) &&
    fields.toolName !== READ_TOOL_NAME;
}

function replaceWithMarker<T extends ContextMessage>(message: T, marker: string): T {
  return { ...message, content: [{ type: "text", text: marker }] } as T;
}

/**
 * Creates an outbound-only context view. The supplied session messages and all
 * ineligible message objects remain untouched. The optional threshold keeps
 * existing callers on the default while allowing runtime configuration.
 */
export function sieveMessages<T extends ContextMessage>(
  messages: readonly T[],
  threshold = SIEVE_THRESHOLD,
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
  const retainedBudget = 3 * threshold;
  let retainedChars = 0;

  // Budget selection is deliberately newest-to-oldest, unlike outbound order.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "toolResult") continue;
    const age = usersAfter[index];
    if (cutoff === undefined || age === 0) {
      stats.skipped.recentWindow++;
      continue;
    }

    stats.scanned++;
    if (!isEligibleTool(message)) {
      stats.skipped.ineligibleTool++;
      continue;
    }

    const sourceLength = textOnlyContentLength(message.content);
    if ((message as { isError?: unknown }).isError === true) {
      const giantThreshold = Math.max(32_000, 4 * threshold);
      if (age > 1 && sourceLength !== undefined && sourceLength > giantThreshold) {
        const marker = giantErrorMarker(message.toolName, sourceLength);
        const tail = textOnlyContentTail(message.content, GIANT_ERROR_TAIL_CHARS)!;
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

    const effectiveThreshold = age === 1 ? 3 * threshold : effectiveThresholdForAge(age, threshold);
    if (sourceLength > effectiveThreshold) {
      const marker = omissionMarker(message.toolName, sourceLength);
      replacements.set(index, replaceWithMarker(message, marker));
      stats.transformed++;
      stats.transformedBy.ageThreshold++;
      stats.omittedChars += sourceLength;
      stats.netCharsSaved += Math.max(0, sourceLength - marker.length);
      continue;
    }

    if (age === 1) {
      stats.skipped.atOrBelowThreshold++;
      continue;
    }

    if (retainedChars + sourceLength > retainedBudget) {
      const marker = omissionMarker(message.toolName, sourceLength);
      replacements.set(index, replaceWithMarker(message, marker));
      stats.transformed++;
      stats.transformedBy.budget++;
      stats.omittedChars += sourceLength;
      stats.netCharsSaved += Math.max(0, sourceLength - marker.length);
      continue;
    }

    retainedChars += sourceLength;
    stats.skipped.atOrBelowThreshold++;
  }

  return {
    messages: messages.map((message, index) => replacements.get(index) ?? message),
    stats,
  };
}
