import type {
  ContinuityReadModel,
  GuardReadModel,
  JobsReadModel,
  OperationalReadModel,
  TimelineReadModel,
  ToolPolicyReadModel,
  ToolsReadModel,
  VerificationReadModel,
} from "../../shared/protocol/events.ts";
import type { RuntimeDiagnostic } from "../../shared/protocol/snapshots.ts";

const verificationStates = new Set(["running", "passed", "failed", "cancelled", "stale", "error", "no_checks", "clean"]);
const jobStates = new Set(["running", "completed", "failed", "cancelled", "timed_out"]);
const todoStates = new Set(["pending", "in_progress", "done", "blocked"]);
const workModes = new Set(["planning", "executing", "handed_off", "completed", "cancelled"]);
const idPattern = /^[A-Za-z0-9._:@/-]+$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function string(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, maximum) : undefined;
}
function identifier(value: unknown): string | undefined {
  const item = string(value, 128);
  return item && idPattern.test(item) ? item : undefined;
}
function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function stringList(value: unknown, maximum = 100): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) return undefined;
  return [...new Set(value.slice(0, maximum).map((item) => item.slice(0, 200)))];
}

export function initialOperational(availableTools: Iterable<string>, loadedExtensions: Iterable<string>, diagnostics: RuntimeDiagnostic[] = []): OperationalReadModel {
  const tools = new Set(availableTools);
  const loaded = new Set(loadedExtensions);
  const operational: OperationalReadModel = {
    verification: { availability: tools.has("verify") ? "available" : "unavailable", checks: [] },
    jobs: { availability: tools.has("heartbeat_start") ? "available" : "unavailable", items: [] },
    guard: { availability: loaded.has("pi-guard.ts") ? "available" : "unavailable", blocked: 0, confirmed: 0 },
    continuity: { availability: "unavailable", revision: 0, memory: [] },
    timeline: { availability: "unavailable", revision: 0, checkpoints: [] },
    tools: { availability: loaded.has("pylon-core.ts") ? "available" : "unavailable", policies: [] },
    health: { status: "healthy", issues: [] },
  };
  return withHealth(operational, diagnostics);
}

export function withOperationalCapabilities(current: OperationalReadModel, availableTools: Iterable<string>, loadedExtensions: Iterable<string>, diagnostics: RuntimeDiagnostic[] = []): OperationalReadModel {
  const fresh = initialOperational(availableTools, loadedExtensions, diagnostics);
  const next: OperationalReadModel = {
    verification: current.verification.state || current.verification.checks.length ? { ...current.verification, availability: fresh.verification.availability } : fresh.verification,
    jobs: current.jobs.items.length ? { ...current.jobs, availability: fresh.jobs.availability } : fresh.jobs,
    guard: current.guard.decision ? { ...current.guard, availability: fresh.guard.availability } : { ...fresh.guard, blocked: current.guard.blocked, confirmed: current.guard.confirmed },
    continuity: current.continuity.revision ? current.continuity : fresh.continuity,
    timeline: current.timeline.revision ? current.timeline : fresh.timeline,
    tools: current.tools.policies.length ? { ...current.tools, availability: fresh.tools.availability } : fresh.tools,
    health: fresh.health,
  };
  return withHealth(next, diagnostics);
}

export function cloneOperational(value: OperationalReadModel): OperationalReadModel {
  return {
    verification: { ...value.verification, checks: value.verification.checks.map((item) => ({ ...item })) },
    jobs: { ...value.jobs, items: value.jobs.items.map((item) => ({ ...item })) },
    guard: { ...value.guard },
    continuity: {
      ...value.continuity,
      memory: value.continuity.memory.map((fact) => ({
        ...fact,
        evidencePaths: fact.evidencePaths?.map((item) => ({ ...item })),
      })),
      work: value.continuity.work ? { ...value.continuity.work, todos: value.continuity.work.todos.map((item) => ({ ...item })) } : undefined,
    },
    timeline: { ...value.timeline, checkpoints: value.timeline.checkpoints.map((item) => ({ ...item })) },
    tools: { ...value.tools, policies: value.tools.policies.map((item) => ({ ...item, managedTools: [...item.managedTools], enabledTools: [...item.enabledTools], deferredTools: [...item.deferredTools], allowOnly: item.allowOnly ? [...item.allowOnly] : undefined })) },
    health: { ...value.health, issues: [...value.health.issues] },
  };
}

