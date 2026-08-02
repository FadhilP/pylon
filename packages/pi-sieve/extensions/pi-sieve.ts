import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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
  createProjectionEpoch,
  emptyTransformStats,
  projectionSourceHash,
  retainedProjectionBudget,
  rolloverStableSieveMessages,
  sieveMessages,
  stableSieveMessages,
  type EpochReason,
  type ProjectionDiagnostics,
  type ProjectionEpoch,
  type RecoverableActiveResult,
  type TransformStats,
} from "../src/sieve.ts";

type SieveMode = "enabled" | "observe" | "disabled";

type RawRecoverableResult = RecoverableActiveResult & {
  sourceHash: string;
  message: any;
};

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
};

type PersistedTelemetry = {
  version: 1;
  kind: "pi-sieve-telemetry";
  cumulativeActual: TransformStats;
  cumulativeProjected: TransformStats;
  recalls: number;
  recalledChars: number;
  recallsByTool: Record<string, { recalls: number; recalledChars: number }>;
  stability: Omit<StabilityStats, "recoverableEntries" | "earliestChangedPriorMessageIndex">;
};

const TELEMETRY_ENTRY_TYPE = "pi-sieve-telemetry";
const CHARS_PER_ESTIMATED_TOKEN = 4;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const isSafeToolName = (value: string) =>
  !!value && value.length <= 200 && value !== "__proto__" && value !== "prototype" && value !== "constructor";

function parseNumericShape(value: unknown, shape: Record<string, unknown>): Record<string, any> | undefined {
  if (!isRecord(value) || !hasExactKeys(value, Object.keys(shape))) return;
  const parsed: Record<string, any> = {};
  for (const [key, expected] of Object.entries(shape)) {
    if (typeof expected === "number") {
      if (!isCount(value[key])) return;
      parsed[key] = value[key];
      continue;
    }
    if (!isRecord(expected)) return;
    const nested = parseNumericShape(value[key], expected);
    if (!nested) return;
    parsed[key] = nested;
  }
  return parsed;
}

function parseTransformStats(value: unknown): TransformStats | undefined {
  if (!isRecord(value) || !isRecord(value.byTool)) return;
  const { byTool: _valueByTool, ...fixed } = value;
  const { byTool: _shapeByTool, ...shape } = emptyTransformStats();
  const parsed = parseNumericShape(fixed, shape);
  if (!parsed) return;
  const entries = Object.entries(value.byTool);
  if (entries.length > 1_000) return;
  const byTool: TransformStats["byTool"] = {};
  const toolShape = { scanned: 0, transformed: 0, sourceChars: 0, retainedChars: 0, netCharsSaved: 0 };
  for (const [toolName, usage] of entries) {
    if (!isSafeToolName(toolName)) return;
    const parsedUsage = parseNumericShape(usage, toolShape);
    if (!parsedUsage) return;
    byTool[toolName] = parsedUsage as TransformStats["byTool"][string];
  }
  return { ...parsed, byTool } as TransformStats;
}

function parsePersistedTelemetry(value: unknown): PersistedTelemetry | undefined {
  if (!isRecord(value) || !hasExactKeys(value, [
    "version", "kind", "cumulativeActual", "cumulativeProjected", "recalls", "recalledChars", "recallsByTool", "stability",
  ]) || value.version !== 1 || value.kind !== TELEMETRY_ENTRY_TYPE || !isCount(value.recalls)
    || !isCount(value.recalledChars) || !isRecord(value.recallsByTool) || !isRecord(value.stability)) return;
  const cumulativeActual = parseTransformStats(value.cumulativeActual);
  const cumulativeProjected = parseTransformStats(value.cumulativeProjected);
  if (!cumulativeActual || !cumulativeProjected || Object.keys(value.recallsByTool).length > 1_000) return;
  const recallsByTool: PersistedTelemetry["recallsByTool"] = {};
  for (const [toolName, usage] of Object.entries(value.recallsByTool)) {
    if (!isSafeToolName(toolName)) return;
    const parsed = parseNumericShape(usage, { recalls: 0, recalledChars: 0 });
    if (!parsed) return;
    recallsByTool[toolName] = parsed as { recalls: number; recalledChars: number };
  }
  const stability = parseNumericShape(value.stability, {
    newProjections: 0, projectionCacheHits: 0, explicitReflows: 0, automaticRollovers: 0,
    softBudgetExceedances: 0, prefixChurnViolations: 0, estimatedInvalidatedChars: 0,
  });
  if (!stability) return;
  return {
    version: 1,
    kind: TELEMETRY_ENTRY_TYPE,
    cumulativeActual,
    cumulativeProjected,
    recalls: value.recalls,
    recalledChars: value.recalledChars,
    recallsByTool,
    stability: stability as PersistedTelemetry["stability"],
  };
}

