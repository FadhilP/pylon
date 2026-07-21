import { createHash } from "node:crypto";

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
  cost: number;
}

export interface PackageUsage extends ProviderUsage {
  calls: number;
  failures: number;
  retries: number;
  repeatedCalls: number;
  durationMs: number;
}

export interface ContextUsage {
  records: number;
  characters: number;
  hashes: Set<string>;
}

export interface QualityUsage {
  sieveRecalls: number;
  sieveRecalledChars: number;
  verification: Map<string, number>;
}

export interface TokenMeter {
  byTool: Map<string, ToolUsage>;
  seenCallIds: Set<string>;
  provider: ProviderUsage;
  byPackage: Map<string, PackageUsage>;
  byContext: Map<string, ContextUsage>;
  seenContextHashes: Map<string, Set<string>>;
  seenTelemetryIds: Set<string>;
  seenVerificationIds: Set<string>;
  quality: QualityUsage;
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
  details?: any;
}

export type TelemetryEvent = {
  version: 1;
  eventId: string;
  package: "pi-timeline";
  kind: "model_call";
  status: "completed" | "failed";
  durationMs: number;
  usage: ProviderUsage;
  context: Record<string, { characters: number; hash: string }>;
};

const emptyProviderUsage = (): ProviderUsage => ({
  turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
});
const emptyPackageUsage = (): PackageUsage => ({
  ...emptyProviderUsage(), calls: 0, failures: 0, retries: 0, repeatedCalls: 0, durationMs: 0,
});

export function createTokenMeter(): TokenMeter {
  return {
    byTool: new Map(),
    seenCallIds: new Set(),
    provider: emptyProviderUsage(),
    byPackage: new Map(),
    byContext: new Map(),
    seenContextHashes: new Map(),
    seenTelemetryIds: new Set(),
    seenVerificationIds: new Set(),
    quality: { sieveRecalls: 0, sieveRecalledChars: 0, verification: new Map() },
  };
}

function serialized(value: unknown): string {
  try { return JSON.stringify(value) ?? ""; }
  catch { return String(value); }
}
const serializedLength = (value: unknown): number => serialized(value).length;
const hash = (value: unknown): string => createHash("sha256").update(serialized(value)).digest("hex");
const finite = (value: unknown): number => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
};
const usageFrom = (value: any, turns = 1): ProviderUsage => ({
  turns: finite(turns),
  input: finite(value?.input),
  output: finite(value?.output),
  cacheRead: finite(value?.cacheRead),
  cacheWrite: finite(value?.cacheWrite),
  cost: finite(value?.cost?.total ?? value?.cost),
});

function recordContext(meter: TokenMeter, packageName: string, section: string, value: unknown): void {
  if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) return;
  const key = `${packageName}/${section}`;
  const current = meter.byContext.get(key) ?? { records: 0, characters: 0, hashes: new Set<string>() };
  const digest = hash(value);
  current.records++;
  current.characters += serializedLength(value);
  current.hashes.add(digest);
  meter.byContext.set(key, current);
}

function recordPackage(
  meter: TokenMeter,
  packageName: string,
  usage: ProviderUsage,
  options: { failed?: boolean; retry?: boolean; durationMs?: number; context?: Record<string, unknown> } = {},
): void {
  const current = meter.byPackage.get(packageName) ?? emptyPackageUsage();
  current.calls++;
  current.turns += usage.turns;
  current.input += usage.input;
  current.output += usage.output;
  current.cacheRead += usage.cacheRead;
  current.cacheWrite += usage.cacheWrite;
  current.cost += usage.cost;
  current.durationMs += finite(options.durationMs);
  if (options.failed) current.failures++;
  if (options.retry) current.retries++;
  const context = Object.fromEntries(Object.entries(options.context ?? {}).filter(([, value]) => value !== undefined && value !== null && value !== "" && (!Array.isArray(value) || value.length)));
  if (Object.keys(context).length) {
    const callHash = hash(Object.entries(context).sort(([a], [b]) => a.localeCompare(b)));
    const seen = meter.seenContextHashes.get(packageName) ?? new Set<string>();
    if (seen.has(callHash)) current.repeatedCalls++;
    seen.add(callHash);
    meter.seenContextHashes.set(packageName, seen);
  }
  for (const [section, value] of Object.entries(context)) recordContext(meter, packageName, section, value);
  meter.byPackage.set(packageName, current);
}

const MODEL_TOOLS: Record<string, { packageName: string; context: string[] }> = {
  advisor: { packageName: "pi-advisor", context: ["request", "evidence"] },
  grunt: { packageName: "pi-grunt", context: ["task", "targetedContext", "suggestedPaths", "checkCommands"] },
  repo_scout: { packageName: "pi-scout", context: ["task", "retryReason"] },
  web_scout: { packageName: "pi-scout", context: ["task", "startUrls"] },
};

