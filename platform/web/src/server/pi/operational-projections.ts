import type {
  ContinuityReadModel,
  GuardReadModel,
  JobsReadModel,
  OperationalReadModel,
  PapercutSummaryReadModel,
  SieveReadModel,
  SieveTransformStatsReadModel,
  TimelineReadModel,
  ToolPolicyReadModel,
  ToolsReadModel,
  VerificationReadModel,
} from "../../shared/protocol/events.ts";
import type { RuntimeDiagnostic } from "../../shared/protocol/snapshots.ts";

const verificationStates = new Set([
  "running",
  "passed",
  "failed",
  "cancelled",
  "stale",
  "error",
  "no_checks",
  "clean",
]);
const jobStates = new Set(["running", "cancelling", "completed", "failed", "cancelled", "timed_out"]);
const todoStates = new Set(["pending", "in_progress", "done", "blocked"]);
const workModes = new Set(["planning", "executing", "handed_off", "completed", "cancelled"]);
const idPattern = /^[A-Za-z0-9._:@/-]+$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
function string(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, maximum) : undefined;
}
function timestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  const text = string(value, 64);
  return text && !Number.isNaN(Date.parse(text)) ? text : undefined;
}
function identifier(value: unknown): string | undefined {
  const item = string(value, 128);
  return item && idPattern.test(item) ? item : undefined;
}
function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function stringList(value: unknown, maximum = 100): string[] | undefined {
  if (!Array.isArray(value) || !value.every(item => typeof item === "string" && item.length > 0)) return undefined;
  return [...new Set(value.slice(0, maximum).map(item => item.slice(0, 200)))];
}

export function initialOperational(
  availableTools: Iterable<string>,
  loadedExtensions: Iterable<string>,
  diagnostics: RuntimeDiagnostic[] = [],
): OperationalReadModel {
  const tools = new Set(availableTools);
  const loaded = new Set(loadedExtensions);
  const operational: OperationalReadModel = {
    verification: { availability: tools.has("verify") ? "available" : "unavailable", checks: [] },
    jobs: { availability: tools.has("heartbeat_start") ? "available" : "unavailable", items: [] },
    guard: { availability: loaded.has("pi-guard.ts") ? "available" : "unavailable", blocked: 0, confirmed: 0 },
    continuity: { availability: "unavailable", revision: 0, memory: [], globalMemory: [], v4MigrationAvailable: false },
    papercuts: { availability: "unavailable", revision: 0, counts: { open: 0, resolved: 0, dismissed: 0, total: 0 } },
    timeline: { availability: "unavailable", revision: 0, checkpoints: [], failures: [] },
    tools: { availability: loaded.has("pylon-core.ts") ? "available" : "unavailable", policies: [] },
    sieve: { availability: loaded.has("pi-sieve.ts") ? "available" : "unavailable" },
    health: { status: "healthy", issues: [] },
  };
  return withHealth(operational, diagnostics);
}

export function withOperationalCapabilities(
  current: OperationalReadModel,
  availableTools: Iterable<string>,
  loadedExtensions: Iterable<string>,
  diagnostics: RuntimeDiagnostic[] = [],
): OperationalReadModel {
  const fresh = initialOperational(availableTools, loadedExtensions, diagnostics);
  const next: OperationalReadModel = {
    verification:
      current.verification.state || current.verification.checks.length
        ? { ...current.verification, availability: fresh.verification.availability }
        : fresh.verification,
    jobs: current.jobs.items.length ? { ...current.jobs, availability: fresh.jobs.availability } : fresh.jobs,
    guard: current.guard.decision
      ? { ...current.guard, availability: fresh.guard.availability }
      : { ...fresh.guard, blocked: current.guard.blocked, confirmed: current.guard.confirmed },
    continuity: current.continuity.revision ? current.continuity : fresh.continuity,
    papercuts: current.papercuts.revision ? current.papercuts : fresh.papercuts,
    timeline: current.timeline.revision ? current.timeline : fresh.timeline,
    tools: current.tools.policies.length ? { ...current.tools, availability: fresh.tools.availability } : fresh.tools,
    sieve: current.sieve.mode ? { ...current.sieve, availability: fresh.sieve.availability } : fresh.sieve,
    health: fresh.health,
  };
  return withHealth(next, diagnostics);
}

