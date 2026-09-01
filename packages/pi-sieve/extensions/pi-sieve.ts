import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TProperties, type TSchema } from "typebox";
import { Check } from "typebox/value";
import {
  MAX_ROLLOVER_MULTIPLIER,
  MAX_SIEVE_THRESHOLD,
  MIN_ROLLOVER_MULTIPLIER,
  MIN_SIEVE_THRESHOLD,
  configPath,
  configuredActivePruning,
  configuredProjectionMode,
  configuredRolloverHighMultiplier,
  configuredRolloverLowMultiplier,
  configuredThreshold,
  defaultConfig,
  loadConfig,
  saveConfig,
  type ProjectionMode,
  type SieveConfig,
} from "../src/config.ts";
import {
  DEFAULT_ROLLOVER_HIGH_MULTIPLIER,
  DEFAULT_ROLLOVER_LOW_MULTIPLIER,
  ELIGIBLE_TOOL_NAMES,
  PROJECTION_POLICY_VERSION,
  READ_TOOL_NAME,
  RECALL_TOOL_NAME,
  RECENT_WINDOW_POLICY,
  SIEVE_THRESHOLD,
  addTransformStats,
  continuityProjectionBoundary,
  continuitySieveMessages,
  createProjectionEpoch,
  emptyTransformStats,
  projectionSourceHash,
  retainedProjectionBudget,
  rolloverStableSieveMessages,
  sieveMessages,
  stableSieveMessages,
  standardV2SieveMessages,
  type EpochReason,
  type ProjectionDiagnostics,
  type ProjectionEpoch,
  type RecoverableActiveResult,
  type StandardProjectionDiagnostics,
  type StandardProjectionKind,
  type TransformStats,
} from "../src/sieve.ts";

type SieveMode = "enabled" | "observe" | "disabled";

type RawRecoverableResult = RecoverableActiveResult & { sourceHash: string; message: any };

const STANDARD_CHURN_KINDS = [
  "activeThreshold",
  "ageThreshold",
  "budget",
  "staleRead",
  "duplicate",
  "errorCap",
  "history",
] as const;
type StandardChurnKind = StandardProjectionKind | "history";
type StandardChangesByKind = Record<StandardChurnKind, number>;

const emptyStandardChangesByKind = (): StandardChangesByKind => ({
  activeThreshold: 0,
  ageThreshold: 0,
  budget: 0,
  staleRead: 0,
  duplicate: 0,
  errorCap: 0,
  history: 0,
});

type StabilityStats = {
  newProjections: number;
  projectionCacheHits: number;
  recoverableEntries: number;
  explicitReflows: number;
  automaticRollovers: number;
  softBudgetExceedances: number;
  prefixChurnViolations: number;
  earliestChangedPriorMessageIndex?: number;
  estimatedInvalidatedChars: number;
  standardComparisons: number;
  standardPrefixChurn: number;
  standardEarliestChangedPriorMessageIndex?: number;
  standardEstimatedInvalidatedChars: number;
  standardChangesByKind: StandardChangesByKind;
};

type PersistedTelemetry = {
  version: 1;
  kind: "pi-sieve-telemetry";
  cumulativeActual: TransformStats;
  cumulativeProjected: TransformStats;
  recalls: number;
  recalledChars: number;
  recallsByTool: Record<string, { recalls: number; recalledChars: number }>;
  stability: Omit<
    StabilityStats,
    "recoverableEntries" | "earliestChangedPriorMessageIndex" | "standardEarliestChangedPriorMessageIndex"
  >;
};

const TELEMETRY_ENTRY_TYPE = "pi-sieve-telemetry";
const CHARS_PER_ESTIMATED_TOKEN = 4;
const MAX_PERSISTED_TOOL_ENTRIES = 1_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
/** Rejects oversized names and the keys that would shadow Object.prototype members. */
const isSafeToolName = (value: string) =>
  !!value && value.length <= 200 && value !== "__proto__" && value !== "prototype" && value !== "constructor";

const Count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const exact = (properties: TProperties) => Type.Object(properties, { additionalProperties: false });
const counters = (keys: readonly string[]) => exact(Object.fromEntries(keys.map(key => [key, Count])));

const ToolUsageSchema = exact({
  scanned: Count,
  transformed: Count,
  sourceChars: Count,
  retainedChars: Count,
  netCharsSaved: Count,
});
const RecallUsageSchema = exact({ recalls: Count, recalledChars: Count });
const emptyStats = emptyTransformStats();
const TransformStatsSchema = exact({
  scanned: Count,
  transformed: Count,
  transformedBy: counters(Object.keys(emptyStats.transformedBy)),
  omittedChars: Count,
  netCharsSaved: Count,
  skipped: counters(Object.keys(emptyStats.skipped)),
});

const LEGACY_STABILITY_KEYS = [
  "newProjections",
  "projectionCacheHits",
  "explicitReflows",
  "automaticRollovers",
  "softBudgetExceedances",
  "prefixChurnViolations",
  "estimatedInvalidatedChars",
] as const;
const LegacyStabilitySchema = counters(LEGACY_STABILITY_KEYS);
const CurrentStabilitySchema = exact({
  ...Object.fromEntries(LEGACY_STABILITY_KEYS.map(key => [key, Count])),
  standardComparisons: Count,
  standardPrefixChurn: Count,
  standardEstimatedInvalidatedChars: Count,
  standardChangesByKind: counters(STANDARD_CHURN_KINDS),
});
/** Entries written before the standard-v2 churn counters existed are still accepted. */
const StabilitySchema = Type.Union([CurrentStabilitySchema, LegacyStabilitySchema]);

const PersistedTelemetrySchema = exact({
  version: Type.Literal(1),
  kind: Type.Literal(TELEMETRY_ENTRY_TYPE),
  // Validated separately: both carry open-ended per-tool records that need key screening.
  cumulativeActual: Type.Unknown(),
  cumulativeProjected: Type.Unknown(),
  recalls: Count,
  recalledChars: Count,
  recallsByTool: Type.Unknown(),
  stability: StabilitySchema,
});