const estimatedTokens = (characters: number) => Math.ceil(characters / CHARS_PER_ESTIMATED_TOKEN);
const projectionModeLabel = (mode: ProjectionMode) => mode === "stable" ? "stable (experimental)" : "standard";

function statsText(stats: TransformStats, outcomeLabel: string) {
  const { skipped } = stats;
  const tools = Object.entries(stats.byTool)
    .filter(([, usage]) => usage.transformed > 0)
    .sort((left, right) => right[1].netCharsSaved - left[1].netCharsSaved)
    .slice(0, 8)
    .map(([name, usage]) => `${name} ${usage.transformed}/${usage.scanned}, ~${estimatedTokens(usage.netCharsSaved)} tokens`)
    .join(", ") || "none";
  return [
    `scanned ${stats.scanned}`,
    `${outcomeLabel} ${stats.transformed}`,
    `transform types: age-threshold ${stats.transformedBy.ageThreshold}, budget ${stats.transformedBy.budget}, giant-error ${stats.transformedBy.giantError}, active-threshold ${stats.transformedBy.activeThreshold}, stale-read ${stats.transformedBy.staleRead}, duplicate ${stats.transformedBy.duplicate}, error-cap ${stats.transformedBy.errorCap}, mixed-text ${stats.transformedBy.mixedText}`,
    `${outcomeLabel.replace("transformations", "gross omitted")} ~${estimatedTokens(stats.omittedChars)} tokens`,
    `${outcomeLabel.replace("transformations", "net saved")} ~${estimatedTokens(stats.netCharsSaved)} tokens`,
    `tools: ${tools}`,
    `skips: recent-window ${skipped.recentWindow}, ineligible-tool ${skipped.ineligibleTool}, error ${skipped.error}, non-text/mixed/empty ${skipped.nonTextMixedOrEmptyContent}, malformed-structured ${skipped.malformedStructuredContent}, at/below-threshold ${skipped.atOrBelowThreshold}, recovery-unavailable ${skipped.recoveryUnavailable}`,
  ].join("; ");
}

