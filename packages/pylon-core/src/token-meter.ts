const CHARS_PER_ESTIMATED_TOKEN = 4;

export interface ToolUsage {
  calls: number;
  argumentChars: number;
  resultChars: number;
  images: number;
  errors: number;
}

export interface ProviderUsage {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TokenMeter {
  byTool: Map<string, ToolUsage>;
  seenCallIds: Set<string>;
  provider: ProviderUsage;
}

interface ContentPart {
  type?: string;
  text?: string;
}

interface ToolResultLike {
  toolCallId: string;
  toolName: string;
  input?: Record<string, unknown>;
  content: ContentPart[];
  isError: boolean;
}

export function createTokenMeter(): TokenMeter {
  return {
    byTool: new Map(),
    seenCallIds: new Set(),
    provider: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function serializedLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value).length;
  }
}

export function recordToolResult(meter: TokenMeter, result: ToolResultLike): void {
  if (meter.seenCallIds.has(result.toolCallId)) return;
  meter.seenCallIds.add(result.toolCallId);
  const usage = meter.byTool.get(result.toolName) ?? {
    calls: 0,
    argumentChars: 0,
    resultChars: 0,
    images: 0,
    errors: 0,
  };
  usage.calls++;
  usage.argumentChars += serializedLength(result.input ?? {});
  usage.resultChars += result.content.reduce(
    (sum, part) => sum + (part.type === "text" && typeof part.text === "string" ? part.text.length : 0),
    0,
  );
  usage.images += result.content.filter((part) => part.type === "image").length;
  if (result.isError) usage.errors++;
  meter.byTool.set(result.toolName, usage);
}

export function meterFromBranch(entries: readonly any[]): TokenMeter {
  const meter = createTokenMeter();
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  for (const entry of entries) {
    const message = entry?.type === "message" ? entry.message : undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    if (message.usage && typeof message.usage === "object") {
      meter.provider.turns++;
      meter.provider.input += Number(message.usage.input) || 0;
      meter.provider.output += Number(message.usage.output) || 0;
      meter.provider.cacheRead += Number(message.usage.cacheRead) || 0;
      meter.provider.cacheWrite += Number(message.usage.cacheWrite) || 0;
    }
    for (const part of message.content) {
      if (part?.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string")
        calls.set(part.id, { name: part.name, input: part.arguments ?? {} });
    }
  }
  for (const entry of entries) {
    const message = entry?.type === "message" ? entry.message : undefined;
    if (message?.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
    const call = calls.get(message.toolCallId);
    recordToolResult(meter, {
      toolCallId: message.toolCallId,
      toolName: typeof message.toolName === "string" ? message.toolName : call?.name ?? "unknown",
      input: call?.input ?? {},
      content: Array.isArray(message.content) ? message.content : [],
      isError: message.isError === true,
    });
  }
  return meter;
}

export const estimatedTokens = (characters: number): number =>
  Math.ceil(characters / CHARS_PER_ESTIMATED_TOKEN);

export function formatTokenMeter(meter: TokenMeter): string {
  const rows = [...meter.byTool.entries()].sort((a, b) => {
    const aChars = a[1].argumentChars + a[1].resultChars;
    const bChars = b[1].argumentChars + b[1].resultChars;
    return bChars - aChars || a[0].localeCompare(b[0]);
  });
  let totalCalls = 0, totalInput = 0, totalOutput = 0, totalImages = 0, totalErrors = 0;
  const lines = rows.map(([name, usage]) => {
    totalCalls += usage.calls;
    totalInput += usage.resultChars;
    totalOutput += usage.argumentChars;
    totalImages += usage.images;
    totalErrors += usage.errors;
    return `${name}: ${usage.calls} call${usage.calls === 1 ? "" : "s"}; input ~${estimatedTokens(usage.resultChars)}; output ~${estimatedTokens(usage.argumentChars)}; total ~${estimatedTokens(usage.argumentChars + usage.resultChars)} tokens${usage.images ? `; images ${usage.images}` : ""}${usage.errors ? `; errors ${usage.errors}` : ""}`;
  });
  const provider = meter.provider;
  return [
    "Estimated model-direction tool payload tokens (input = text results, output = serialized arguments; ~4 characters/token):",
    ...(lines.length ? lines : ["No completed tool calls in current session branch."]),
    `Total: ${totalCalls} calls; input ~${estimatedTokens(totalInput)}; output ~${estimatedTokens(totalOutput)}; total ~${estimatedTokens(totalInput + totalOutput)} tokens; images ${totalImages}; errors ${totalErrors}`,
    "",
    "Provider-reported model usage (all assistant turns; not attributable to individual tools):",
    `${provider.turns} turns; input ${provider.input}; output ${provider.output}; cache read ${provider.cacheRead}; cache write ${provider.cacheWrite}`,
  ].join("\n");
}