function recordDerivedTelemetry(meter: TokenMeter, result: ToolResultLike): void {
  const details = result.details ?? {};
  if (result.toolName === "sieve_recall" && details.found === true) {
    meter.quality.sieveRecalls++;
    meter.quality.sieveRecalledChars += result.content.reduce((sum, part) => sum + (part.type === "text" ? part.text?.length ?? 0 : 0), 0);
    return;
  }
  const modelTool = MODEL_TOOLS[result.toolName];
  if (!modelTool || !details.usage || typeof details.usage !== "object") return;
  const turns = Array.isArray(details.turns) ? details.turns.length : finite(details.turns) || 1;
  const status = String(details.status ?? details.failureCode ?? "completed");
  const context = Object.fromEntries(modelTool.context.map((key) => [key, result.input?.[key]]));
  recordPackage(meter, modelTool.packageName, usageFrom(details.usage, turns), {
    failed: result.isError || !["completed", "passed"].includes(status),
    retry: Boolean(result.input?.retryReason),
    durationMs: details.durationMs,
    context,
  });
}

export function recordToolResult(meter: TokenMeter, result: ToolResultLike): void {
  if (meter.seenCallIds.has(result.toolCallId)) return;
  meter.seenCallIds.add(result.toolCallId);
  const usage = meter.byTool.get(result.toolName) ?? {
    calls: 0, argumentChars: 0, resultChars: 0, images: 0, errors: 0,
  };
  usage.calls++;
  usage.argumentChars += serializedLength(result.input ?? {});
  usage.resultChars += result.content.reduce(
    (sum, part) => sum + (part.type === "text" && typeof part.text === "string" ? part.text.length : 0), 0,
  );
  usage.images += result.content.filter((part) => part.type === "image").length;
  if (result.isError) usage.errors++;
  meter.byTool.set(result.toolName, usage);
  recordDerivedTelemetry(meter, result);
}

export function parseTelemetryEvent(value: unknown): TelemetryEvent | undefined {
  const event = value as any;
  if (!event || Object.keys(event).sort().join(",") !== "context,durationMs,eventId,kind,package,status,usage,version") return;
  if (event.version !== 1 || event.package !== "pi-timeline" || event.kind !== "model_call") return;
  if (typeof event.eventId !== "string" || !/^[a-zA-Z0-9:_-]{1,128}$/.test(event.eventId)) return;
  if (!["completed", "failed"].includes(event.status) || !Number.isSafeInteger(event.durationMs) || event.durationMs < 0 || event.durationMs > 86_400_000) return;
  if (!event.usage || Object.keys(event.usage).sort().join(",") !== "cacheRead,cacheWrite,cost,input,output,turns") return;
  for (const key of ["turns", "input", "output", "cacheRead", "cacheWrite"])
    if (!Number.isSafeInteger(event.usage[key]) || event.usage[key] < 0) return;
  if (typeof event.usage.cost !== "number" || !Number.isFinite(event.usage.cost) || event.usage.cost < 0 || event.usage.cost > 1_000_000) return;
  if (!event.context || Object.keys(event.context).sort().join(",") !== "request,result") return;
  const context: Record<string, { characters: number; hash: string }> = {};
  for (const [key, item] of Object.entries(event.context as Record<string, any>)) {
    if (!item || Object.keys(item).sort().join(",") !== "characters,hash" || !Number.isSafeInteger(item.characters) || item.characters < 0 || item.characters > 10_000_000 || !/^[a-f0-9]{64}$/.test(item.hash)) return;
    context[key] = { characters: item.characters, hash: item.hash };
  }
  return { version: 1, eventId: event.eventId, package: "pi-timeline", kind: "model_call", status: event.status, durationMs: event.durationMs, usage: event.usage, context };
}

export function recordTelemetryEvent(meter: TokenMeter, value: unknown): TelemetryEvent | undefined {
  const event = parseTelemetryEvent(value);
  if (!event || meter.seenTelemetryIds.has(event.eventId)) return;
  meter.seenTelemetryIds.add(event.eventId);
  const current = meter.byPackage.get(event.package) ?? emptyPackageUsage();
  current.calls++;
  current.turns += event.usage.turns;
  current.input += event.usage.input;
  current.output += event.usage.output;
  current.cacheRead += event.usage.cacheRead;
  current.cacheWrite += event.usage.cacheWrite;
  current.cost += event.usage.cost;
  current.durationMs += event.durationMs;
  if (event.status === "failed") current.failures++;
  meter.byPackage.set(event.package, current);
  for (const [section, item] of Object.entries(event.context)) {
    const key = `${event.package}/${section}`;
    const context = meter.byContext.get(key) ?? { records: 0, characters: 0, hashes: new Set<string>() };
    context.records++;
    context.characters += item.characters;
    context.hashes.add(item.hash);
    meter.byContext.set(key, context);
  }
  return event;
}