export function applyOperationalEvent(
  current: OperationalReadModel,
  channel: string,
  value: unknown,
  diagnostics: RuntimeDiagnostic[] = [],
  expectedSessionId?: string,
  redact: (value: string) => string = (value) => value,
): OperationalReadModel {
  let next = cloneOperational(current);
  if (channel === "pi-verify:lifecycle" || channel === "pi-verify:result") next.verification = verification(current.verification, value, redact);
  else if (channel === "pi-heartbeat:job") next.jobs = jobs(current.jobs, value);
  else if (channel === "pi-guard:decision") next.guard = guard(current.guard, value);
  else if (channel === "pi-continuity:state-change") next.continuity = continuity(current.continuity, value, expectedSessionId);
  else if (channel === "pi-timeline:state-change") next.timeline = timeline(current.timeline, value, expectedSessionId);
  else if (channel === "pylon:tool-policy") next.tools = toolPolicy(current.tools, value);
  else return current;
  return withHealth(next, diagnostics);
}

function verification(old: VerificationReadModel, value: unknown, redact: (value: string) => string): VerificationReadModel {
  const input = record(value);
  if (!input || input.version !== 1 || !verificationStates.has(String(input.state))) return { availability: "unavailable", checks: [] };
  const rawResults = Array.isArray(input.results) ? input.results : [];
  let outputBudget = 16 * 1024;
  const checks = rawResults.slice(0, 20).flatMap((value, index) => {
    const item = record(value);
    if (!item) return [];
    const id = identifier(item.id) ?? `check-${index + 1}`;
    const label = string(item.label, 200) ?? id;
    const command = redact(string(item.command, 500) ?? "").slice(0, 500);
    const code = item.code === null ? null : number(item.code, Number.NaN);
    const rawOutput = string(item.output, Math.min(8 * 1024, outputBudget));
    const safeOutput = rawOutput ? redact(rawOutput).slice(0, Math.min(8 * 1024, outputBudget)) : undefined;
    if (safeOutput) outputBudget -= safeOutput.length;
    return [{
      id, label, command,
      status: code === 0 ? "passed" as const : code === null || !Number.isFinite(code) ? "error" as const : "failed" as const,
      durationMs: Math.max(0, number(item.durationMs)),
      ...(safeOutput ? { output: safeOutput } : {}),
      truncated: item.truncated === true || outputBudget <= 0,
    }];
  });
  return {
    availability: "available",
    state: input.state as VerificationReadModel["state"],
    ...(identifier(input.runId) ? { runId: identifier(input.runId) } : {}),
    ...(input.scope === "changed" || input.scope === "project" ? { scope: input.scope } : {}),
    ...(string(input.startedAt, 64) ? { startedAt: string(input.startedAt, 64) } : {}),
    ...(string(input.finishedAt, 64) ? { finishedAt: string(input.finishedAt, 64) } : {}),
    ...(typeof input.durationMs === "number" ? { durationMs: Math.max(0, number(input.durationMs)) } : {}),
    checks,
    ...(string(input.skipped, 1_000) ? { message: string(input.skipped, 1_000) } : {}),
  };
}