export function cloneOperational(value: OperationalReadModel): OperationalReadModel {
  return {
    verification: { ...value.verification, checks: value.verification.checks.map(item => ({ ...item })) },
    jobs: { ...value.jobs, items: value.jobs.items.map(item => ({ ...item })) },
    guard: { ...value.guard },
    continuity: {
      ...value.continuity,
      memory: value.continuity.memory.map(note => ({
        ...note,
        relatedPaths: note.relatedPaths ? [...note.relatedPaths] : undefined,
      })),
      globalMemory: value.continuity.globalMemory.map(note => ({
        ...note,
        relatedPaths: note.relatedPaths ? [...note.relatedPaths] : undefined,
      })),
      work: value.continuity.work
        ? { ...value.continuity.work, todos: value.continuity.work.todos.map(item => ({ ...item })) }
        : undefined,
    },
    papercuts: { ...value.papercuts, counts: { ...value.papercuts.counts } },
    timeline: {
      ...value.timeline,
      checkpoints: value.timeline.checkpoints.map(item => ({ ...item })),
      failures: (value.timeline.failures ?? []).map(item => ({ ...item })),
    },
    tools: {
      ...value.tools,
      policies: value.tools.policies.map(item => ({
        ...item,
        managedTools: [...item.managedTools],
        enabledTools: [...item.enabledTools],
        deferredTools: [...item.deferredTools],
        allowOnly: item.allowOnly ? [...item.allowOnly] : undefined,
      })),
    },
    sieve: {
      ...value.sieve,
      latest: value.sieve.latest ? cloneSieveStats(value.sieve.latest) : undefined,
      cumulativeActual: value.sieve.cumulativeActual ? cloneSieveStats(value.sieve.cumulativeActual) : undefined,
      cumulativeProjected: value.sieve.cumulativeProjected
        ? cloneSieveStats(value.sieve.cumulativeProjected)
        : undefined,
      recallsByTool: value.sieve.recallsByTool
        ? Object.fromEntries(Object.entries(value.sieve.recallsByTool).map(([name, usage]) => [name, { ...usage }]))
        : undefined,
      epoch: value.sieve.epoch ? { ...value.sieve.epoch } : undefined,
      stability: value.sieve.stability
        ? {
            ...value.sieve.stability,
            standardChangesByKind: value.sieve.stability.standardChangesByKind
              ? { ...value.sieve.stability.standardChangesByKind }
              : undefined,
          }
        : undefined,
    },
    health: { ...value.health, issues: [...value.health.issues] },
  };
}

export function applyOperationalEvent(
  current: OperationalReadModel,
  channel: string,
  value: unknown,
  diagnostics: RuntimeDiagnostic[] = [],
  expectedSessionId?: string,
  redact: (value: string) => string = value => value,
): OperationalReadModel {
  let next: OperationalReadModel;
  if (channel === "pi-verify:lifecycle" || channel === "pi-verify:result") {
    const verificationState = verification(value, redact);
    next = { ...current, verification: verificationState };
  } else if (channel === "pi-heartbeat:job") {
    const jobState = jobs(current.jobs, value);
    next = { ...current, jobs: jobState };
  } else if (channel === "pi-guard:decision") {
    const guardState = guard(current.guard, value);
    next = { ...current, guard: guardState };
  } else if (channel === "pi-continuity:state-change") {
    const continuityState = continuity(current.continuity, value, expectedSessionId);
    if (continuityState === current.continuity) return current;
    next = { ...current, continuity: continuityState };
  } else if (channel === "pi-papercut:state-change") {
    const papercutState = papercuts(current.papercuts, value, expectedSessionId);
    if (papercutState === current.papercuts) return current;
    next = { ...current, papercuts: papercutState };
  } else if (channel === "pi-timeline:state-change") {
    const timelineState = timeline(current.timeline, value, expectedSessionId);
    if (timelineState === current.timeline) return current;
    next = { ...current, timeline: timelineState };
  } else if (channel === "pylon:tool-policy") {
    const toolsState = toolPolicy(current.tools, value);
    next = { ...current, tools: toolsState };
  } else if (channel === "pi-sieve:state-change") {
    const sieveState = sieve(current.sieve, value);
    if (sieveState === current.sieve) return current;
    next = { ...current, sieve: sieveState };
  } else return current;
  return withHealth(next, diagnostics);
}