export function recordVerificationOutcome(meter: TokenMeter, value: any): void {
  if (value?.version !== 1 || typeof value.runId !== "string" || !value.runId || meter.seenVerificationIds.has(value.runId) || typeof value.state !== "string" || !/^[a-z-]{2,32}$/.test(value.state)) return;
  meter.seenVerificationIds.add(value.runId);
  meter.quality.verification.set(value.state, (meter.quality.verification.get(value.state) ?? 0) + 1);
}

export function meterFromBranch(entries: readonly any[]): TokenMeter {
  const meter = createTokenMeter();
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  for (const entry of entries) {
    if (entry?.type === "custom" && entry.customType === "pylon-telemetry") recordTelemetryEvent(meter, entry.data);
    if (entry?.type === "custom" && entry.customType === "pi-verify-result") recordVerificationOutcome(meter, entry.data);
    const message = entry?.type === "message" ? entry.message : undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    if (message.usage && typeof message.usage === "object") {
      const usage = usageFrom(message.usage);
      meter.provider.turns += usage.turns;
      meter.provider.input += usage.input;
      meter.provider.output += usage.output;
      meter.provider.cacheRead += usage.cacheRead;
      meter.provider.cacheWrite += usage.cacheWrite;
      meter.provider.cost += usage.cost;
    }
    for (const part of message.content)
      if (part?.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string")
        calls.set(part.id, { name: part.name, input: part.arguments ?? {} });
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
      details: message.details,
    });
  }
  return meter;
}

export const estimatedTokens = (characters: number): number => Math.ceil(characters / CHARS_PER_ESTIMATED_TOKEN);

export function formatTokenMeter(meter: TokenMeter): string {
  const rows = [...meter.byTool.entries()].sort((a, b) => b[1].argumentChars + b[1].resultChars - a[1].argumentChars - a[1].resultChars || a[0].localeCompare(b[0]));
  let totalCalls = 0, totalInput = 0, totalOutput = 0, totalImages = 0, totalErrors = 0;
  const lines = rows.map(([name, usage]) => {
    totalCalls += usage.calls; totalInput += usage.resultChars; totalOutput += usage.argumentChars; totalImages += usage.images; totalErrors += usage.errors;
    return `${name}: ${usage.calls} call${usage.calls === 1 ? "" : "s"}; input ~${estimatedTokens(usage.resultChars)}; output ~${estimatedTokens(usage.argumentChars)}; total ~${estimatedTokens(usage.argumentChars + usage.resultChars)} tokens${usage.images ? `; images ${usage.images}` : ""}${usage.errors ? `; errors ${usage.errors}` : ""}`;
  });
  const packageLines = [...meter.byPackage.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, usage]) =>
    `${name}: ${usage.calls} calls; ${usage.turns} turns; input ${usage.input}; output ${usage.output}; cache read ${usage.cacheRead}; cache write ${usage.cacheWrite}; retries ${usage.retries}; repeats ${usage.repeatedCalls}; failures ${usage.failures}; cost $${usage.cost.toFixed(4)}`,
  );
  const contextLines = [...meter.byContext.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, usage]) =>
    `${name}: ${usage.records} records; ~${estimatedTokens(usage.characters)} tokens; ${usage.hashes.size} unique hashes`,
  );
  const childCost = [...meter.byPackage.values()].reduce((sum, usage) => sum + usage.cost, 0);
  const verification = [...meter.quality.verification.entries()].sort().map(([state, count]) => `${state} ${count}`).join(", ") || "none";
  const provider = meter.provider;
  return [
    "Estimated model-direction tool payload tokens (input = text results, output = serialized arguments; ~4 characters/token):",
    ...(lines.length ? lines : ["No completed tool calls in current session branch."]),
    `Total: ${totalCalls} calls; input ~${estimatedTokens(totalInput)}; output ~${estimatedTokens(totalOutput)}; total ~${estimatedTokens(totalInput + totalOutput)} tokens; images ${totalImages}; errors ${totalErrors}`,
    "",
    "Provider-reported model usage (main assistant):",
    `${provider.turns} turns; input ${provider.input}; output ${provider.output}; cache read ${provider.cacheRead}; cache write ${provider.cacheWrite}; cost $${provider.cost.toFixed(4)}`,
    "",
    "Package model usage:",
    ...(packageLines.length ? packageLines : ["none"]),
    "Context sections (counts and hashes only):",
    ...(contextLines.length ? contextLines : ["none"]),
    `Quality: sieve recalls ${meter.quality.sieveRecalls}; restored ~${estimatedTokens(meter.quality.sieveRecalledChars)} tokens; verification ${verification}`,
    `Total session model cost: $${(provider.cost + childCost).toFixed(4)}`,
  ].join("\n");
}