function jobs(old: JobsReadModel, value: unknown): JobsReadModel {
  const input = record(value);
  if (!input || input.version !== 1 || !identifier(input.id) || !jobStates.has(String(input.state)) || !string(input.startedAt, 64)) return { availability: "unavailable", items: [] };
  const item = {
    id: identifier(input.id)!,
    label: string(input.label, 120) ?? identifier(input.id)!,
    state: input.state as JobsReadModel["items"][number]["state"],
    startedAt: string(input.startedAt, 64)!,
    ...(string(input.finishedAt, 64) ? { finishedAt: string(input.finishedAt, 64) } : {}),
    ...(typeof input.exitCode === "number" || input.exitCode === null ? { exitCode: input.exitCode as number | null } : {}),
    ...(input.purpose === "verification" || input.purpose === "build" || input.purpose === "other" ? { purpose: input.purpose as "verification" | "build" | "other" } : {}),
    ...(identifier(input.todoId) ? { todoId: identifier(input.todoId) } : {}),
  };
  return { availability: "available", items: [...old.items.filter((old) => old.id !== item.id), item].slice(-50) };
}

function guard(old: GuardReadModel, value: unknown): GuardReadModel {
  const input = record(value);
  if (!input || input.version !== 1 || typeof input.decision !== "string") return { availability: "unavailable", blocked: old.blocked, confirmed: old.confirmed };
  return { availability: "available", decision: input.decision.slice(0, 100), reason: string(input.reason, 500), blocked: Math.max(0, number(input.blocked)), confirmed: Math.max(0, number(input.confirmed)) };
}

function continuity(old: ContinuityReadModel, value: unknown, expectedSessionId?: string): ContinuityReadModel {
  const input = record(value);
  if (!input || input.version !== 2 || (expectedSessionId && input.sessionId !== expectedSessionId) || !Number.isSafeInteger(input.revision) || (input.revision as number) <= old.revision) return input?.version === 2 ? old : { availability: "unavailable", revision: old.revision, memory: old.memory };
  if (input.available !== true) return { availability: "unavailable", revision: input.revision as number, memory: [] };
  const kinds = new Set(["workflow", "structure", "architecture", "warning", "preference"]);
  const memory = Array.isArray(input.memory) ? input.memory.slice(0, 30).flatMap((value) => {
    const fact = record(value);
    const key = string(fact?.key, 200);
    const text = string(fact?.text, 1_000);
    const source = string(fact?.source, 500);
    const updatedAt = string(fact?.updatedAt, 64);
    if (!fact || !key || !text || !source || !updatedAt || !kinds.has(String(fact.kind))
      || typeof fact.confidence !== "number" || fact.confidence < 0 || fact.confidence > 1) return [];
    const evidencePaths = Array.isArray(fact.evidencePaths) ? fact.evidencePaths.slice(0, 5).flatMap((value) => {
      const evidence = record(value);
      const path = string(evidence?.path, 240);
      const sha256 = string(evidence?.sha256, 64);
      return path && sha256 && /^[0-9a-f]{64}$/.test(sha256) ? [{ path, sha256 }] : [];
    }) : undefined;
    return [{
      key,
      kind: fact.kind as ContinuityReadModel["memory"][number]["kind"],
      text,
      source,
      confidence: fact.confidence,
      updatedAt,
      ...(string(fact.captureCommit, 64) ? { captureCommit: string(fact.captureCommit, 64) } : {}),
      ...(string(fact.branchAtCapture, 240) ? { branchAtCapture: string(fact.branchAtCapture, 240) } : {}),
      ...(evidencePaths?.length ? { evidencePaths } : {}),
    }];
  }) : [];
  const work = record(input.work);
  if (!work) return { availability: "available", revision: input.revision as number, memory };
  if (!workModes.has(String(work.mode)) || typeof work.goal !== "string" || typeof work.approved !== "boolean" || typeof work.planSummary !== "string" || !Array.isArray(work.todos)) return { availability: "unavailable", revision: input.revision as number, memory };
  const todos = work.todos.slice(0, 12).flatMap((value) => {
    const item = record(value); const id = identifier(item?.id); const text = string(item?.text, 500);
    if (!item || !id || !text || !todoStates.has(String(item.status)) || typeof item.updatedAt !== "string") return [];
    return [{ id, text, status: item.status as "pending" | "in_progress" | "done" | "blocked", updatedAt: item.updatedAt.slice(0, 64) }];
  });
  return { availability: "available", revision: input.revision as number, memory, work: {
    mode: work.mode as NonNullable<ContinuityReadModel["work"]>["mode"], goal: work.goal.slice(0, 2_000), approved: work.approved, planSummary: work.planSummary.slice(0, 4_000), todos,
    ...(identifier(work.currentTodoId) ? { currentTodoId: identifier(work.currentTodoId) } : {}), ...(string(work.latestFailure, 1_000) ? { latestFailure: string(work.latestFailure, 1_000) } : {}), ...(string(work.nextAction, 1_000) ? { nextAction: string(work.nextAction, 1_000) } : {}), ...(identifier(work.runId) ? { runId: identifier(work.runId) } : {}),
    createdAt: string(work.createdAt, 64) ?? "", updatedAt: string(work.updatedAt, 64) ?? "", ...(string(work.completedAt, 64) ? { completedAt: string(work.completedAt, 64) } : {}),
  } };
}