/** Counters dropped from TransformStats; tolerated so older sessions still restore. */
const LEGACY_TRANSFORM_COUNTERS = ["giantError"] as const;

/**
 * Validates an open-ended `{ toolName: counters }` record, screening keys and capping
 * the entry count so a tampered session entry cannot blow up memory.
 */
function parseToolRecord<T>(value: unknown, schema: TSchema): Record<string, T> | undefined {
  if (!isRecord(value)) return;
  const entries = Object.entries(value);
  if (entries.length > MAX_PERSISTED_TOOL_ENTRIES) return;
  const parsed: Record<string, T> = {};
  for (const [toolName, usage] of entries) {
    if (!isSafeToolName(toolName) || !Check(schema, usage)) return;
    parsed[toolName] = usage as T;
  }
  return parsed;
}

function parseTransformStats(value: unknown): TransformStats | undefined {
  if (!isRecord(value)) return;
  const { byTool: rawByTool, ...fixed } = value;
  if (isRecord(fixed.transformedBy)) {
    const transformedBy = { ...fixed.transformedBy };
    for (const key of LEGACY_TRANSFORM_COUNTERS) delete transformedBy[key];
    fixed.transformedBy = transformedBy;
  }
  if (!Check(TransformStatsSchema, fixed)) return;
  const byTool = parseToolRecord<TransformStats["byTool"][string]>(rawByTool, ToolUsageSchema);
  return byTool && ({ ...fixed, byTool } as TransformStats);
}

function parsePersistedTelemetry(value: unknown): PersistedTelemetry | undefined {
  if (!Check(PersistedTelemetrySchema, value)) return;
  const parsed = value as Omit<PersistedTelemetry, "cumulativeActual" | "cumulativeProjected" | "recallsByTool"> & {
    cumulativeActual: unknown;
    cumulativeProjected: unknown;
    recallsByTool: unknown;
  };
  const cumulativeActual = parseTransformStats(parsed.cumulativeActual);
  const cumulativeProjected = parseTransformStats(parsed.cumulativeProjected);
  const recallsByTool = parseToolRecord<PersistedTelemetry["recallsByTool"][string]>(
    parsed.recallsByTool,
    RecallUsageSchema,
  );
  if (!cumulativeActual || !cumulativeProjected || !recallsByTool) return;
  return {
    version: 1,
    kind: TELEMETRY_ENTRY_TYPE,
    cumulativeActual,
    cumulativeProjected,
    recalls: parsed.recalls,
    recalledChars: parsed.recalledChars,
    recallsByTool,
    stability: {
      standardComparisons: 0,
      standardPrefixChurn: 0,
      standardEstimatedInvalidatedChars: 0,
      standardChangesByKind: emptyStandardChangesByKind(),
      ...(parsed.stability as Partial<PersistedTelemetry["stability"]>),
    } as PersistedTelemetry["stability"],
  };
}

const estimatedTokens = (characters: number) => Math.ceil(characters / CHARS_PER_ESTIMATED_TOKEN);

/**
 * Index of the first message that differs between two projections, i.e. where the
 * provider's cached prefix stops being reusable. Returns `previous.length` when the
 * whole prior projection still matches.
 */
function firstDivergence(previous: readonly unknown[], next: readonly unknown[]): number {
  let index = 0;
  while (index < previous.length && JSON.stringify(previous[index]) === JSON.stringify(next[index])) index++;
  return index;
}

const projectionModeLabel = (mode: ProjectionMode) =>
  mode === "stable" ? "stable (experimental)" : mode === "standard-v2" ? "standard v2" : "standard";

const SKIP_LABELS: Record<keyof TransformStats["skipped"], string> = {
  recentWindow: "recent-window",
  ineligibleTool: "ineligible-tool",
  error: "error",
  nonTextMixedOrEmptyContent: "non-text/mixed/empty",
  malformedStructuredContent: "malformed-structured",
  atOrBelowThreshold: "at/below-threshold",
  recoveryUnavailable: "recovery-unavailable",
};
const TRANSFORM_LABELS: Record<keyof TransformStats["transformedBy"], string> = {
  ageThreshold: "age-threshold",
  budget: "budget",
  activeThreshold: "active-threshold",
  staleRead: "stale-read",
  duplicate: "duplicate",
  errorCap: "error-cap",
  mixedText: "mixed-text",
};
const countersText = (labels: Record<string, string>, counters: Record<string, number>) =>
  Object.entries(labels)
    .map(([key, label]) => `${label} ${counters[key]}`)
    .join(", ");

function statsText(stats: TransformStats, outcomeLabel: string) {
  const tools =
    Object.entries(stats.byTool)
      .filter(([, usage]) => usage.transformed > 0)
      .sort((left, right) => right[1].netCharsSaved - left[1].netCharsSaved)
      .slice(0, 8)
      .map(
        ([name, usage]) =>
          `${name} ${usage.transformed}/${usage.scanned}, ~${estimatedTokens(usage.netCharsSaved)} tokens`,
      )
      .join(", ") || "none";
  return [
    `scanned ${stats.scanned}`,
    `${outcomeLabel} ${stats.transformed}`,
    `transform types: ${countersText(TRANSFORM_LABELS, stats.transformedBy)}`,
    `${outcomeLabel.replace("transformations", "gross omitted")} ~${estimatedTokens(stats.omittedChars)} tokens`,
    `${outcomeLabel.replace("transformations", "net saved")} ~${estimatedTokens(stats.netCharsSaved)} tokens`,
    `tools: ${tools}`,
    `skips: ${countersText(SKIP_LABELS, stats.skipped)}`,
  ].join("; ");
}

