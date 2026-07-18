export const SIEVE_THRESHOLD = 8_000;
export const ELIGIBLE_TOOL_NAMES = ["bash", "grep", "find", "ls", "rg", "fd"] as const;
export const READ_TOOL_NAME = "read";
export const RECENT_WINDOW_POLICY =
  "Everything from the second-latest user message onward is preserved.";

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
  target.omittedChars += source.omittedChars;
  target.netCharsSaved += source.netCharsSaved;
  target.skipped.recentWindow += source.skipped.recentWindow;
  target.skipped.ineligibleTool += source.skipped.ineligibleTool;
  target.skipped.error += source.skipped.error;
  target.skipped.nonTextMixedOrEmptyContent += source.skipped.nonTextMixedOrEmptyContent;
  target.skipped.atOrBelowThreshold += source.skipped.atOrBelowThreshold;
  return target;
}

export function omissionMarker(toolName: string, omittedChars: number) {
  return `[Output from tool "${toolName}" was omitted by pi-sieve (${omittedChars} characters).]`;
}

export function textOnlyContentLength(content: unknown): number | undefined {
  if (!Array.isArray(content) || !content.length) return undefined;
  let length = 0;
  for (const block of content) {
    if (
      !block ||
      typeof block !== "object" ||
      (block as { type?: unknown }).type !== "text" ||
      typeof (block as { text?: unknown }).text !== "string"
    )
      return undefined;
    length += (block as TextBlock).text.length;
  }
  return length;
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
  const stats = emptyTransformStats();

  const outbound = messages.map((message, index) => {
    if (message.role !== "toolResult") return message;
    if (cutoff === undefined || index >= cutoff) {
      stats.skipped.recentWindow++;
      return message;
    }

    stats.scanned++;
    if (!isEligibleTool(message)) {
      stats.skipped.ineligibleTool++;
      return message;
    }
    if ((message as { isError?: unknown }).isError === true) {
      stats.skipped.error++;
      return message;
    }

    const omittedChars = textOnlyContentLength(message.content);
    if (omittedChars === undefined) {
      stats.skipped.nonTextMixedOrEmptyContent++;
      return message;
    }
    if (omittedChars <= threshold) {
      stats.skipped.atOrBelowThreshold++;
      return message;
    }

    const marker = omissionMarker(message.toolName, omittedChars);
    stats.transformed++;
    stats.omittedChars += omittedChars;
    stats.netCharsSaved += Math.max(0, omittedChars - marker.length);
    return {
      ...message,
      content: [{ type: "text", text: marker }],
    } as T;
  });

  return { messages: outbound, stats };
}