function timeline(old: TimelineReadModel, value: unknown, expectedSessionId?: string): TimelineReadModel {
  const input = record(value);
  if (!input || input.version !== 2 || (expectedSessionId && input.sessionId !== expectedSessionId) || !Number.isSafeInteger(input.revision) || (input.revision as number) <= old.revision) return input?.version === 2 ? old : { availability: "unavailable", revision: old.revision, checkpoints: [] };
  if (input.available !== true) return { availability: "unavailable", revision: input.revision as number, checkpoints: [] };
  if (!Array.isArray(input.checkpoints)) return { availability: "unavailable", revision: input.revision as number, checkpoints: [] };
  const checkpoints = input.checkpoints.slice(-100).flatMap((value) => {
    const item = record(value); const id = identifier(item?.id); const title = string(item?.title, 500); const ownerSessionId = identifier(item?.ownerSessionId); const createdAt = string(item?.createdAt, 64);
    if (!item || !id || !title || !ownerSessionId || !createdAt) return [];
    return [{ id, title, ownerSessionId, createdAt, verified: item.verified === true, ...(string(item.branch, 200) ? { branch: string(item.branch, 200) } : {}) }];
  });
  return { availability: "available", revision: input.revision as number, checkpoints };
}

function toolPolicy(old: ToolsReadModel, value: unknown): ToolsReadModel {
  const input = record(value); const owner = identifier(input?.owner);
  if (!input || input.version !== 1 || !owner) return { availability: "unavailable", policies: old.policies };
  if (input.kind === "unregister") return { availability: "available", policies: old.policies.filter((item) => item.owner !== owner) };
  const managedTools = stringList(input.managedTools); const enabledTools = stringList(input.enabledTools); const deferredTools = input.deferredTools === undefined ? [] : stringList(input.deferredTools); const allowOnly = input.allowOnly === undefined ? undefined : stringList(input.allowOnly);
  if (input.kind !== "register" || !managedTools || !enabledTools || !deferredTools || !enabledTools.every((tool) => managedTools.includes(tool)) || !deferredTools.every((tool) => enabledTools.includes(tool))) return { availability: "unavailable", policies: old.policies };
  const policy: ToolPolicyReadModel = { owner, managedTools, enabledTools, deferredTools, ...(allowOnly ? { allowOnly } : {}) };
  return { availability: "available", policies: [...old.policies.filter((item) => item.owner !== owner), policy].sort((a, b) => a.owner.localeCompare(b.owner)) };
}

function withHealth(value: OperationalReadModel, diagnostics: RuntimeDiagnostic[]): OperationalReadModel {
  const issues = [
    ...Object.entries(value).filter(([key, feature]) => key !== "health" && "availability" in feature && feature.availability === "unavailable").map(([key]) => `${key} unavailable`),
    ...diagnostics.filter((item) => item.level !== "info").map((item) => item.message.slice(0, 500)),
  ].slice(0, 20);
  return { ...value, health: { status: issues.length ? "degraded" : "healthy", issues } };
}