/** Everything /sieve status reports, in the shape the runtime already keeps it. */
type StatusView = {
  mode: SieveMode;
  projectionMode: ProjectionMode;
  threshold: number;
  latestMode: Exclude<SieveMode, "disabled">;
  latestStats: TransformStats;
  cumulativeActual: TransformStats;
  cumulativeProjected: TransformStats;
  activePruning: boolean;
  activeRecalls: number;
  activeRecalledChars: number;
  rolloverHighMultiplier: number;
  rolloverLowMultiplier: number;
  epoch: ProjectionEpoch | undefined;
  stability: StabilityStats;
};

function statusText({
  mode,
  projectionMode,
  threshold,
  latestMode,
  latestStats,
  cumulativeActual,
  cumulativeProjected,
  activePruning,
  activeRecalls,
  activeRecalledChars,
  rolloverHighMultiplier,
  rolloverLowMultiplier,
  epoch,
  stability,
}: StatusView) {
  const cumulative = emptyTransformStats();
  addTransformStats(cumulative, cumulativeActual);
  addTransformStats(cumulative, cumulativeProjected);
  const latestLabel = latestMode === "observe" ? "projected transformations" : "actual transformations";
  const frozen = [...(epoch?.entries.values() ?? [])];
  const frozenSource = frozen.reduce((sum, entry) => sum + entry.sourceChars, 0);
  const frozenRetained = frozen.reduce((sum, entry) => sum + entry.retainedChars, 0);

  return [
    `pi-sieve: ${mode}; projection ${projectionModeLabel(projectionMode)}`,
    `Threshold: > ~${estimatedTokens(threshold)} tokens (${threshold} JS characters; estimated at ${CHARS_PER_ESTIMATED_TOKEN} characters/token)`,
    projectionMode === "stable"
      ? `Projection policy: append-only per-result caps; automatic newest-first rollover at >${rolloverHighMultiplier}T to ${rolloverLowMultiplier}T`
      : projectionMode === "standard-v2"
        ? "Age policy: ages 0–1 byte-identical and recallable; ages 2+ use fixed T with quantized T/T÷2/marker budget tiers"
        : "Age policy: ages 2–5 base; 6+ half (minimum 1000 characters)",
    `Stable rollover: high ${rolloverHighMultiplier}T (${rolloverHighMultiplier * threshold} retained source chars); target ${rolloverLowMultiplier}T (${rolloverLowMultiplier * threshold} chars)`,
    `Eligible tools: ${ELIGIBLE_TOOL_NAMES.join(", ")}`,
    `Read policy: unique ${READ_TOOL_NAME} output is excluded from size/age pruning; only later exact duplicates may be replaced in stable mode`,
    `Active-result pruning: ${activePruning ? "enabled" : "disabled"}`,
    `Active recalls: ${activeRecalls}; restored ~${estimatedTokens(activeRecalledChars)} tokens`,
    `Recent-window policy: ${
      projectionMode === "stable"
        ? "results freeze at first projection; user messages do not reflow them"
        : projectionMode === "standard-v2"
          ? "ages 0 and 1 reuse one recallable projection byte-for-byte"
          : RECENT_WINDOW_POLICY
    }`,
    `Epoch: ${epoch?.id ?? "not started"}${epoch ? ` (${epoch.reason}, ${epoch.startedAt})` : ""}; frozen ${frozen.length}; source ${frozenSource} chars; retained ${frozenRetained} chars`,
    `Stability: new projections ${stability.newProjections}; cache hits ${stability.projectionCacheHits}; explicit reflows ${stability.explicitReflows}; automatic rollovers ${stability.automaticRollovers}; watermark crossings ${stability.softBudgetExceedances}; prefix-churn violations ${stability.prefixChurnViolations}; estimated invalidated ${stability.estimatedInvalidatedChars} chars; standard comparisons ${stability.standardComparisons}; standard prefix churn ${stability.standardPrefixChurn}; standard estimated invalidated ${stability.standardEstimatedInvalidatedChars} chars; standard changes ${STANDARD_CHURN_KINDS.map(kind => `${kind} ${stability.standardChangesByKind[kind]}`).join(", ")}`,
    `Latest call (${latestMode === "observe" ? "observe projections" : "enabled actual"}): ${statsText(latestStats, latestLabel)}`,
    `Cumulative outcomes: actual transformations ${cumulativeActual.transformed}; actual gross omitted ~${estimatedTokens(cumulativeActual.omittedChars)} tokens; actual net saved ~${estimatedTokens(cumulativeActual.netCharsSaved)} tokens; projected observe transformations ${cumulativeProjected.transformed}; projected observe gross omitted ~${estimatedTokens(cumulativeProjected.omittedChars)} tokens; projected observe net saved ~${estimatedTokens(cumulativeProjected.netCharsSaved)} tokens`,
    `Cumulative classifications: ${statsText(cumulative, "qualifying transformations")}`,
  ].join("\n");
}