function statusText(
  mode: SieveMode,
  projectionMode: ProjectionMode,
  threshold: number,
  latestMode: Exclude<SieveMode, "disabled">,
  latestStats: TransformStats,
  cumulativeActual: TransformStats,
  cumulativeProjected: TransformStats,
  activePruning: boolean,
  activeRecalls: number,
  activeRecalledChars: number,
  rolloverHighMultiplier: number,
  rolloverLowMultiplier: number,
  epoch: ProjectionEpoch | undefined,
  stability: Omit<StabilityStats, "recoverableEntries" | "earliestChangedPriorMessageIndex">,
) {
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
      : "Age policy: ages 2–5 base; 6+ half (minimum 1000 characters)",
    `Stable rollover: high ${rolloverHighMultiplier}T (${rolloverHighMultiplier * threshold} retained source chars); target ${rolloverLowMultiplier}T (${rolloverLowMultiplier * threshold} chars)`,
    `Eligible tools: ${ELIGIBLE_TOOL_NAMES.join(", ")}`,
    `Read policy: unique ${READ_TOOL_NAME} output is excluded from size/age pruning; only later exact duplicates may be replaced in stable mode`,
    `Active-result pruning: ${activePruning ? "enabled" : "disabled"}`,
    `Active recalls: ${activeRecalls}; restored ~${estimatedTokens(activeRecalledChars)} tokens`,
    `Recent-window policy: ${projectionMode === "stable" ? "results freeze at first projection; user messages do not reflow them" : RECENT_WINDOW_POLICY}`,
    `Epoch: ${epoch?.id ?? "not started"}${epoch ? ` (${epoch.reason}, ${epoch.startedAt})` : ""}; frozen ${frozen.length}; source ${frozenSource} chars; retained ${frozenRetained} chars`,
    `Stability: new projections ${stability.newProjections}; cache hits ${stability.projectionCacheHits}; explicit reflows ${stability.explicitReflows}; automatic rollovers ${stability.automaticRollovers}; watermark crossings ${stability.softBudgetExceedances}; prefix-churn violations ${stability.prefixChurnViolations}; estimated invalidated ${stability.estimatedInvalidatedChars} chars`,
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
  let projectionMode: ProjectionMode = "legacy";
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
  let epoch: ProjectionEpoch | undefined;
  let pendingEpochReason: EpochReason | undefined = "session-start";
  let contextUsagePercent: number | undefined;
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
  };
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
  let configQueue: Promise<void> = loadConfig(settingsPath).then(applyConfig).catch((error) => {
    configLoadError = error;
  });

  const beginEpoch = (reason: EpochReason, ctx?: any, knownFingerprint?: string) => {
    const promptFingerprint = knownFingerprint ?? fingerprint(
      pi, ctx, threshold, activePruning, projectionMode, rolloverHighMultiplier, rolloverLowMultiplier,
    );
    epoch = createProjectionEpoch(reason, {
      threshold, activePruning, rolloverHighMultiplier, rolloverLowMultiplier,
    }, promptFingerprint);
    pendingEpochReason = undefined;
    recoverableActiveResults.clear();
    rawRecoverableResults.clear();
    softBudgetExceededInEpoch = false;
  };
  const requestEpoch = (reason: EpochReason) => {
    pendingEpochReason = reason;
    recoverableActiveResults.clear();
    rawRecoverableResults.clear();
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
      recoverableEntries: entries.filter((entry) => entry.recoverable && !epoch?.taintedIds.has(entry.toolCallId)).length,
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
      newProjections: 0, projectionCacheHits: 0, recoverableEntries: 0, explicitReflows: 0,
      automaticRollovers: 0, softBudgetExceedances: 0, prefixChurnViolations: 0,
      earliestChangedPriorMessageIndex: undefined, estimatedInvalidatedChars: 0,
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
    },
  });
  const persistTelemetry = () => {
    try { pi.appendEntry(TELEMETRY_ENTRY_TYPE, telemetrySnapshot()); }
    catch { /* Telemetry persistence must never interrupt model calls. */ }
  };
  const restoreTelemetry = (ctx: any) => {
    resetTelemetry();
    let entries: unknown;
    try { entries = ctx?.sessionManager?.getBranch?.(); }
    catch { return; }
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
    const recallEnabled = activePruning && mode === "enabled";
    let coordinated = false;
    pi.events.emit("pylon:tool-policy", {
      version: 1,
      kind: "register",
      owner: "pi-sieve",
      managedTools: [RECALL_TOOL_NAME],
      enabledTools: recallEnabled ? [RECALL_TOOL_NAME] : [],
      acknowledge: () => { coordinated = true; },
    });
    if (coordinated) return;
    const active = pi.getActiveTools().filter((name) => name !== RECALL_TOOL_NAME);
    if (recallEnabled) active.push(RECALL_TOOL_NAME);
    pi.setActiveTools(active);
  };

  pi.registerTool({
    name: RECALL_TOOL_NAME,
    label: "Sieve Recall",
    description: "Recover one registered tool result omitted by pi-sieve from the current active raw context.",
    parameters: Type.Object({
      toolCallId: Type.String({ minLength: 1, description: "Exact toolCallId shown in pi-sieve omission marker" }),
    }),
    async execute(_toolCallId, params) {
      const registered = activePruning ? recoverableActiveResults.get(params.toolCallId) : undefined;
      const source = registered ? rawRecoverableResults.get(params.toolCallId) : undefined;
      const frozen = projectionMode === "stable" ? epoch?.entries.get(params.toolCallId) : undefined;
      if (!registered || !source
        || source.toolName !== registered.toolName
        || source.isError !== registered.isError
        || (projectionMode === "stable" && frozen?.sourceHash !== source.sourceHash)) {
        return {
          content: [{ type: "text" as const, text: `No recoverable result for toolCallId ${JSON.stringify(params.toolCallId)}.` }],
          details: { found: false, sourceToolCallId: params.toolCallId, sourceToolName: "", sourceIsError: false },
        };
      }
      const sourceChars = source.message.content.reduce(
        (length: number, block: any) => length + (block?.type === "text" && typeof block.text === "string" ? block.text.length : 0),
        0,
      );
      activeRecalls++;
      activeRecalledChars += sourceChars;
      const recallUsage = recallsByTool[registered.toolName] ?? { recalls: 0, recalledChars: 0 };
      recallsByTool = {
        ...recallsByTool,
        [registered.toolName]: { recalls: recallUsage.recalls + 1, recalledChars: recallUsage.recalledChars + sourceChars },
      };
      persistTelemetry();
      publishState();
      return {
        content: structuredClone(source.message.content),
        details: { found: true, sourceToolCallId: registered.toolCallId, sourceToolName: registered.toolName, sourceIsError: registered.isError },
      };
    },
  });

  pi.on("session_start", async (event, ctx) => {
    await configQueue;
    restoreTelemetry(ctx);
    requestEpoch(event?.reason === "reload" ? "reload" : event?.reason === "startup" ? "session-start" : "session-replacement");
    refreshRecallTool();
    publishState();
    if (configLoadError)
      ctx.ui.notify(`Could not load pi-sieve settings: ${(configLoadError as any)?.message ?? String(configLoadError)}`, "error");
  });
  pi.on("session_compact", () => requestEpoch("compaction"));
  pi.on("session_tree", (_event, ctx) => {
    restoreTelemetry(ctx);
    requestEpoch("branch-navigation");
    publishState();
  });
  pi.on("model_select", () => requestEpoch("model-change"));
  pi.on("session_shutdown", () => {
    disposeStateRequest();
    pi.events.emit("pi-sieve:state-change", stateSnapshot(false));
    pi.events.emit("pylon:tool-policy", { version: 1, kind: "unregister", owner: "pi-sieve" });
  });

  pi.on("context", (event, ctx) => {
    if (mode === "disabled") return;
    const currentFingerprint = fingerprint(
      pi, ctx, threshold, activePruning, projectionMode, rolloverHighMultiplier, rolloverLowMultiplier,
    );
    if (!epoch || pendingEpochReason) beginEpoch(pendingEpochReason || "session-start", ctx, currentFingerprint);
    else if (epoch.promptFingerprint !== currentFingerprint) beginEpoch("prompt-fingerprint", ctx, currentFingerprint);

    let result = projectionMode === "stable"
      ? stableSieveMessages(event.messages, epoch!, { cwd: ctx?.cwd })
      : sieveMessages(event.messages, threshold, { pruneActive: activePruning, cwd: ctx?.cwd });
    let diagnostics = "diagnostics" in result ? result.diagnostics as ProjectionDiagnostics : undefined;
    if (projectionMode === "stable" && diagnostics?.requiresReflow) {
      // The mismatch is converted into a deliberate epoch boundary before anything is sent.
      stability.earliestChangedPriorMessageIndex ??= diagnostics.earliestChangedMessageIndex;
      stability.estimatedInvalidatedChars += diagnostics.estimatedInvalidatedChars;
      beginEpoch(
        diagnostics.ambiguousReflows > 0 ? "ambiguous-id" : diagnostics.historyMismatches > 0 ? "history-mismatch" : "source-mismatch",
        ctx,
        currentFingerprint,
      );
      const rerun = stableSieveMessages(event.messages, epoch!, { cwd: ctx?.cwd });
      result = rerun;
      diagnostics = rerun.diagnostics;
    }
    if (projectionMode === "stable" && diagnostics?.softBudgetExceeded) {
      if (!softBudgetExceededInEpoch) {
        stability.softBudgetExceedances++;
        softBudgetExceededInEpoch = true;
      }
      const previousMessages = result.messages;
      const previousBudget = retainedProjectionBudget(epoch!);
      const rolloverEpoch = createProjectionEpoch("budget-rollover", {
        threshold, activePruning, rolloverHighMultiplier, rolloverLowMultiplier,
      }, currentFingerprint);
      const rerun = rolloverStableSieveMessages(
        event.messages,
        rolloverEpoch,
        rolloverLowMultiplier * threshold,
        { cwd: ctx?.cwd },
      );
      const rolloverBudget = retainedProjectionBudget(rolloverEpoch);
      if (rolloverBudget < previousBudget && rolloverBudget <= rolloverLowMultiplier * threshold) {
        let changedIndex = 0;
        while (changedIndex < previousMessages.length
          && JSON.stringify(previousMessages[changedIndex]) === JSON.stringify(rerun.messages[changedIndex])) changedIndex++;
        if (changedIndex < previousMessages.length) {
          stability.earliestChangedPriorMessageIndex ??= changedIndex;
          stability.estimatedInvalidatedChars += JSON.stringify(previousMessages.slice(changedIndex)).length;
        }
        epoch = rolloverEpoch;
        recoverableActiveResults.clear();
        rawRecoverableResults.clear();
        softBudgetExceededInEpoch = false;
        stability.automaticRollovers++;
        result = rerun;
        diagnostics = rerun.diagnostics;
      }
    }

    latestMode = mode;
    latestStats = result.stats;
    const usage = typeof ctx?.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
    contextUsagePercent = usage?.percent ?? undefined;
    if (projectionMode === "stable" && diagnostics) {
      stability.newProjections += diagnostics.newProjections;
      stability.projectionCacheHits += diagnostics.cacheHits;
      stability.recoverableEntries = result.recoverableActiveResults.length;
    }
    if (mode === "observe") {
      addTransformStats(cumulativeProjected, result.stats);
      persistTelemetry();
      publishState();
      return;
    }

    addTransformStats(cumulativeActual, result.stats);
    recoverableActiveResults = new Map(result.recoverableActiveResults.map((item) => [item.toolCallId, item]));
    const rawCounts = new Map<string, number>();
    for (const message of event.messages as any[]) {
      if (message?.role === "toolResult" && typeof message.toolCallId === "string" && message.toolCallId)
        rawCounts.set(message.toolCallId, (rawCounts.get(message.toolCallId) ?? 0) + 1);
    }
    rawRecoverableResults = new Map();
    for (let index = 0; index < event.messages.length; index++) {
      const message: any = event.messages[index];
      const registered = message?.role === "toolResult" ? recoverableActiveResults.get(message.toolCallId) : undefined;
      if (!registered || rawCounts.get(message.toolCallId) !== 1) continue;
      rawRecoverableResults.set(message.toolCallId, {
        ...registered,
        sourceHash: projectionSourceHash(event.messages, index, ctx?.cwd),
        message: structuredClone(message),
      });
    }
    persistTelemetry();
    publishState();
    return { messages: result.messages };
  });

  pi.registerCommand("sieve", {
    description: "Configure cache-stable outbound tool-result projections, rollback mode, and recall",
    handler: async (args, ctx) => {
      const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const [action = "status", value] = parts;
      const hasOnlyValue = parts.length === 2;
      const hasNoValue = parts.length === 1;

      if (action === "active" && hasOnlyValue && (value === "enable" || value === "disable")) {
        try {
          await updateConfig({ activePruning: value === "enable" });
        } catch (error: any) {
          ctx.ui.notify(`Could not save pi-sieve active-result setting: ${error?.message ?? String(error)}`, "error");
          return;
        }
        requestEpoch("configuration-change");
        refreshRecallTool();
        publishState();
        ctx.ui.notify(`pi-sieve active-result pruning ${activePruning ? "enabled" : "disabled"}; cached prefix will reset.`, "info");
        return;
      }
      if (action === "projection" && hasOnlyValue && (value === "stable" || value === "standard" || value === "legacy")) {
        const nextProjectionMode: ProjectionMode = value === "standard" ? "legacy" : value;
        try {
          await updateConfig({ projectionMode: nextProjectionMode });
        } catch (error: any) {
          ctx.ui.notify(`Could not save pi-sieve projection mode: ${error?.message ?? String(error)}`, "error");
          return;
        }
        requestEpoch("configuration-change");
        publishState();
        ctx.ui.notify(`pi-sieve projection mode set to ${projectionModeLabel(projectionMode)}; cached prefix will reset.`, "info");
        return;
      }
      if (action === "reflow" && hasNoValue) {
        stability.explicitReflows++;
        requestEpoch("explicit-reflow");
        persistTelemetry();
        publishState();
        ctx.ui.notify("pi-sieve will rebuild projections on the next provider call; cached prefix will reset.", "info");
        return;
      }
      if ((action === "enable" || action === "observe" || action === "disable") && hasNoValue) {
        const nextMode: SieveMode = action === "enable" ? "enabled" : action === "disable" ? "disabled" : "observe";
        if (mode !== nextMode) requestEpoch("configuration-change");
        mode = nextMode;
        if (mode !== "enabled") {
          recoverableActiveResults.clear();
          rawRecoverableResults.clear();
        }
        refreshRecallTool();
        publishState();
        ctx.ui.notify(mode === "observe"
          ? "pi-sieve observing: classifications are reported without changing outbound messages."
          : `pi-sieve ${mode}.`, "info");
        return;
      }
      if (action === "reset-stats" && hasNoValue) {
        resetTelemetry();
        persistTelemetry();
        publishState();
        ctx.ui.notify("pi-sieve statistics reset.", "info");
        return;
      }
      if (action === "rollover" && (parts.length === 3 || hasOnlyValue && value === "reset")) {
        const high = value === "reset" ? DEFAULT_ROLLOVER_HIGH_MULTIPLIER : Number(value);
        const low = value === "reset" ? DEFAULT_ROLLOVER_LOW_MULTIPLIER : Number(parts[2]);
        if (!Number.isSafeInteger(high) || !Number.isSafeInteger(low)
          || low < MIN_ROLLOVER_MULTIPLIER || high > MAX_ROLLOVER_MULTIPLIER || high <= low) {
          ctx.ui.notify(`Rollover multipliers must be integers from ${MIN_ROLLOVER_MULTIPLIER} to ${MAX_ROLLOVER_MULTIPLIER}, with high greater than low.`, "info");
          return;
        }
        try {
          await updateConfig({ rolloverHighMultiplier: high, rolloverLowMultiplier: low });
        } catch (error: any) {
          ctx.ui.notify(`Could not save pi-sieve rollover settings: ${error?.message ?? String(error)}`, "error");
          return;
        }
        requestEpoch("configuration-change");
        publishState();
        ctx.ui.notify(`pi-sieve rollover ${value === "reset" ? "reset" : "set"} to ${high}T → ${low}T; cached prefix will reset.`, "info");
        return;
      }
      if (action === "threshold" && hasOnlyValue && (value === "reset" || /^\d+$/.test(value))) {
        const candidate = value === "reset" ? SIEVE_THRESHOLD : Number(value);
        if (!Number.isSafeInteger(candidate) || candidate < MIN_SIEVE_THRESHOLD || candidate > MAX_SIEVE_THRESHOLD) {
          ctx.ui.notify(`Threshold must be an integer from ${MIN_SIEVE_THRESHOLD} to ${MAX_SIEVE_THRESHOLD}.`, "info");
          return;
        }
        try {
          await updateConfig({ threshold: candidate });
        } catch (error: any) {
          ctx.ui.notify(`Could not save pi-sieve threshold: ${error?.message ?? String(error)}`, "error");
          return;
        }
        requestEpoch("configuration-change");
        publishState();
        ctx.ui.notify(`pi-sieve threshold ${value === "reset" ? "reset" : "set"} to ${threshold}; cached prefix will reset.`, "info");
        return;
      }
      if (action === "status" && hasNoValue) {
        ctx.ui.notify(statusText(
          mode, projectionMode, threshold, latestMode, latestStats, cumulativeActual, cumulativeProjected,
          activePruning, activeRecalls, activeRecalledChars,
          rolloverHighMultiplier, rolloverLowMultiplier, epoch, stability,
        ), "info");
        return;
      }
      ctx.ui.notify("Usage: /sieve enable|observe|disable|status|projection <standard|stable>|reflow|rollover <high low|reset>|active <enable|disable>|threshold <1000-50000|reset>|reset-stats", "info");
    },
  });
}