function sieveStats(value: unknown): SieveTransformStatsReadModel | undefined {
  const input = record(value);
  const transformedBy = record(input?.transformedBy);
  const rawByTool = record(input?.byTool);
  if (!input || !transformedBy || !rawByTool || Object.keys(rawByTool).length > 33) return undefined;
  const keys = ["scanned", "transformed", "omittedChars", "netCharsSaved"] as const;
  const reasons = [
    "ageThreshold",
    "budget",
    "activeThreshold",
    "staleRead",
    "duplicate",
    "errorCap",
    "mixedText",
  ] as const;
  if (
    !keys.every(key => Number.isSafeInteger(input[key]) && Number(input[key]) >= 0) ||
    !reasons.every(key => Number.isSafeInteger(transformedBy[key]) && Number(transformedBy[key]) >= 0)
  )
    return undefined;
  const byTool: SieveTransformStatsReadModel["byTool"] = {};
  for (const [name, rawUsage] of Object.entries(rawByTool)) {
    const usage = record(rawUsage);
    if (
      !/^[a-zA-Z0-9_-]{1,64}$/.test(name) ||
      !usage ||
      !["scanned", "transformed", "sourceChars", "retainedChars", "netCharsSaved"].every(
        key => Number.isSafeInteger(usage[key]) && Number(usage[key]) >= 0,
      )
    )
      return undefined;
    byTool[name] = {
      scanned: number(usage.scanned),
      transformed: number(usage.transformed),
      sourceChars: number(usage.sourceChars),
      retainedChars: number(usage.retainedChars),
      netCharsSaved: number(usage.netCharsSaved),
    };
  }
  return {
    scanned: number(input.scanned),
    transformed: number(input.transformed),
    omittedChars: number(input.omittedChars),
    netCharsSaved: number(input.netCharsSaved),
    transformedBy: {
      ageThreshold: number(transformedBy.ageThreshold),
      budget: number(transformedBy.budget),
      activeThreshold: number(transformedBy.activeThreshold),
      staleRead: number(transformedBy.staleRead),
      duplicate: number(transformedBy.duplicate),
      errorCap: number(transformedBy.errorCap),
      mixedText: number(transformedBy.mixedText),
    },
    byTool,
  };
}

function cloneSieveStats(value: SieveTransformStatsReadModel): SieveTransformStatsReadModel {
  return {
    ...value,
    transformedBy: { ...value.transformedBy },
    byTool: Object.fromEntries(Object.entries(value.byTool).map(([name, usage]) => [name, { ...usage }])),
  };
}

function sieveRecallStats(value: unknown): NonNullable<SieveReadModel["recallsByTool"]> | undefined {
  const input = record(value);
  if (!input || Object.keys(input).length > 33) return undefined;
  const output: NonNullable<SieveReadModel["recallsByTool"]> = {};
  for (const [name, rawUsage] of Object.entries(input)) {
    const usage = record(rawUsage);
    if (
      !/^[a-zA-Z0-9_-]{1,64}$/.test(name) ||
      !usage ||
      !Number.isSafeInteger(usage.recalls) ||
      Number(usage.recalls) < 0 ||
      !Number.isSafeInteger(usage.recalledChars) ||
      Number(usage.recalledChars) < 0
    )
      return undefined;
    output[name] = { recalls: Number(usage.recalls), recalledChars: Number(usage.recalledChars) };
  }
  return output;
}