function fingerprint(
  pi: ExtensionAPI,
  ctx: any,
  threshold: number,
  activePruning: boolean,
  projectionMode: ProjectionMode,
  rolloverHighMultiplier: number,
  rolloverLowMultiplier: number,
) {
  const active = typeof pi.getActiveTools === "function" ? [...pi.getActiveTools()].sort() : [];
  const all = typeof pi.getAllTools === "function" ? pi.getAllTools() : [];
  const activeSet = new Set(active);
  const schemas = all
    .filter((tool: any) => activeSet.has(tool.name))
    .map((tool: any) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
    .sort((left: any, right: any) => left.name.localeCompare(right.name));
  const value = {
    model: ctx?.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
    systemPrompt: typeof ctx?.getSystemPrompt === "function" ? ctx.getSystemPrompt() : "",
    active,
    schemas,
    cwd: resolve(ctx?.cwd ?? process.cwd()),
    threshold,
    activePruning,
    projectionMode,
    rolloverHighMultiplier,
    rolloverLowMultiplier,
    policyVersion: PROJECTION_POLICY_VERSION,
  };
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export default function sieveExtension(pi: ExtensionAPI, options: { configPath?: string } = {}) {
  let mode: SieveMode = "enabled";
  let projectionMode: ProjectionMode = "standard-v2";
  let threshold = SIEVE_THRESHOLD;
  let rolloverHighMultiplier = DEFAULT_ROLLOVER_HIGH_MULTIPLIER;
  let rolloverLowMultiplier = DEFAULT_ROLLOVER_LOW_MULTIPLIER;
  let latestMode: Exclude<SieveMode, "disabled"> = "enabled";
  let latestStats = emptyTransformStats();
  let cumulativeActual = emptyTransformStats();
  let cumulativeProjected = emptyTransformStats();
  let activePruning = true;
  let activeRecalls = 0;
  let activeRecalledChars = 0;
  let recallsByTool: Record<string, { recalls: number; recalledChars: number }> = {};
  let recoverableActiveResults = new Map<string, RecoverableActiveResult>();
  let rawRecoverableResults = new Map<string, RawRecoverableResult>();
  let continuityRecoverableIds = new Set<string>();
  let continuityRecoverableSourceHashes = new Map<string, string>();
  let epoch: ProjectionEpoch | undefined;
  let pendingEpochReason: EpochReason | undefined = "session-start";
  let contextUsagePercent: number | undefined;
  let continuityRecallActive = false;
  let stability: StabilityStats = {
    newProjections: 0,
    projectionCacheHits: 0,
    recoverableEntries: 0,
    explicitReflows: 0,
    automaticRollovers: 0,
    softBudgetExceedances: 0,
    prefixChurnViolations: 0,
    earliestChangedPriorMessageIndex: undefined,
    estimatedInvalidatedChars: 0,
    standardComparisons: 0,
    standardPrefixChurn: 0,
    standardEarliestChangedPriorMessageIndex: undefined,
    standardEstimatedInvalidatedChars: 0,
    standardChangesByKind: emptyStandardChangesByKind(),
  };
  let previousStandardProjection: { messages: any[]; replacements: Map<number, StandardProjectionKind> } | undefined;
  let softBudgetExceededInEpoch = false;
  let persistedConfig = defaultConfig();
  const settingsPath = options.configPath ?? configPath();
  const applyConfig = (config: SieveConfig) => {
    persistedConfig = config;
    activePruning = configuredActivePruning(config);
    threshold = configuredThreshold(config);
    projectionMode = configuredProjectionMode(config);
    rolloverHighMultiplier = configuredRolloverHighMultiplier(config);
    rolloverLowMultiplier = configuredRolloverLowMultiplier(config);
  };
  let configLoadError: unknown;
  let configQueue: Promise<void> = loadConfig(settingsPath)
    .then(applyConfig)
    .catch(error => {
      configLoadError = error;
    });

  const beginEpoch = (reason: EpochReason, ctx?: any, knownFingerprint?: string) => {
    const promptFingerprint =
      knownFingerprint ??
      fingerprint(pi, ctx, threshold, activePruning, projectionMode, rolloverHighMultiplier, rolloverLowMultiplier);
    epoch = createProjectionEpoch(
      reason,
      { threshold, activePruning, rolloverHighMultiplier, rolloverLowMultiplier },
      promptFingerprint,
    );
    pendingEpochReason = undefined;
    recoverableActiveResults.clear();
    rawRecoverableResults.clear();
    continuityRecoverableIds.clear();
    continuityRecoverableSourceHashes.clear();
    previousStandardProjection = undefined;
    softBudgetExceededInEpoch = false;
  };
  const requestEpoch = (reason: EpochReason) => {
    pendingEpochReason = reason;
    recoverableActiveResults.clear();
    rawRecoverableResults.clear();
    continuityRecoverableIds.clear();
    continuityRecoverableSourceHashes.clear();
    previousStandardProjection = undefined;
  };
  const epochSnapshot = () => {
    const entries = [...(epoch?.entries.values() ?? [])];
    return {
      id: epoch?.id,
      reason: epoch?.reason,
      startedAt: epoch?.startedAt,
      promptFingerprint: epoch?.promptFingerprint,
      frozenResultCount: entries.length,
      frozenSourceChars: entries.reduce((sum, entry) => sum + entry.sourceChars, 0),
      frozenRetainedChars: entries.reduce((sum, entry) => sum + entry.retainedChars, 0),
      rolloverEligibleRetainedChars: epoch ? retainedProjectionBudget(epoch) : 0,
      recoverableEntries: entries.filter(entry => entry.recoverable && !epoch?.taintedIds.has(entry.toolCallId)).length,
    };
  };
  const stateSnapshot = (available = true) => ({
    version: 1,
    available,
    mode,
    projectionMode,
    threshold,
    activePruning,
    rolloverHighMultiplier,
    rolloverLowMultiplier,
    latestMode,
    latest: latestStats,
    cumulativeActual,
    cumulativeProjected,
    recalls: activeRecalls,
    recalledChars: activeRecalledChars,
    recallsByTool,
    epoch: epochSnapshot(),
    stability,
    ...(contextUsagePercent !== undefined ? { contextUsagePercent } : {}),
    updatedAt: new Date().toISOString(),
    ...(configLoadError ? { error: (configLoadError as any)?.message ?? String(configLoadError) } : {}),
  });
  const resetTelemetry = () => {
    latestStats = emptyTransformStats();
    cumulativeActual = emptyTransformStats();
    cumulativeProjected = emptyTransformStats();
    activeRecalls = 0;
    activeRecalledChars = 0;
    recallsByTool = {};
    stability = {
      newProjections: 0,
      projectionCacheHits: 0,
      recoverableEntries: 0,
      explicitReflows: 0,
      automaticRollovers: 0,
      softBudgetExceedances: 0,
      prefixChurnViolations: 0,
      earliestChangedPriorMessageIndex: undefined,
      estimatedInvalidatedChars: 0,
      standardComparisons: 0,
      standardPrefixChurn: 0,
      standardEarliestChangedPriorMessageIndex: undefined,
      standardEstimatedInvalidatedChars: 0,
      standardChangesByKind: emptyStandardChangesByKind(),
    };
  };
  const telemetrySnapshot = (): PersistedTelemetry => ({
    version: 1,
    kind: TELEMETRY_ENTRY_TYPE,
    cumulativeActual: structuredClone(cumulativeActual),
    cumulativeProjected: structuredClone(cumulativeProjected),
    recalls: activeRecalls,
    recalledChars: activeRecalledChars,
    recallsByTool: structuredClone(recallsByTool),
    stability: {
      newProjections: stability.newProjections,
      projectionCacheHits: stability.projectionCacheHits,
      explicitReflows: stability.explicitReflows,
      automaticRollovers: stability.automaticRollovers,
      softBudgetExceedances: stability.softBudgetExceedances,
      prefixChurnViolations: stability.prefixChurnViolations,
      estimatedInvalidatedChars: stability.estimatedInvalidatedChars,
      standardComparisons: stability.standardComparisons,
      standardPrefixChurn: stability.standardPrefixChurn,
      standardEstimatedInvalidatedChars: stability.standardEstimatedInvalidatedChars,
      standardChangesByKind: structuredClone(stability.standardChangesByKind),
    },
  });
  const persistTelemetry = () => {
    try {
      pi.appendEntry(TELEMETRY_ENTRY_TYPE, telemetrySnapshot());
    } catch {
      /* Telemetry persistence must never interrupt model calls. */
    }
  };
  const restoreTelemetry = (ctx: any) => {
    resetTelemetry();
    let entries: unknown;
    try {
      entries = ctx?.sessionManager?.getBranch?.();
    } catch {
      return;
    }
    if (!Array.isArray(entries)) return;
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (entry?.type !== "custom" || entry.customType !== TELEMETRY_ENTRY_TYPE) continue;
      const restored = parsePersistedTelemetry(entry.data);
      if (!restored) continue;
      cumulativeActual = restored.cumulativeActual;
      cumulativeProjected = restored.cumulativeProjected;
      activeRecalls = restored.recalls;
      activeRecalledChars = restored.recalledChars;
      recallsByTool = restored.recallsByTool;
      stability = {
        ...restored.stability,
        recoverableEntries: 0,
        earliestChangedPriorMessageIndex: undefined,
        standardEarliestChangedPriorMessageIndex: undefined,
      };
      break;
    }
  };
  const publishState = () => pi.events.emit("pi-sieve:state-change", stateSnapshot());
  const disposeStateRequest = pi.events.on("pi-sieve:state-request", (request: any) => {
    if (request?.version === 1 && typeof request.respond === "function") request.respond(stateSnapshot());
  });
  const updateConfig = async (patch: {
    activePruning?: boolean;
    threshold?: number;
    projectionMode?: ProjectionMode;
    rolloverHighMultiplier?: number;
    rolloverLowMultiplier?: number;
  }) => {
    const operation = configQueue.then(async () => {
      if (configLoadError) throw configLoadError;
      const next: SieveConfig = {
        version: 1,
        activePruning: patch.activePruning ?? configuredActivePruning(persistedConfig),
        threshold: patch.threshold ?? configuredThreshold(persistedConfig),
        projectionMode: patch.projectionMode ?? configuredProjectionMode(persistedConfig),
        rolloverHighMultiplier: patch.rolloverHighMultiplier ?? configuredRolloverHighMultiplier(persistedConfig),
        rolloverLowMultiplier: patch.rolloverLowMultiplier ?? configuredRolloverLowMultiplier(persistedConfig),
      };
      await saveConfig(next, settingsPath);
      applyConfig(next);
    });
    configQueue = operation.catch(() => {});
    await operation;
  };

  const refreshRecallTool = () => {
    const recallEnabled = mode === "enabled" && (activePruning || continuityRecallActive);
    let coordinated = false;
    pi.events.emit("pylon:tool-policy", {
      version: 1,
      kind: "register",
      owner: "pi-sieve",
      managedTools: [RECALL_TOOL_NAME],
      enabledTools: recallEnabled ? [RECALL_TOOL_NAME] : [],
      ...(recallEnabled
        ? { toolUsage: { [RECALL_TOOL_NAME]: "recover a registered tool result omitted from the active context" } }
        : {}),
      acknowledge: () => {
        coordinated = true;
      },
    });
    if (coordinated) return;
    const active = pi.getActiveTools().filter(name => name !== RECALL_TOOL_NAME);
    if (recallEnabled) active.push(RECALL_TOOL_NAME);
    pi.setActiveTools(active);
  };
  const syncContinuityBoundary = (ctx: any) => {
    let boundary: ReturnType<typeof continuityProjectionBoundary>;
    try {
      boundary = continuityProjectionBoundary(ctx?.sessionManager?.getBranch?.() ?? []);
    } catch {
      boundary = undefined;
    }
    const changed = continuityRecallActive !== !!boundary;
    continuityRecallActive = !!boundary;
    return { boundary, changed };
  };

  pi.registerTool({
    name: RECALL_TOOL_NAME,
    label: "Sieve Recall",
    description: "Recover one registered tool result omitted by pi-sieve from the current active raw context.",
    parameters: Type.Object({
      toolCallId: Type.String({ minLength: 1, description: "Exact toolCallId shown in pi-sieve omission marker" }),
    }),
    async execute(_toolCallId, params) {
      const registered =
        mode === "enabled" && (activePruning || continuityRecallActive)
          ? recoverableActiveResults.get(params.toolCallId)
          : undefined;
      const source = registered ? rawRecoverableResults.get(params.toolCallId) : undefined;
      const continuityRegistered = continuityRecoverableIds.has(params.toolCallId);
      const frozen = projectionMode === "stable" ? epoch?.entries.get(params.toolCallId) : undefined;
      if (
        !registered ||
        !source ||
        source.toolName !== registered.toolName ||
        source.isError !== registered.isError ||
        (continuityRegistered && continuityRecoverableSourceHashes.get(params.toolCallId) !== source.sourceHash) ||
        (projectionMode === "stable" && !continuityRegistered && frozen?.sourceHash !== source.sourceHash)
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No recoverable result for toolCallId ${JSON.stringify(params.toolCallId)}.`,
            },
          ],
          details: { found: false, sourceToolCallId: params.toolCallId, sourceToolName: "", sourceIsError: false },
        };
      }
      const sourceChars = source.message.content.reduce(
        (length: number, block: any) =>
          length + (block?.type === "text" && typeof block.text === "string" ? block.text.length : 0),
        0,
      );
      activeRecalls++;
      activeRecalledChars += sourceChars;
      const recallUsage = recallsByTool[registered.toolName] ?? { recalls: 0, recalledChars: 0 };
      recallsByTool = {
        ...recallsByTool,
        [registered.toolName]: {
          recalls: recallUsage.recalls + 1,
          recalledChars: recallUsage.recalledChars + sourceChars,
        },
      };
      persistTelemetry();
      publishState();
      return {
        content: structuredClone(source.message.content),
        details: {
          found: true,
          sourceToolCallId: registered.toolCallId,
          sourceToolName: registered.toolName,
          sourceIsError: registered.isError,
        },
      };
    },
  });

  pi.on("session_start", async (event, ctx) => {
    await configQueue;
    restoreTelemetry(ctx);
    requestEpoch(
      event?.reason === "reload" ? "reload" : event?.reason === "startup" ? "session-start" : "session-replacement",
    );
    syncContinuityBoundary(ctx);
    refreshRecallTool();
    publishState();
    if (configLoadError)
      ctx.ui.notify(
        `Could not load pi-sieve settings: ${(configLoadError as any)?.message ?? String(configLoadError)}`,
        "error",
      );
  });
  pi.on("session_compact", (_event, ctx) => {
    requestEpoch("compaction");
    syncContinuityBoundary(ctx);
    refreshRecallTool();
  });
  pi.on("session_tree", (_event, ctx) => {
    restoreTelemetry(ctx);
    requestEpoch("branch-navigation");
    syncContinuityBoundary(ctx);
    refreshRecallTool();
    publishState();
  });
  pi.on("model_select", () => requestEpoch("model-change"));
  pi.on("session_shutdown", () => {
    disposeStateRequest();
    pi.events.emit("pi-sieve:state-change", stateSnapshot(false));
    pi.events.emit("pylon:tool-policy", { version: 1, kind: "unregister", owner: "pi-sieve" });
  });

  /** Runs the configured projection mode over the raw messages. */
  const project = (messages: any[], cwd: string | undefined) =>
    projectionMode === "stable"
      ? stableSieveMessages(messages, epoch!, { cwd })
      : projectionMode === "standard-v2"
        ? standardV2SieveMessages(messages, threshold, { pruneActive: activePruning, cwd })
        : sieveMessages(messages, threshold, { pruneActive: activePruning, cwd });

  /** Converts an epoch mismatch into a deliberate boundary and reprojects. */
  const reflowStableEpoch = (
    messages: any[],
    ctx: any,
    diagnostics: ProjectionDiagnostics,
    currentFingerprint: string,
  ) => {
    stability.earliestChangedPriorMessageIndex ??= diagnostics.earliestChangedMessageIndex;
    stability.estimatedInvalidatedChars += diagnostics.estimatedInvalidatedChars;
    beginEpoch(
      diagnostics.ambiguousReflows > 0
        ? "ambiguous-id"
        : diagnostics.historyMismatches > 0
          ? "history-mismatch"
          : "source-mismatch",
      ctx,
      currentFingerprint,
    );
    return stableSieveMessages(messages, epoch!, { cwd: ctx?.cwd });
  };

  /**
   * Reseeds the epoch newest-first when retained source crosses the high watermark.
   * Returns the rollover projection only when it actually frees budget.
   */
  const rolloverStableEpoch = (messages: any[], ctx: any, previous: any, currentFingerprint: string) => {
    if (!softBudgetExceededInEpoch) {
      stability.softBudgetExceedances++;
      softBudgetExceededInEpoch = true;
    }
    const previousBudget = retainedProjectionBudget(epoch!);
    const rolloverEpoch = createProjectionEpoch(
      "budget-rollover",
      { threshold, activePruning, rolloverHighMultiplier, rolloverLowMultiplier },
      currentFingerprint,
    );
    const rerun = rolloverStableSieveMessages(messages, rolloverEpoch, rolloverLowMultiplier * threshold, {
      cwd: ctx?.cwd,
    });
    const rolloverBudget = retainedProjectionBudget(rolloverEpoch);
    if (rolloverBudget >= previousBudget || rolloverBudget > rolloverLowMultiplier * threshold) return;
    const changedIndex = firstDivergence(previous.messages, rerun.messages);
    if (changedIndex < previous.messages.length) {
      stability.earliestChangedPriorMessageIndex ??= changedIndex;
      stability.estimatedInvalidatedChars += JSON.stringify(previous.messages.slice(changedIndex)).length;
    }
    epoch = rolloverEpoch;
    recoverableActiveResults.clear();
    rawRecoverableResults.clear();
    softBudgetExceededInEpoch = false;
    stability.automaticRollovers++;
    return rerun;
  };

  /** Merges Continuity's projection of its own retained suffix into `result`. */
  const applyContinuity = (result: any, messages: any[], ctx: any) => {
    // Continuity owns the compaction boundary. Sieve merely projects its retained suffix.
    const { boundary, changed } = syncContinuityBoundary(ctx);
    if (changed) refreshRecallTool();
    const continuityResult = boundary
      ? continuitySieveMessages(messages, boundary.frozenToolCallIds, result.messages)
      : undefined;
    continuityRecoverableIds = new Set(continuityResult?.recoverableActiveResults.map(item => item.toolCallId) ?? []);
    continuityRecoverableSourceHashes = new Map();
    for (let index = 0; index < messages.length; index++) {
      const message: any = messages[index];
      if (message?.role === "toolResult" && continuityRecoverableIds.has(message.toolCallId))
        continuityRecoverableSourceHashes.set(message.toolCallId, projectionSourceHash(messages, index, ctx?.cwd));
    }
    if (!continuityResult || !(continuityResult.stats.transformed || continuityResult.preservedToolCallIds.size))
      return result;
    addTransformStats(result.stats, continuityResult.stats);
    return {
      ...result,
      messages: continuityResult.messages,
      // Continuity's registrations win for ids it preserved.
      recoverableActiveResults: [
        ...new Map([
          ...result.recoverableActiveResults
            .filter((item: RecoverableActiveResult) => !continuityResult.preservedToolCallIds.has(item.toolCallId))
            .map((item: RecoverableActiveResult) => [item.toolCallId, item] as const),
          ...continuityResult.recoverableActiveResults.map(item => [item.toolCallId, item] as const),
        ]).values(),
      ],
    };
  };

  /** Tracks how far the standard projection's stable prefix moved since the last call. */
  const recordStandardChurn = (result: any, diagnostics: StandardProjectionDiagnostics) => {
    const currentReplacements = new Map(diagnostics.replacements.map(item => [item.messageIndex, item.kind]));
    if (previousStandardProjection) {
      stability.standardComparisons++;
      const priorLength = previousStandardProjection.messages.length;
      const changedIndex = firstDivergence(
        previousStandardProjection.messages.slice(0, Math.min(priorLength, result.messages.length)),
        result.messages,
      );
      if (changedIndex < priorLength) {
        const cause =
          currentReplacements.get(changedIndex) ??
          previousStandardProjection.replacements.get(changedIndex) ??
          "history";
        stability.standardPrefixChurn++;
        stability.standardChangesByKind[cause]++;
        stability.standardEarliestChangedPriorMessageIndex = Math.min(
          stability.standardEarliestChangedPriorMessageIndex ?? changedIndex,
          changedIndex,
        );
        stability.standardEstimatedInvalidatedChars += JSON.stringify(
          previousStandardProjection.messages.slice(changedIndex),
        ).length;
      }
    }
    previousStandardProjection = { messages: structuredClone(result.messages), replacements: currentReplacements };
  };

  /** Snapshots the raw text behind every registered recoverable result, for sieve_recall. */
  const indexRecoverables = (result: any, messages: any[], ctx: any) => {
    recoverableActiveResults = new Map(
      result.recoverableActiveResults.map((item: RecoverableActiveResult) => [item.toolCallId, item]),
    );
    const rawCounts = new Map<string, number>();
    for (const message of messages as any[]) {
      if (message?.role === "toolResult" && typeof message.toolCallId === "string" && message.toolCallId)
        rawCounts.set(message.toolCallId, (rawCounts.get(message.toolCallId) ?? 0) + 1);
    }
    rawRecoverableResults = new Map();
    for (let index = 0; index < messages.length; index++) {
      const message: any = messages[index];
      const registered = message?.role === "toolResult" ? recoverableActiveResults.get(message.toolCallId) : undefined;
      // An ambiguous id cannot be recovered unambiguously, so it is never registered.
      if (!registered || rawCounts.get(message.toolCallId) !== 1) continue;
      rawRecoverableResults.set(message.toolCallId, {
        ...registered,
        sourceHash: projectionSourceHash(messages, index, ctx?.cwd),
        message: structuredClone(message),
      });
    }
  };

  pi.on("context", (event, ctx) => {
    if (mode === "disabled") return;
    const currentFingerprint = fingerprint(
      pi,
      ctx,
      threshold,
      activePruning,
      projectionMode,
      rolloverHighMultiplier,
      rolloverLowMultiplier,
    );
    if (!epoch || pendingEpochReason) beginEpoch(pendingEpochReason || "session-start", ctx, currentFingerprint);
    else if (epoch.promptFingerprint !== currentFingerprint) beginEpoch("prompt-fingerprint", ctx, currentFingerprint);

    let result: any = project(event.messages, ctx?.cwd);
    const stable = projectionMode === "stable";
    let diagnostics = stable && "diagnostics" in result ? (result.diagnostics as ProjectionDiagnostics) : undefined;
    const standardDiagnostics =
      projectionMode === "standard-v2" && "diagnostics" in result
        ? (result.diagnostics as StandardProjectionDiagnostics)
        : undefined;

    if (stable && diagnostics?.requiresReflow) {
      result = reflowStableEpoch(event.messages, ctx, diagnostics, currentFingerprint);
      diagnostics = result.diagnostics;
    }
    if (stable && diagnostics?.softBudgetExceeded) {
      const rolled = rolloverStableEpoch(event.messages, ctx, result, currentFingerprint);
      if (rolled) {
        result = rolled;
        diagnostics = rolled.diagnostics;
      }
    }

    result = applyContinuity(result, event.messages, ctx);

    latestMode = mode;
    latestStats = result.stats;
    const usage = typeof ctx?.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
    contextUsagePercent = usage?.percent ?? undefined;
    if (stable && diagnostics) {
      stability.newProjections += diagnostics.newProjections;
      stability.projectionCacheHits += diagnostics.cacheHits;
      stability.recoverableEntries = result.recoverableActiveResults.length;
    }
    if (standardDiagnostics && mode === "enabled") recordStandardChurn(result, standardDiagnostics);

    if (mode === "observe") {
      addTransformStats(cumulativeProjected, result.stats);
      persistTelemetry();
      publishState();
      return;
    }

    addTransformStats(cumulativeActual, result.stats);
    indexRecoverables(result, event.messages, ctx);
    persistTelemetry();
    publishState();
    return { messages: result.messages };
  });

  /**
   * Persists a settings change, reporting failures the same way for every subcommand.
   * Returns false when the save failed and the caller should stop.
   */
  const saveSetting = async (ctx: any, what: string, patch: Parameters<typeof updateConfig>[0]) => {
    try {
      await updateConfig(patch);
      return true;
    } catch (error: any) {
      ctx.ui.notify(`Could not save pi-sieve ${what}: ${error?.message ?? String(error)}`, "error");
      return false;
    }
  };

  const USAGE =
    "Usage: /sieve [status|mode <enabled|observe|disabled>|projection <stable|standard-v2>|active-pruning <on|off>|threshold <integer|reset>|rollover <high> <low>|rollover reset|reflow|reset-stats|help]";

  const showStatus = (ctx: any) =>
    ctx.ui.notify(
      statusText({
        mode,
        projectionMode,
        threshold,
        latestMode,
        latestStats,
        cumulativeActual,
        cumulativeProjected,
        activePruning,
        activeRecalls,
        activeRecalledChars,
        rolloverHighMultiplier,
        rolloverLowMultiplier,
        epoch,
        stability,
      }),
      "info",
    );

  const setMode = (nextMode: SieveMode, ctx: any) => {
    if (mode !== nextMode) requestEpoch("configuration-change");
    mode = nextMode;
    if (mode !== "enabled") {
      recoverableActiveResults.clear();
      rawRecoverableResults.clear();
      continuityRecoverableIds.clear();
      continuityRecoverableSourceHashes.clear();
      continuityRecallActive = false;
    } else syncContinuityBoundary(ctx);
    refreshRecallTool();
    publishState();
    ctx.ui.notify(
      mode === "observe"
        ? "pi-sieve observing: classifications are reported without changing outbound messages."
        : `pi-sieve ${mode}.`,
      "info",
    );
  };

  pi.registerCommand("sieve", {
    description: "Configure tool-result projection, active-result pruning, thresholds, and cache rollover",
    handler: async (args, ctx) => {
      const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const action = parts[0] ?? "status";
      const value = parts[1];
      const usage = () => ctx.ui.notify(USAGE, "warning");
      if ((parts.length === 0 || (parts.length === 1 && action === "status"))) {
        showStatus(ctx);
        return;
      }
      if (parts.length === 1 && action === "help") {
        ctx.ui.notify(USAGE, "info");
        return;
      }
      if (parts.length === 2 && action === "mode" && ["enabled", "observe", "disabled"].includes(value!)) {
        setMode(value as SieveMode, ctx);
        return;
      }
      if (parts.length === 2 && action === "active-pruning" && ["on", "off"].includes(value!)) {
        if (!(await saveSetting(ctx, "active-result setting", { activePruning: value === "on" }))) return;
        requestEpoch("configuration-change");
        refreshRecallTool();
        publishState();
        ctx.ui.notify(
          `pi-sieve active-result pruning ${activePruning ? "enabled" : "disabled"}; cached prefix will reset.`,
          "info",
        );
        return;
      }
      if (parts.length === 2 && action === "projection" && ["stable", "standard-v2"].includes(value!)) {
        if (!(await saveSetting(ctx, "projection mode", { projectionMode: value as ProjectionMode }))) return;
        requestEpoch("configuration-change");
        publishState();
        ctx.ui.notify(
          `pi-sieve projection mode set to ${projectionModeLabel(projectionMode)}; cached prefix will reset.`,
          "info",
        );
        return;
      }
      if (parts.length === 1 && action === "reflow") {
        stability.explicitReflows++;
        requestEpoch("explicit-reflow");
        persistTelemetry();
        publishState();
        ctx.ui.notify("pi-sieve will rebuild projections on the next provider call; cached prefix will reset.", "info");
        return;
      }
      if (parts.length === 1 && action === "reset-stats") {
        resetTelemetry();
        persistTelemetry();
        publishState();
        ctx.ui.notify("pi-sieve statistics reset.", "info");
        return;
      }
      if (action === "threshold" && parts.length === 2) {
        const reset = value === "reset";
        const candidate = reset ? SIEVE_THRESHOLD : Number(value);
        if (!Number.isSafeInteger(candidate) || candidate < MIN_SIEVE_THRESHOLD || candidate > MAX_SIEVE_THRESHOLD) {
          ctx.ui.notify(`Threshold must be an integer from ${MIN_SIEVE_THRESHOLD} to ${MAX_SIEVE_THRESHOLD}.`, "warning");
          return;
        }
        if (!(await saveSetting(ctx, "threshold", { threshold: candidate }))) return;
        requestEpoch("configuration-change");
        publishState();
        ctx.ui.notify(`pi-sieve threshold ${reset ? "reset" : "set"} to ${threshold}; cached prefix will reset.`, "info");
        return;
      }
      if (action === "rollover" && (parts.length === 3 || (parts.length === 2 && value === "reset"))) {
        const reset = value === "reset";
        const high = reset ? DEFAULT_ROLLOVER_HIGH_MULTIPLIER : Number(value);
        const low = reset ? DEFAULT_ROLLOVER_LOW_MULTIPLIER : Number(parts[2]);
        if (
          !Number.isSafeInteger(high) ||
          !Number.isSafeInteger(low) ||
          low < MIN_ROLLOVER_MULTIPLIER ||
          high > MAX_ROLLOVER_MULTIPLIER ||
          high <= low
        ) {
          ctx.ui.notify(
            `Rollover multipliers must be integers from ${MIN_ROLLOVER_MULTIPLIER} to ${MAX_ROLLOVER_MULTIPLIER}, with high greater than low.`,
            "warning",
          );
          return;
        }
        if (!(await saveSetting(ctx, "rollover settings", { rolloverHighMultiplier: high, rolloverLowMultiplier: low }))) return;
        requestEpoch("configuration-change");
        publishState();
        ctx.ui.notify(`pi-sieve rollover ${reset ? "reset" : "set"} to ${high}T → ${low}T; cached prefix will reset.`, "info");
        return;
      }
      usage();
    },
  });
}