function sieveEpoch(value: unknown): SieveReadModel["epoch"] | undefined {
  const input = record(value);
  const metrics = [
    "frozenResultCount",
    "frozenSourceChars",
    "frozenRetainedChars",
    "rolloverEligibleRetainedChars",
    "recoverableEntries",
  ];
  if (!input || !metrics.every(key => Number.isSafeInteger(input[key]) && Number(input[key]) >= 0)) return undefined;
  const startedAt = input.startedAt === undefined ? undefined : timestamp(input.startedAt);
  if (input.startedAt !== undefined && !startedAt) return undefined;
  return {
    ...(string(input.id, 200) ? { id: string(input.id, 200) } : {}),
    ...(string(input.reason, 200) ? { reason: string(input.reason, 200) } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(string(input.promptFingerprint, 200) ? { promptFingerprint: string(input.promptFingerprint, 200) } : {}),
    frozenResultCount: Number(input.frozenResultCount),
    frozenSourceChars: Number(input.frozenSourceChars),
    frozenRetainedChars: Number(input.frozenRetainedChars),
    rolloverEligibleRetainedChars: Number(input.rolloverEligibleRetainedChars),
    recoverableEntries: Number(input.recoverableEntries),
  };
}

function sieveStability(value: unknown): SieveReadModel["stability"] | undefined {
  const input = record(value);
  const metrics = [
    "newProjections",
    "projectionCacheHits",
    "recoverableEntries",
    "explicitReflows",
    "softBudgetExceedances",
    "prefixChurnViolations",
    "estimatedInvalidatedChars",
  ];
  const standardChangeKinds = [
    "activeThreshold",
    "ageThreshold",
    "budget",
    "staleRead",
    "duplicate",
    "errorCap",
    "history",
  ] as const;
  const standardChangesByKind = record(input?.standardChangesByKind);
  if (
    !input ||
    !metrics.every(key => Number.isSafeInteger(input[key]) && Number(input[key]) >= 0) ||
    (input.earliestChangedPriorMessageIndex !== undefined &&
      (!Number.isSafeInteger(input.earliestChangedPriorMessageIndex) ||
        Number(input.earliestChangedPriorMessageIndex) < 0)) ||
    (input.standardComparisons !== undefined &&
      (!Number.isSafeInteger(input.standardComparisons) || Number(input.standardComparisons) < 0)) ||
    (input.standardPrefixChurn !== undefined &&
      (!Number.isSafeInteger(input.standardPrefixChurn) || Number(input.standardPrefixChurn) < 0)) ||
    (input.standardEarliestChangedPriorMessageIndex !== undefined &&
      (!Number.isSafeInteger(input.standardEarliestChangedPriorMessageIndex) ||
        Number(input.standardEarliestChangedPriorMessageIndex) < 0)) ||
    (input.standardEstimatedInvalidatedChars !== undefined &&
      (!Number.isSafeInteger(input.standardEstimatedInvalidatedChars) ||
        Number(input.standardEstimatedInvalidatedChars) < 0)) ||
    (input.standardChangesByKind !== undefined &&
      (!standardChangesByKind ||
        !standardChangeKinds.every(
          key => Number.isSafeInteger(standardChangesByKind[key]) && Number(standardChangesByKind[key]) >= 0,
        )))
  )
    return undefined;
  return {
    newProjections: Number(input.newProjections),
    projectionCacheHits: Number(input.projectionCacheHits),
    recoverableEntries: Number(input.recoverableEntries),
    explicitReflows: Number(input.explicitReflows),
    softBudgetExceedances: Number(input.softBudgetExceedances),
    prefixChurnViolations: Number(input.prefixChurnViolations),
    estimatedInvalidatedChars: Number(input.estimatedInvalidatedChars),
    ...(input.earliestChangedPriorMessageIndex !== undefined
      ? { earliestChangedPriorMessageIndex: Number(input.earliestChangedPriorMessageIndex) }
      : {}),
    ...(input.standardComparisons !== undefined ? { standardComparisons: Number(input.standardComparisons) } : {}),
    ...(input.standardPrefixChurn !== undefined ? { standardPrefixChurn: Number(input.standardPrefixChurn) } : {}),
    ...(input.standardEarliestChangedPriorMessageIndex !== undefined
      ? { standardEarliestChangedPriorMessageIndex: Number(input.standardEarliestChangedPriorMessageIndex) }
      : {}),
    ...(input.standardEstimatedInvalidatedChars !== undefined
      ? { standardEstimatedInvalidatedChars: Number(input.standardEstimatedInvalidatedChars) }
      : {}),
    ...(standardChangesByKind
      ? {
          standardChangesByKind: {
            activeThreshold: Number(standardChangesByKind.activeThreshold),
            ageThreshold: Number(standardChangesByKind.ageThreshold),
            budget: Number(standardChangesByKind.budget),
            staleRead: Number(standardChangesByKind.staleRead),
            duplicate: Number(standardChangesByKind.duplicate),
            errorCap: Number(standardChangesByKind.errorCap),
            history: Number(standardChangesByKind.history),
          },
        }
      : {}),
  };
}

function sieve(old: SieveReadModel, value: unknown): SieveReadModel {
  const input = record(value);
  if (!input || input.version !== 1) return old;
  if (input.available === false) return { availability: "unavailable" };
  const latest = sieveStats(input.latest);
  const cumulativeActual = sieveStats(input.cumulativeActual);
  const cumulativeProjected = sieveStats(input.cumulativeProjected);
  const updatedAt = timestamp(input.updatedAt);
  const recallsByTool = sieveRecallStats(input.recallsByTool);
  const epoch = input.epoch === undefined ? undefined : sieveEpoch(input.epoch);
  const stability = input.stability === undefined ? undefined : sieveStability(input.stability);
  const contextUsagePercent = input.contextUsagePercent;
  if (
    input.available !== true ||
    !["stable", "legacy", "standard-v2"].includes(String(input.projectionMode)) ||
    (input.epoch !== undefined && !epoch) ||
    (input.stability !== undefined && !stability) ||
    (contextUsagePercent !== undefined &&
      (typeof contextUsagePercent !== "number" ||
        !Number.isFinite(contextUsagePercent) ||
        contextUsagePercent < 0 ||
        contextUsagePercent > 100)) ||
    !["enabled", "observe", "disabled"].includes(String(input.mode)) ||
    !["enabled", "observe"].includes(String(input.latestMode)) ||
    !Number.isSafeInteger(input.threshold) ||
    Number(input.threshold) < 1_000 ||
    typeof input.activePruning !== "boolean" ||
    !Number.isSafeInteger(input.recalls) ||
    Number(input.recalls) < 0 ||
    !Number.isSafeInteger(input.recalledChars) ||
    Number(input.recalledChars) < 0 ||
    !latest ||
    !cumulativeActual ||
    !cumulativeProjected ||
    !recallsByTool ||
    !updatedAt
  ) {
    return { availability: "unavailable", error: "Pi Sieve returned invalid state." };
  }
  return {
    availability: "available",
    mode: input.mode as NonNullable<SieveReadModel["mode"]>,
    projectionMode: input.projectionMode as NonNullable<SieveReadModel["projectionMode"]>,
    threshold: input.threshold as number,
    activePruning: input.activePruning,
    latestMode: input.latestMode as NonNullable<SieveReadModel["latestMode"]>,
    latest,
    cumulativeActual,
    cumulativeProjected,
    recalls: Number(input.recalls),
    recalledChars: Number(input.recalledChars),
    recallsByTool,
    ...(epoch ? { epoch } : {}),
    ...(stability ? { stability } : {}),
    ...(contextUsagePercent !== undefined ? { contextUsagePercent } : {}),
    updatedAt,
    ...(string(input.error, 500) ? { error: string(input.error, 500) } : {}),
  };
}

function verification(value: unknown, redact: (value: string) => string): VerificationReadModel {
  const input = record(value);
  if (!input || input.version !== 1 || !verificationStates.has(String(input.state)))
    return { availability: "unavailable", checks: [] };
  const rawActiveChecks = Array.isArray(input.activeChecks) ? input.activeChecks : [];
  const activeChecks = rawActiveChecks.slice(0, 20).flatMap((value, index) => {
    const item = record(value);
    if (!item) return [];
    const id = identifier(item.id) ?? `active-check-${index + 1}`;
    const label = string(item.label, 200) ?? id;
    const command = redact(string(item.command, 500) ?? "").slice(0, 500);
    return [{ id, label, command, status: "running" as const, durationMs: 0, truncated: false }];
  });
  const rawResults = Array.isArray(input.results) ? input.results : [];
  let outputBudget = 16 * 1024;
  const checks = rawResults.slice(0, 20 - activeChecks.length).flatMap((value, index) => {
    const item = record(value);
    if (!item) return [];
    const id = identifier(item.id) ?? `check-${index + 1}`;
    const label = string(item.label, 200) ?? id;
    const command = redact(string(item.command, 500) ?? "").slice(0, 500);
    const code = item.code === null ? null : number(item.code, Number.NaN);
    const rawOutput = string(item.output, Math.min(8 * 1024, outputBudget));
    const safeOutput = rawOutput ? redact(rawOutput).slice(0, Math.min(8 * 1024, outputBudget)) : undefined;
    if (safeOutput) outputBudget -= safeOutput.length;
    return [
      {
        id,
        label,
        command,
        status:
          code === 0
            ? ("passed" as const)
            : code === null || !Number.isFinite(code)
              ? ("error" as const)
              : ("failed" as const),
        durationMs: Math.max(0, number(item.durationMs)),
        ...(safeOutput ? { output: safeOutput } : {}),
        truncated: item.truncated === true || outputBudget <= 0,
      },
    ];
  });
  return {
    availability: "available",
    state: input.state as VerificationReadModel["state"],
    ...(identifier(input.runId) ? { runId: identifier(input.runId) } : {}),
    ...(input.scope === "changed" || input.scope === "project" ? { scope: input.scope } : {}),
    ...(string(input.startedAt, 64) ? { startedAt: string(input.startedAt, 64) } : {}),
    ...(string(input.finishedAt, 64) ? { finishedAt: string(input.finishedAt, 64) } : {}),
    ...(typeof input.durationMs === "number" ? { durationMs: Math.max(0, number(input.durationMs)) } : {}),
    checks: [...activeChecks, ...checks],
    ...(string(input.skipped, 1_000) ? { message: string(input.skipped, 1_000) } : {}),
  };
}

function jobs(old: JobsReadModel, value: unknown): JobsReadModel {
  const input = record(value);
  const startedAt = timestamp(input?.startedAt);
  if (!input || input.version !== 1 || !identifier(input.id) || !jobStates.has(String(input.state)) || !startedAt)
    return { availability: "unavailable", items: [] };
  const item = {
    id: identifier(input.id)!,
    label: string(input.label, 120) ?? identifier(input.id)!,
    state: input.state as JobsReadModel["items"][number]["state"],
    startedAt,
    ...(timestamp(input.finishedAt) ? { finishedAt: timestamp(input.finishedAt) } : {}),
    ...(typeof input.exitCode === "number" || input.exitCode === null
      ? { exitCode: input.exitCode as number | null }
      : {}),
    ...(input.purpose === "verification" || input.purpose === "build" || input.purpose === "other"
      ? { purpose: input.purpose as "verification" | "build" | "other" }
      : {}),
    ...(identifier(input.todoId) ? { todoId: identifier(input.todoId) } : {}),
  };
  return { availability: "available", items: [...old.items.filter(old => old.id !== item.id), item].slice(-50) };
}

function guard(old: GuardReadModel, value: unknown): GuardReadModel {
  const input = record(value);
  if (!input || input.version !== 1 || typeof input.decision !== "string")
    return { availability: "unavailable", blocked: old.blocked, confirmed: old.confirmed };
  return {
    availability: "available",
    decision: input.decision.slice(0, 100),
    reason: string(input.reason, 500),
    blocked: Math.max(0, number(input.blocked)),
    confirmed: Math.max(0, number(input.confirmed)),
  };
}

function papercuts(
  old: PapercutSummaryReadModel,
  value: unknown,
  expectedSessionId?: string,
): PapercutSummaryReadModel {
  const input = record(value);
  if (
    !input ||
    input.version !== 1 ||
    (expectedSessionId && input.sessionId !== expectedSessionId) ||
    !Number.isSafeInteger(input.revision) ||
    (input.revision as number) <= old.revision
  )
    return input?.version === 1 ? old : { ...old, availability: "unavailable" };
  const rawCounts = record(input.counts);
  const values = rawCounts && ["open", "resolved", "dismissed", "total"].map(key => rawCounts[key]);
  if (
    !values ||
    !values.every(item => Number.isSafeInteger(item) && Number(item) >= 0 && Number(item) <= 1_000) ||
    Number(values[0]) + Number(values[1]) + Number(values[2]) !== Number(values[3])
  )
    return old;
  const counts = {
    open: Number(values[0]),
    resolved: Number(values[1]),
    dismissed: Number(values[2]),
    total: Number(values[3]),
  };
  return {
    availability: input.available === true ? "available" : "unavailable",
    revision: input.revision as number,
    counts,
  };
}

function continuity(old: ContinuityReadModel, value: unknown, expectedSessionId?: string): ContinuityReadModel {
  const input = record(value);
  if (
    !input ||
    input.version !== 4 ||
    (expectedSessionId && input.sessionId !== expectedSessionId) ||
    !Number.isSafeInteger(input.revision) ||
    (input.revision as number) <= old.revision
  )
    return input?.version === 4
      ? old
      : {
          availability: "unavailable",
          revision: old.revision,
          memory: old.memory,
          globalMemory: old.globalMemory,
          v4MigrationAvailable: false,
        };
  if (input.available !== true)
    return {
      availability: "unavailable",
      revision: input.revision as number,
      memory: [],
      globalMemory: [],
      v4MigrationAvailable: false,
    };
  const scopes = new Set(["user", "project"]),
    authorities = new Set(["user_instruction", "project_contract", "imported"]),
    origins = new Set(["user", "agent", "migration"]);
  const dispositions = new Set([
      "archival",
      "eligible_advisory",
      "eligible_enforced",
      "quarantined",
      "superseded",
      "revoked",
    ]),
    enforcementAuthorities = new Set(["context_only", "warning", "validation", "blocking_guard"]);
  const safePath = (value: unknown) =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 240 &&
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !/^[a-z]:/i.test(value) &&
    !value.split(/[\\/]+/).some(part => !part || part === "." || part === "..");
  const parseMemory = (value: unknown, expectedScope: "user" | "project") => {
    if (!Array.isArray(value) || value.length > 1_000) return;
    const output: ContinuityReadModel["memory"] = [];
    for (const raw of value) {
      const note = record(raw),
        id = string(note?.id, 128),
        trigger = string(note?.trigger, 240),
        guidance = string(note?.guidance, 800);
      const sourceSummary =
          typeof note?.sourceSummary === "string" && note.sourceSummary.length <= 500 ? note.sourceSummary : undefined,
        updatedAt = timestamp(note?.updatedAt);
      if (
        !note ||
        !id ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
        note.scope !== expectedScope ||
        !trigger ||
        trigger !== trigger.trim() ||
        !guidance ||
        guidance !== guidance.trim() ||
        trigger.length + guidance.length > 1_000 ||
        sourceSummary === undefined ||
        !updatedAt ||
        !scopes.has(String(note.scope)) ||
        !authorities.has(String(note.authority)) ||
        !origins.has(String(note.origin)) ||
        (note.disposition !== undefined && !dispositions.has(String(note.disposition))) ||
        (note.enforcementAuthority !== undefined && !enforcementAuthorities.has(String(note.enforcementAuthority))) ||
        !Number.isSafeInteger(note.revision) ||
        Number(note.revision) < 1 ||
        (note.relatedPaths !== undefined &&
          (!Array.isArray(note.relatedPaths) || note.relatedPaths.length > 5 || !note.relatedPaths.every(safePath)))
      )
        return;
      output.push({
        id,
        scope: expectedScope,
        trigger,
        guidance,
        authority: note.authority as "user_instruction" | "project_contract" | "imported",
        origin: note.origin as "user" | "agent" | "migration",
        revision: Number(note.revision),
        updatedAt,
        sourceSummary,
        ...(note.disposition !== undefined
          ? { disposition: note.disposition as NonNullable<ContinuityReadModel["memory"][number]["disposition"]> }
          : {}),
        ...(note.enforcementAuthority !== undefined
          ? {
              enforcementAuthority: note.enforcementAuthority as NonNullable<
                ContinuityReadModel["memory"][number]["enforcementAuthority"]
              >,
            }
          : {}),
        ...(note.relatedPaths?.length ? { relatedPaths: [...note.relatedPaths] as string[] } : {}),
      });
    }
    return output;
  };
  const memory = parseMemory(input.memory, "project"),
    globalMemory = parseMemory(input.globalMemory, "user");
  if (!memory || !globalMemory)
    return {
      availability: "unavailable",
      revision: input.revision as number,
      memory: [],
      globalMemory: [],
      v4MigrationAvailable: false,
    };
  const v4MigrationAvailable = input.v4MigrationAvailable === true;
  const work = record(input.work);
  if (!work)
    return {
      availability: "available",
      revision: input.revision as number,
      memory,
      globalMemory,
      v4MigrationAvailable,
    };
  if (
    !workModes.has(String(work.mode)) ||
    typeof work.goal !== "string" ||
    typeof work.approved !== "boolean" ||
    typeof work.planSummary !== "string" ||
    !Array.isArray(work.todos)
  )
    return {
      availability: "unavailable",
      revision: input.revision as number,
      memory,
      globalMemory,
      v4MigrationAvailable,
    };
  const todos = work.todos.slice(0, 12).flatMap(value => {
    const item = record(value);
    const id = identifier(item?.id);
    const text = string(item?.text, 500);
    if (!item || !id || !text || !todoStates.has(String(item.status)) || typeof item.updatedAt !== "string") return [];
    return [
      {
        id,
        text,
        status: item.status as "pending" | "in_progress" | "done" | "blocked",
        updatedAt: item.updatedAt.slice(0, 64),
      },
    ];
  });
  const boundedList = (value: unknown, maxItems: number, maxLength: number) =>
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every(item => typeof item === "string" && item.length > 0 && item.length <= maxLength)
      ? (value as string[])
      : undefined;
  const rawHandoff = record(work.handoff);
  const workingSet = rawHandoff ? boundedList(rawHandoff.workingSet, 20, 240) : undefined;
  const assumptions = rawHandoff ? boundedList(rawHandoff.assumptions, 12, 500) : undefined;
  const acceptanceCriteria = rawHandoff ? boundedList(rawHandoff.acceptanceCriteria, 12, 500) : undefined;
  if (rawHandoff && (!workingSet || !assumptions || !acceptanceCriteria))
    return {
      availability: "unavailable",
      revision: input.revision as number,
      memory,
      globalMemory,
      v4MigrationAvailable,
    };
  const rawFeedback = record(work.revisionFeedback);
  const feedbackText = rawFeedback ? string(rawFeedback.text, 1_000) : undefined;
  const feedbackCreatedAt = rawFeedback ? timestamp(rawFeedback.createdAt) : undefined;
  const revisionFeedback =
    rawFeedback &&
    Number.isSafeInteger(rawFeedback.revision) &&
    Number(rawFeedback.revision) > 0 &&
    feedbackText &&
    feedbackCreatedAt
      ? { revision: Number(rawFeedback.revision), text: feedbackText, createdAt: feedbackCreatedAt }
      : undefined;
  if (rawFeedback && !revisionFeedback)
    return {
      availability: "unavailable",
      revision: input.revision as number,
      memory,
      globalMemory,
      v4MigrationAvailable,
    };
  const planRevision =
    Number.isSafeInteger(work.planRevision) && Number(work.planRevision) > 0 ? Number(work.planRevision) : undefined;
  return {
    availability: "available",
    revision: input.revision as number,
    memory,
    globalMemory,
    v4MigrationAvailable,
    work: {
      mode: work.mode as NonNullable<ContinuityReadModel["work"]>["mode"],
      goal: work.goal.slice(0, 2_000),
      approved: work.approved,
      approvalPending: work.approvalPending === true,
      planSummary: work.planSummary.slice(0, 4_000),
      todos,
      ...(rawHandoff
        ? {
            handoff: {
              workingSet: [...workingSet!],
              assumptions: [...assumptions!],
              acceptanceCriteria: [...acceptanceCriteria!],
            },
          }
        : {}),
      ...(planRevision ? { planRevision } : {}),
      ...(revisionFeedback ? { revisionFeedback } : {}),
      ...(identifier(work.currentTodoId) ? { currentTodoId: identifier(work.currentTodoId) } : {}),
      ...(string(work.latestFailure, 1_000) ? { latestFailure: string(work.latestFailure, 1_000) } : {}),
      ...(string(work.nextAction, 1_000) ? { nextAction: string(work.nextAction, 1_000) } : {}),
      ...(identifier(work.runId) ? { runId: identifier(work.runId) } : {}),
      createdAt: string(work.createdAt, 64) ?? "",
      updatedAt: string(work.updatedAt, 64) ?? "",
      ...(string(work.completedAt, 64) ? { completedAt: string(work.completedAt, 64) } : {}),
    },
  };
}

function timeline(old: TimelineReadModel, value: unknown, expectedSessionId?: string): TimelineReadModel {
  const input = record(value);
  if (
    !input ||
    input.version !== 4 ||
    (expectedSessionId && input.sessionId !== expectedSessionId) ||
    !Number.isSafeInteger(input.revision) ||
    (input.revision as number) <= old.revision
  )
    return input?.version === 4
      ? old
      : { availability: "unavailable", revision: old.revision, checkpoints: [], failures: [] };
  if (input.available !== true)
    return { availability: "unavailable", revision: input.revision as number, checkpoints: [], failures: [] };
  if (!Array.isArray(input.checkpoints))
    return { availability: "unavailable", revision: input.revision as number, checkpoints: [], failures: [] };
  const checkpoints = input.checkpoints.slice(-100).flatMap(value => {
    const item = record(value);
    const id = identifier(item?.id);
    const promptEntryId = identifier(item?.promptEntryId);
    const title = string(item?.title, 500);
    const ownerSessionId = identifier(item?.ownerSessionId);
    const createdAt = string(item?.createdAt, 64);
    if (!item || !id || !promptEntryId || !title || !ownerSessionId || !createdAt) return [];
    const verificationState: "passed" | "failed" | "unverified" =
      item.verificationState === "passed" || item.verificationState === "failed"
        ? item.verificationState
        : item.verified === true
          ? "passed"
          : "unverified";
    const changes = record(item.changes);
    const boundedChanges =
      changes &&
      ["fileCount", "additions", "deletions", "binaryCount"].every(
        key => Number.isSafeInteger(changes[key]) && (changes[key] as number) >= 0,
      )
        ? {
            fileCount: Math.min(10_000, changes.fileCount as number),
            additions: changes.additions as number,
            deletions: changes.deletions as number,
            binaryCount: Math.min(10_000, changes.binaryCount as number),
          }
        : undefined;
    return [
      {
        id,
        promptEntryId,
        title,
        ownerSessionId,
        createdAt,
        verified: verificationState === "passed",
        verificationState,
        ...(string(item.branch, 200) ? { branch: string(item.branch, 200) } : {}),
        ...(boundedChanges ? { changes: boundedChanges } : {}),
      },
    ];
  });
  const failures = (Array.isArray(input.failures) ? input.failures : []).slice(-20).flatMap(value => {
    const item = record(value);
    const id = identifier(item?.id);
    const promptEntryId = identifier(item?.promptEntryId);
    const title = string(item?.title, 500);
    const createdAt = string(item?.createdAt, 64);
    const reason = string(item?.reason, 500);
    return item && id && promptEntryId && title && createdAt && reason
      ? [{ id, promptEntryId, title, createdAt, reason }]
      : [];
  });
  return { availability: "available", revision: input.revision as number, checkpoints, failures };
}

function toolPolicy(old: ToolsReadModel, value: unknown): ToolsReadModel {
  const input = record(value);
  const owner = identifier(input?.owner);
  if (!input || input.version !== 1 || !owner) return { availability: "unavailable", policies: old.policies };
  if (input.kind === "unregister")
    return { availability: "available", policies: old.policies.filter(item => item.owner !== owner) };
  const managedTools = stringList(input.managedTools);
  const enabledTools = stringList(input.enabledTools);
  const deferredTools = input.deferredTools === undefined ? [] : stringList(input.deferredTools);
  const allowOnly = input.allowOnly === undefined ? undefined : stringList(input.allowOnly);
  if (
    input.kind !== "register" ||
    !managedTools ||
    !enabledTools ||
    !deferredTools ||
    !enabledTools.every(tool => managedTools.includes(tool)) ||
    !deferredTools.every(tool => enabledTools.includes(tool))
  )
    return { availability: "unavailable", policies: old.policies };
  const policy: ToolPolicyReadModel = {
    owner,
    managedTools,
    enabledTools,
    deferredTools,
    ...(allowOnly ? { allowOnly } : {}),
  };
  return {
    availability: "available",
    policies: [...old.policies.filter(item => item.owner !== owner), policy].sort((a, b) =>
      a.owner.localeCompare(b.owner),
    ),
  };
}

function withHealth(value: OperationalReadModel, diagnostics: RuntimeDiagnostic[]): OperationalReadModel {
  const issues = [
    ...Object.entries(value)
      .filter(
        ([key, feature]) => key !== "health" && "availability" in feature && feature.availability === "unavailable",
      )
      .map(([key]) => `${key} unavailable`),
    ...diagnostics.filter(item => item.level !== "info").map(item => item.message.slice(0, 500)),
  ].slice(0, 20);
  return { ...value, health: { status: issues.length ? "degraded" : "healthy", issues } };
}
