import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { addCostParts, emptyUsage, sumCostParts, usageSnapshot } from "pylon-core/child-process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { buildWorkerContext, sanitizeFailureMessage } from "../src/context.ts";
import {
  configPath,
  gruntMaxCostUsd,
  gruntMaxTurns,
  gruntMode,
  gruntParentContextChars,
  gruntPrompt,
  gruntThinkingLevels,
  gruntTimeoutMs,
  isGruntEnabled,
  loadConfig,
  parseModelRef,
  saveConfig,
  defaultThinkingLevels,
} from "../src/config.ts";
import {
  applyWorkerPatch,
  cleanupSessionPatchArtifacts,
  collectWorkerPatch,
  createIsolatedWorktree,
  parentChangesSinceBaseline,
  persistPatchArtifact,
  pruneStalePatchArtifacts,
  removeIsolatedWorktree,
  type IsolatedWorktree,
} from "../src/isolation.ts";
import {
  DIRECT_WORKER_IMMUTABLE_FOOTER,
  DIRECT_WORKER_PROMPT,
  WORKER_IMMUTABLE_FOOTER,
  WORKER_PROMPT,
} from "../src/prompts.ts";
import { runPi, type WorkerActivity, type WorkerRun } from "../src/runner.ts";
import { isTransientProviderFailure, loadDelegateRetryPolicy, waitForDelegateRetry } from "../src/retry.ts";
import { requestDelegateName } from "pylon-core/delegate-names";
import { composePackagePrompt } from "pylon-core/package-settings";

const LINE_EDIT_EXTENSION = fileURLToPath(import.meta.resolve("pylon-core/extensions/line-edit.ts"));
const SIEVE_EXTENSION = fileURLToPath(import.meta.resolve("pi-sieve/extensions/pi-sieve.ts"));

const HEARTBEAT_MS = 1000;
const modelName = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

async function resolveExecutionMode(
  configured: ReturnType<typeof gruntMode>,
  exec: any,
  cwd: string,
): Promise<"isolated" | "direct"> {
  if (configured !== "dynamic") return configured;
  const git = await exec("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree", "--verify", "HEAD"], {
    timeout: 10_000,
  });
  return git.code === 0 && git.stdout.trim().startsWith("true") ? "isolated" : "direct";
}

function activityText(activity: readonly WorkerActivity[]): string {
  return activity
    .map(
      item =>
        `${item.kind === "call" ? ">" : item.isError ? "!" : "<"} ${item.tool} ${item.text.replace(/\s+/g, " ").slice(0, 180)}`,
    )
    .join("\n");
}

function usageText(run: WorkerRun): string {
  const u = run.usage;
  return `${run.turns} turn${run.turns === 1 ? "" : "s"} · ${u.input} input · ${u.output} output · R${u.cacheRead} · W${u.cacheWrite} · $${u.cost.toFixed(4)} · ${(run.durationMs / 1000).toFixed(1)}s`;
}

const addUsage = (left: WorkerRun["usage"], right: WorkerRun["usage"]): WorkerRun["usage"] => ({
  input: left.input + right.input,
  output: left.output + right.output,
  cacheRead: left.cacheRead + right.cacheRead,
  cacheWrite: left.cacheWrite + right.cacheWrite,
  cost: left.cost + right.cost,
  costParts: sumCostParts(left.costParts, right.costParts),
});

type SessionStats = { runs: number; integrated: number; requiresAttention: number; turns: number; cost: number };
const emptyStats = (): SessionStats => ({ runs: 0, integrated: 0, requiresAttention: 0, turns: 0, cost: 0 });
function workerMetrics(run: WorkerRun, workerStatus: string, integrationStatus: string, changedFileCount?: number) {
  return {
    workerStatus,
    integrationStatus,
    workerCostUsd: run.usage.cost,
    turns: run.turns,
    inputTokens: run.usage.input,
    outputTokens: run.usage.output,
    cacheReadTokens: run.usage.cacheRead,
    cacheWriteTokens: run.usage.cacheWrite,
    ...(changedFileCount === undefined ? {} : { changedFileCount }),
  };
}

function isSuggested(path: string, suggestions: readonly string[]): boolean {
  const normalized = path.replace(/\\/g, "/");
  return suggestions.some(item => {
    const value = item.replace(/\\/g, "/").replace(/^\.\//, "");
    const prefix = value.endsWith("/**") ? value.slice(0, -3).replace(/\/$/, "") : value.replace(/\/$/, "");
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  });
}

function derivedStatus(run: WorkerRun, changedCount: number): string {
  if (run.failure === "aborted") return changedCount ? "partial" : "aborted";
  if (run.failure === "timed_out") return changedCount ? "partial" : "timed_out";
  if (run.error) return changedCount ? "partial" : "failed";
  if (/^Status:\s*blocked\b/im.test(run.text)) return changedCount ? "partial" : "blocked";
  if (/^Status:\s*completed\b/im.test(run.text)) return "completed";
  return changedCount ? "partial" : "failed";
}

function unavailableDependencies(
  parentRoot: string,
  parentCwd: string,
  workerRoot: string,
  workerCwd: string,
): string[] {
  const missing = new Set<string>();
  let parent = parentCwd;
  let worker = workerCwd;
  for (;;) {
    for (const name of ["node_modules", ".venv", "venv"])
      if (existsSync(join(parent, name)) && !existsSync(join(worker, name)))
        missing.add(relative(parentRoot, join(parent, name)).replace(/\\/g, "/") || name);
    if (parent === parentRoot) break;
    const nextParent = dirname(parent);
    const nextWorker = dirname(worker);
    if (nextParent === parent || relative(parentRoot, nextParent).startsWith("..")) break;
    parent = nextParent;
    worker = nextWorker;
  }
  return [...missing].sort();
}

type IsolationSetup = { mode: "isolated" | "direct"; isolated?: IsolatedWorktree; isolationFallback?: string };

/**
 * Resolves the execution mode and, for isolated mode, creates the worktree.
 * Only a `dynamic` configuration is allowed to silently fall back to direct editing;
 * an explicit `isolated` configuration fails the call rather than touching the parent.
 */
async function prepareIsolation(
  exec: any,
  cwd: string,
  configuredMode: ReturnType<typeof gruntMode>,
  signal?: AbortSignal,
): Promise<IsolationSetup> {
  const mode = await resolveExecutionMode(configuredMode, exec, cwd);
  if (mode !== "isolated") return { mode };
  try {
    return { mode, isolated: await createIsolatedWorktree(exec, cwd, signal) };
  } catch (error) {
    const message = sanitizeFailureMessage(error, "Grunt isolation unavailable.");
    if (configuredMode !== "dynamic") throw new Error(`Grunt isolation unavailable: ${message}`);
    return { mode: "direct", isolationFallback: message };
  }
}

type Integration = { status: string; applied: boolean; failureCode?: string; integrationError: string };

/**
 * Decides the fate of a completed worker's patch: applied, blocked because the parent
 * moved underneath it, or failed during apply. A worker that did not complete is passed
 * through untouched — there is nothing to integrate.
 */
async function integrateWorkerPatch(input: {
  exec: any;
  isolation: IsolatedWorktree;
  baseline: IsolatedWorktree;
  patch: string;
  workerStatus: string;
  runFailure?: string;
}): Promise<Integration> {
  const unchanged = { status: input.workerStatus, applied: false, failureCode: input.runFailure, integrationError: "" };
  if (input.workerStatus !== "completed") return unchanged;

  const parentChanges = await parentChangesSinceBaseline(input.exec, input.baseline);
  if (parentChanges.length)
    return {
      status: "stale",
      applied: false,
      failureCode: "stale_parent",
      integrationError: sanitizeFailureMessage(
        `Parent changed while worker ran: ${parentChanges.join(", ")}.`,
        "Parent changed while worker ran.",
      ),
    };

  try {
    await applyWorkerPatch(input.exec, input.isolation, input.patch);
    return { ...unchanged, applied: true };
  } catch (error) {
    const raw = error instanceof Error ? error.message : "Worker patch apply failed.";
    const stale = raw.startsWith("Parent changed immediately before patch apply:");
    return {
      status: stale ? "stale" : "failed",
      applied: false,
      failureCode: stale ? "stale_parent" : "apply_failed",
      integrationError: sanitizeFailureMessage(raw, "Worker patch apply failed."),
    };
  }
}

export default function gruntExtension(pi: ExtensionAPI, runWorker = runPi, retryWait = waitForDelegateRetry) {
  let calls = 0;
  let stats = emptyStats();
  const sessionPatchArtifacts = new Set<string>();
  const GruntParameters = Type.Object(
    {
      task: Type.String({
        minLength: 1,
        maxLength: 8000,
        description: "Self-contained implementation handoff including decisions and acceptance criteria",
      }),
      thinking: StringEnum(defaultThinkingLevels, { description: "Worker thinking effort selected by the main model" }),
      suggestedPaths: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
          maxItems: 40,
          uniqueItems: true,
          description: "Scope guidance, not an allowlist",
        }),
      ),
      targetedContext: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 4000,
          description: "Directly applicable code snippets or project instructions; never broad transcript context",
        }),
      ),
      checkCommands: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
          maxItems: 8,
          uniqueItems: true,
          description: "Focused existing checks useful for this task",
        }),
      ),
    },
    { additionalProperties: false },
  );
  const refreshSchema = (config: Awaited<ReturnType<typeof loadConfig>>) => {
    GruntParameters.properties.thinking = StringEnum(gruntThinkingLevels(config), {
      description: "Worker thinking effort selected by the main model",
    });
  };
  const recordRun = (run: WorkerRun, integrationStatus: string) => {
    stats.runs++;
    stats.turns += run.turns;
    stats.cost += run.usage.cost;
    if (integrationStatus === "completed") stats.integrated++;
    else stats.requiresAttention++;
  };
  const resolveModel = async (ctx: any, config: Awaited<ReturnType<typeof loadConfig>>) => {
    if (!config.model) return ctx.model;
    const ref = parseModelRef(config.model);
    return ref ? ctx.modelRegistry.find(ref.provider, ref.id) : undefined;
  };
  const disposeHealth = pi.events.on("pylon:health-request", (request: any) => {
    if (request?.version !== 1 || typeof request.respond !== "function") return;
    request.respond(
      (async () => {
        const config = await loadConfig();
        return {
          version: 1,
          owner: "pi-grunt",
          label: "Grunt",
          lines: [
            `State: ${config.disabled ? "disabled" : isGruntEnabled(config) ? "active" : "inactive"}`,
            `Model: ${config.model ?? "current main model"}`,
            `Execution: synchronous ${gruntMode(config) === "isolated" ? "isolated Git worktree" : gruntMode(config) === "direct" ? "DIRECT current working directory" : "DYNAMIC (isolated with Git HEAD, direct otherwise)"}`,
          ],
          warning: gruntMode(config) !== "isolated",
        };
      })(),
    );
  });
  const refreshTool = async (agentDir?: string) => {
    const config = await loadConfig(agentDir ? configPath(agentDir) : undefined);
    refreshSchema(config);
    const enabled = isGruntEnabled(config);
    let coordinated = false;
    pi.events.emit("pylon:tool-policy", {
      version: 1,
      kind: "register",
      owner: "pi-grunt",
      managedTools: ["grunt"],
      enabledTools: enabled ? ["grunt"] : [],
      ...(enabled ? { deferredTools: ["grunt"] } : {}),
      ...(enabled
        ? { toolUsage: { grunt: "delegate a large mechanical implementation slice to an isolated synchronous worker" } }
        : {}),
      acknowledge: () => {
        coordinated = true;
      },
    });
    if (coordinated) return;
    const active = pi.getActiveTools().filter(name => name !== "grunt");
    if (enabled) active.push("grunt");
    pi.setActiveTools(active);
  };

  const disposeSettingsRefresh = pi.events.on("pylon:package-settings-changed", (request: any) => {
    if (
      request?.version !== 1 ||
      request.packageId !== "pi-grunt" ||
      typeof request.agentDir !== "string" ||
      typeof request.acknowledge !== "function"
    )
      return;
    request.acknowledge(() => refreshTool(request.agentDir));
  });
  pi.on("session_start", async () => {
    stats = emptyStats();
    await pruneStalePatchArtifacts();
    await refreshTool();
  });
  pi.on("input", event => {
    if (event.source !== "extension" && event.streamingBehavior !== "steer") calls = 0;
  });
  pi.on("session_shutdown", async () => {
    await cleanupSessionPatchArtifacts(sessionPatchArtifacts);
    sessionPatchArtifacts.clear();
    disposeHealth();
    disposeSettingsRefresh();
    pi.events.emit("pylon:tool-policy", { version: 1, kind: "unregister", owner: "pi-grunt" });
  });

  pi.registerTool({
    name: "grunt",
    label: "Grunt",
    description:
      "Run one synchronous delegated implementation worker. Isolated mode retries transient provider failures in fresh worktrees and applies completed work after stale-parent checks; direct mode edits without rollback or automatic retry. Main model reviews and verifies.",
    promptSnippet: "Delegate a compact implementation slice or complete non-difficult change to a synchronous worker",
    promptGuidelines: [
      "Delegate based on expected main-model effort avoided, not changed LOC alone. Keep diagnosis, architecture, cross-cutting changes, and ordinary semantic changes around 50–300 LOC in the main model. Use grunt mainly for mechanical multi-file work or designed slices, typically 300–500+ LOC. Use the lowest configured thinking level that fits. Run dependent slices sequentially, inspecting and checking each result first.",
      "The main model owns integration and recovery. Fix small remaining defects directly; re-delegate only self-contained medium or large work that is cheaper to validate. Never call grunt only to verify or repair its previous result.",
      "Direct execution edits the current workspace without rollback, stale-parent checks, changed-path detection, or protection from partial failure.",
    ],
    parameters: GruntParameters,
    executionMode: "sequential",
    async execute(id, params, signal, onUpdate, ctx) {
      const config = await loadConfig();
      const retryPolicy = await loadDelegateRetryPolicy();
      const refuse = (text: string, status: string, extra: Record<string, unknown> = {}) => ({
        content: [{ type: "text" as const, text }],
        details: { status, ...extra },
      });
      if (!isGruntEnabled(config))
        return refuse("Grunt inactive. Configure it with /grunt or use /grunt reset.", "disabled");
      if (!gruntThinkingLevels(config).includes(params.thinking))
        return refuse(`Grunt thinking level is not enabled: ${params.thinking}.`, "invalid");
      const task = params.task.trim();
      if (!task) return refuse("Grunt task must not be empty.", "invalid");
      const model = await resolveModel(ctx, config);
      if (!model) return refuse("Grunt unavailable: no selected model.", "unavailable");
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey)
        return refuse("Grunt unavailable: selected model has no credentials.", "unavailable", {
          model: modelName(model),
        });
      calls++;
      const started = Date.now();
      const delegateName = requestDelegateName(pi, { kind: "grunt", callId: id, task });
      const agent = {
        delegateNameFallback: delegateName.fallbackName,
        delegateNameKey: id,
        startedAt: new Date(started).toISOString(),
      };
      const agentDetails = () => ({ ...agent, agentName: delegateName.getName() });
      const named = (value: string) => `[${delegateName.getName()} · Grunt] ${value}`;

      const exec = pi.exec.bind(pi);
      const configuredMode = gruntMode(config);
      const setup = await prepareIsolation(exec, ctx.cwd, configuredMode, signal);
      const { mode, isolationFallback } = setup;
      // The configuration is snapshotted above; use the selected execution-mode base unchanged.
      const systemPrompt = composePackagePrompt(
        mode === "isolated" ? WORKER_PROMPT : DIRECT_WORKER_PROMPT,
        gruntPrompt(config.prompt),
        mode === "isolated" ? WORKER_IMMUTABLE_FOOTER : DIRECT_WORKER_IMMUTABLE_FOOTER,
      );
      // Reassigned when a transient failure is retried in a fresh worktree.
      let isolated = setup.isolated;
      const isolatedAttempts: IsolatedWorktree[] = isolated ? [isolated] : [];

      const callIsolation = isolated;
      let heartbeat: NodeJS.Timeout | undefined;
      const usage = emptyUsage();
      let attemptUsage = usageSnapshot(usage);
      let costLimitUsd: number | undefined;
      try {
        const maxCostUsd = gruntMaxCostUsd(config.maxCostUsd);
        costLimitUsd = maxCostUsd;
        const contextChars = gruntParentContextChars(config.parentContextChars);
        const entries = contextChars
          ? (ctx.sessionManager?.buildContextEntries?.() ?? ctx.sessionManager?.getBranch?.() ?? [])
          : [];
        const suggested = params.suggestedPaths ?? [];
        const targetedContext = params.targetedContext?.trim() ?? "";
        const checkCommands = params.checkCommands ?? [];
        const parentContext = contextChars
          ? buildWorkerContext(entries, contextChars, 10, [task, targetedContext, ...suggested, ...checkCommands])
          : "";
        const runningText =
          mode === "isolated" ? "implementing in isolation" : "DIRECT — editing current working directory";
        let activity: readonly WorkerActivity[] = [];
        let lastUpdateAt = started;
        let attempts = 0;
        let contextTokens: number | null = null;
        const contextLimit = model.contextWindow;
        // Every progress frame carries the same identity; only the message and extras differ.
        const progress = (text: string, extra: Record<string, unknown> = {}) =>
          onUpdate?.({
            content: [{ type: "text", text }],
            details: {
              ...agentDetails(),
              state: "running",
              mode,
              configuredMode,
              model: modelName(model),
              thinking: params.thinking,
              costLimitUsd: maxCostUsd,
              durationMs: Date.now() - started,
              attempts,
              contextTokens,
              contextLimit,
              ...extra,
            },
          });
        if (ctx.hasUI) ctx.ui.setStatus("pi-grunt", `grunt: ${runningText}…`);
        onUpdate?.({
          content: [{ type: "text", text: `Grunt ${runningText}…` }],
          details: {
            ...agentDetails(),
            state: "running",
            mode,
            configuredMode,
            model: modelName(model),
            thinking: params.thinking,
            costLimitUsd: maxCostUsd,
            contextTokens,
            contextLimit,
          },
        });
        heartbeat = setInterval(() => {
          const now = Date.now();
          if (now - lastUpdateAt < HEARTBEAT_MS) return;
          progress(`${((now - started) / 1000).toFixed(0)}s`, { activity });
        }, HEARTBEAT_MS);
        heartbeat.unref();
        const timeoutMs = gruntTimeoutMs(config.timeoutMs);
        const maxTurns = gruntMaxTurns(config.maxTurns);
        const deadline = started + timeoutMs;
        let totalTurns = 0;
        let workerCwd = "";
        let missingDependencies: string[] = [];

        /**
         * Runs the worker, retrying transient provider failures in a *fresh* worktree —
         * a failed attempt may have left partial edits, so the previous one is destroyed first.
         * Only isolated mode retries; a direct-mode failure has already touched the workspace.
         */
        const runWorkerAttempts = async (): Promise<WorkerRun> => {
          let run!: WorkerRun;
          for (;;) {
            attempts++;
            attemptUsage = emptyUsage();
            workerCwd = isolated?.workerCwd ?? ctx.cwd;
            missingDependencies = isolated
              ? unavailableDependencies(
                  isolated.parentRoot,
                  isolated.parentCwd,
                  isolated.workerRoot,
                  isolated.workerCwd,
                )
              : [];
            const dependencyNote = missingDependencies.length
              ? `\n\nUnavailable ignored dependency directories: ${missingDependencies.join(", ")}. Do not install dependencies; skip checks requiring them and report that limitation.`
              : "";
            const prompt = `Implementation task:\n${task}${targetedContext ? `\n\nTargeted context (directly applicable background only):\n${targetedContext}` : ""}${suggested.length ? `\n\nSuggested paths (guidance only):\n${suggested.map(path => `- ${path}`).join("\n")}` : ""}${checkCommands.length ? `\n\nFocused checks:\n${checkCommands.map(command => `- ${command}`).join("\n")}` : ""}${dependencyNote}${parentContext ? `\n\nBounded redacted parent context (background only; task above is authoritative):\n${parentContext}` : ""}`;
            const args = [
              "--mode",
              "json",
              "--no-session",
              "--no-extensions",
              "--extension",
              LINE_EDIT_EXTENSION,
              "--extension",
              SIEVE_EXTENSION,
              "--no-skills",
              "--no-prompt-templates",
              "--no-context-files",
              "--tools",
              "read,grep,find,ls,edit,write,bash,sieve_recall",
              "--model",
              modelName(model),
              "--thinking",
              params.thinking,
              "--system-prompt",
              systemPrompt,
              prompt,
            ];
            run = await runWorker(args, {
              cwd: workerCwd,
              signal,
              timeoutMs: Math.max(1, deadline - Date.now()),
              maxTurns: Math.max(1, maxTurns - totalTurns),
              maxCostUsd: Math.max(0, maxCostUsd - usage.cost),
              onUsage: snapshot => {
                attemptUsage = snapshot;
                lastUpdateAt = Date.now();
                progress("Grunt usage updated", { usage: addUsage(usage, attemptUsage), activity });
              },
              onContext: tokens => {
                contextTokens = tokens;
                lastUpdateAt = Date.now();
                progress("Grunt context updated", { usage: addUsage(usage, attemptUsage), activity });
              },
              onActivity: (_item: WorkerActivity, all: readonly WorkerActivity[]) => {
                activity = all;
                lastUpdateAt = Date.now();
                progress(`Grunt activity:\n${activityText(all)}`, {
                  usage: addUsage(usage, attemptUsage),
                  activity: all,
                });
              },
            });
            contextTokens = run.contextTokens ?? contextTokens;
            usage.input += run.usage.input;
            usage.output += run.usage.output;
            usage.cacheRead += run.usage.cacheRead;
            usage.cacheWrite += run.usage.cacheWrite;
            usage.cost += run.usage.cost;
            addCostParts(usage.costParts, run.usage.costParts);
            attemptUsage = emptyUsage();
            totalTurns += run.turns;
            if (run.cwd !== workerCwd) throw new Error(`Worker runner did not confirm the ${mode} working directory`);
            const retryIsolation = isolated;
            const canRetry =
              retryIsolation !== undefined &&
              attempts < retryPolicy.maxAttempts &&
              Date.now() < deadline &&
              usage.cost < maxCostUsd &&
              totalTurns < maxTurns &&
              run.failure === "child_error" &&
              isTransientProviderFailure(run.error);
            if (!canRetry || !(await retryWait(attempts, signal, retryPolicy.baseMs))) return run;
            if (signal?.aborted || Date.now() >= deadline || usage.cost >= maxCostUsd || totalTurns >= maxTurns)
              return run;
            if ((await parentChangesSinceBaseline(exec, callIsolation ?? retryIsolation!)).length) return run;
            contextTokens = null;
            progress(
              `Grunt provider unavailable; retrying in fresh isolation (${attempts + 1}/${retryPolicy.maxAttempts})…`,
              { usage: usageSnapshot(usage) },
            );
            const cleanupWarnings = await removeIsolatedWorktree(exec, retryIsolation!);
            if (cleanupWarnings.length)
              throw new Error(`Grunt retry isolation cleanup failed: ${cleanupWarnings.join("; ")}`);
            const cleanupIndex = isolatedAttempts.indexOf(retryIsolation!);
            if (cleanupIndex >= 0) isolatedAttempts.splice(cleanupIndex, 1);
            isolated = undefined;
            isolated = await createIsolatedWorktree(exec, ctx.cwd, signal);
            isolatedAttempts.push(isolated);
          }
        };

        let run = await runWorkerAttempts();
        run = { ...run, durationMs: Date.now() - started, usage, turns: totalTurns };
        const workerFailureMessage = run.error ? sanitizeFailureMessage(run.error, "Grunt worker failed.") : undefined;
        // Keys both result shapes share; each mode then adds only what is specific to it.
        const baseDetails = (status: string, recovery: boolean) => ({
          ...agentDetails(),
          status,
          mode,
          configuredMode,
          workerCwd: run.cwd,
          ...(recovery ? { task, suggestedPaths: suggested, targetedContext, checkCommands } : {}),
          model: modelName(model),
          thinking: params.thinking,
          costLimitUsd: maxCostUsd,
          durationMs: run.durationMs,
          attempts,
          usage: run.usage,
          contextTokens,
          contextLimit,
          turns: run.turns,
          activity: run.activity,
          stopReason: run.stopReason,
          truncated: run.truncated,
          stderr: run.stderr,
        });

        if (!isolated) {
          const status = derivedStatus(run, 0);
          const recovery = status !== "completed";
          recordRun(run, status);
          const lines = [
            `Worker status: ${status}.`,
            "Execution mode: DIRECT; worker edits affected the current working directory immediately.",
            "Rollback and changed-path derivation: unavailable.",
            isolationFallback ? `Dynamic isolation fallback: ${isolationFallback}` : "",
            recovery && workerFailureMessage ? `Worker failure: ${workerFailureMessage}` : "",
            recovery && run.text ? `\nWorker report:\n${run.text}` : "",
          ].filter(Boolean);
          await delegateName.settled;

          return {
            content: [{ type: "text" as const, text: named(lines.join("\n")) }],
            details: {
              ...baseDetails(status, recovery),
              isolationFallback,
              isolated: false,
              metrics: workerMetrics(run, status, status),
              failureCode: run.failure,
              ...(workerFailureMessage ? { failureMessage: workerFailureMessage } : {}),
            },
          };
        }

        const finalIsolation = isolated;
        const worker = await collectWorkerPatch(exec, finalIsolation);
        const workerStatus = derivedStatus(run, worker.changedPaths.length);
        const integration = await integrateWorkerPatch({
          exec,
          isolation: finalIsolation,
          baseline: callIsolation ?? finalIsolation,
          patch: worker.patch,
          workerStatus,
          runFailure: run.failure,
        });
        const { status, applied, failureCode, integrationError } = integration;
        let artifactPath: string | undefined;
        if (!applied && worker.patch) {
          artifactPath = await persistPatchArtifact(worker.patch);
          if (artifactPath) sessionPatchArtifacts.add(artifactPath);
        }

        const cwdPrefix = relative(finalIsolation.parentRoot, finalIsolation.parentCwd).replace(/\\/g, "/");
        const suggestionPath = (path: string) =>
          cwdPrefix && path.startsWith(`${cwdPrefix}/`) ? path.slice(cwdPrefix.length + 1) : path;
        const outsideSuggestedPaths = suggested.length
          ? worker.changedPaths.filter(path => !isSuggested(suggestionPath(path), suggested))
          : [];
        const preExistingDirtyTouched = worker.changedPaths.filter(path =>
          finalIsolation.parentBaseline.paths.has(path),
        );
        const recovery = status !== "completed";
        recordRun(run, status);
        const lines = [
          `Worker status: ${status}.`,
          `Isolation verified: ${finalIsolation.isolationVerified ? "yes" : "no"}.`,
          `Parent patch applied: ${applied ? "yes" : "no"}.`,
          recovery ? `Derived changed paths: ${worker.changedPaths.join(", ") || "none"}.` : "",
          recovery && preExistingDirtyTouched.length
            ? `Pre-existing dirty paths touched in isolated snapshot: ${preExistingDirtyTouched.join(", ")}.`
            : "",
          recovery && outsideSuggestedPaths.length
            ? `Outside suggested paths: ${outsideSuggestedPaths.join(", ")}.`
            : "",
          artifactPath ? `Unapplied patch artifact: ${artifactPath}.` : "",
          integrationError ? `Integration failure: ${integrationError}` : "",
          recovery && workerFailureMessage ? `Worker failure: ${workerFailureMessage}` : "",
          recovery && run.text ? `\nWorker report:\n${run.text}` : "",
        ].filter(Boolean);
        await delegateName.settled;

        return {
          content: [{ type: "text" as const, text: named(lines.join("\n")) }],
          details: {
            ...baseDetails(status, recovery),
            applied,
            isolated: true,
            isolationVerified: finalIsolation.isolationVerified,
            workerHead: finalIsolation.workerHead,
            artifactPath,
            ...(recovery
              ? {
                  missingDependencies,
                  changedPaths: worker.changedPaths,
                  preExistingDirtyTouched,
                  outsideSuggestedPaths,
                }
              : {}),
            metrics: workerMetrics(run, workerStatus, status, worker.changedPaths.length),
            failureCode,
            ...(integrationError || workerFailureMessage
              ? { failureMessage: integrationError || workerFailureMessage }
              : {}),
          },
        };
      } catch (error) {
        const failureMessage = sanitizeFailureMessage(error, "Grunt execution failed.");
        await delegateName.settled;
        const liveUsage = addUsage(usage, attemptUsage);
        return {
          content: [
            {
              type: "text" as const,
              text: named(
                mode === "isolated"
                  ? `Grunt failed in isolated worktree; parent unchanged. ${failureMessage}`
                  : `Grunt failed in DIRECT mode; partial edits may remain. ${failureMessage}`,
              ),
            },
          ],
          details: {
            ...agentDetails(),
            status: "failed",
            mode,
            configuredMode,
            applied: mode === "isolated" ? false : undefined,
            isolated: mode === "isolated",
            failureCode: mode === "isolated" ? "isolation_error" : "worker_error",
            failureMessage,
            model: modelName(model),
            thinking: params.thinking,
            ...(costLimitUsd === undefined ? {} : { costLimitUsd }),
            usage: liveUsage,
          },
        };
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        const cleanupWarnings: string[] = [];
        for (const worktree of isolatedAttempts)
          cleanupWarnings.push(...(await removeIsolatedWorktree(exec, worktree)));
        if (cleanupWarnings.length) {
          const text = `Grunt cleanup warning: ${cleanupWarnings.join("; ")}`;
          if (ctx.hasUI) ctx.ui.notify(text, "warning");
          else
            onUpdate?.({
              content: [{ type: "text", text }],
              details: { ...agentDetails(), state: "cleanup_warning", cleanupWarnings },
            });
        }
        if (ctx.hasUI) ctx.ui.setStatus("pi-grunt", undefined);
      }
    },
    renderCall(args, theme, context) {
      const callNumber = (context.state.callNumber as number | undefined) ?? calls + 1;
      context.state.callNumber = callNumber;
      const prompt = args.task.trim().replace(/\s+/g, " ");
      const truncatedPrompt = prompt.length > 512 ? `${prompt.slice(0, 509)}...` : prompt;
      return new Text(
        theme.fg("toolTitle", theme.bold("Grunt")) +
          theme.fg("muted", ` · ${callNumber}/∞`) +
          `\n${theme.fg("dim", truncatedPrompt)}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme, context) {
      const details = result.details as any;
      const body = result.content.find((part: any) => part.type === "text") as any;
      const color =
        context?.isError || details?.failureCode === "isolation_error"
          ? "error"
          : details?.state === "running" || details?.status === "completed"
            ? "success"
            : "warning";
      const modeLabel =
        details?.configuredMode === "dynamic"
          ? ` · DYNAMIC/${details?.mode === "direct" ? "DIRECT" : "ISOLATED"}`
          : details?.mode === "direct"
            ? " · DIRECT"
            : "";
      let text = theme.fg(color, `Grunt · ${details?.model ?? "Unavailable"}${modeLabel}`);
      if (details?.usage)
        text += ` · ${usageText({ usage: details.usage, turns: details.turns, durationMs: details.durationMs } as WorkerRun)}`;
      else if (details?.durationMs) text += ` · ${(details.durationMs / 1000).toFixed(0)}s`;
      if (expanded && details?.activity?.length) text += `\n\nChild activity:\n${activityText(details.activity)}`;
      if (expanded && body?.text) text += `\n\nGrunt report:\n${body.text}`;
      return new Text(text, 0, 0);
    },
  });

  pi.registerCommand("grunt", {
    description: "Show or configure the Grunt worker",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = parts[0] ?? "status";
      const usage =
        "Usage: /grunt [status|set <provider/model>|select|mode <isolated|direct|dynamic>|enable|disable|reset|help]";
      if (action === "disable" && parts.length === 1) {
        await saveConfig({ ...(await loadConfig()), version: 1, disabled: true });
        await refreshTool();
        ctx.ui.notify("Grunt disabled.", "info");
        return;
      }
      if (action === "enable" && parts.length === 1) {
        await saveConfig({ ...(await loadConfig()), version: 1, disabled: false });
        await refreshTool();
        ctx.ui.notify("Grunt enabled.", "info");
        return;
      }
      if (action === "reset" && parts.length === 1) {
        await saveConfig({ version: 1, disabled: false, mode: "isolated" });
        await refreshTool();
        ctx.ui.notify("Grunt reset to current main model in isolated mode.", "info");
        return;
      }
      if (action === "mode" && parts.length === 2 && ["isolated", "direct", "dynamic"].includes(parts[1]!)) {
        const mode = parts[1] as "isolated" | "direct" | "dynamic";
        const config = await loadConfig();
        await saveConfig({ ...config, mode });
        await refreshTool();
        const message =
          mode === "isolated"
            ? "Grunt mode: isolated Git worktree."
            : mode === "direct"
              ? "Grunt mode: DIRECT. Worker edits affect the current working directory immediately."
              : "Grunt mode: dynamic. Uses isolation with a Git HEAD; DIRECT otherwise.";
        ctx.ui.notify(message, mode === "direct" ? "warning" : "info");
        return;
      }
      if ((action === "status" && parts.length === 1) || parts.length === 0) {
        const config = await loadConfig();
        const model = await resolveModel(ctx, config);
        const state = config.disabled
          ? "disabled"
          : !isGruntEnabled(config)
            ? "inactive"
            : model
              ? "active"
              : "unavailable";
        const measured = stats.runs
          ? `\nSession worker metrics: ${stats.integrated}/${stats.runs} integrated · ${stats.requiresAttention} requiring main attention · ${stats.turns} turns · $${stats.cost.toFixed(4)}`
          : "\nSession worker metrics: no runs yet";
        ctx.ui.notify(
          `Model: ${config.model ?? "current main model"}\nState: ${state}\nMode: ${gruntMode(config)}\nThinking: selected by main model per call${measured}\nNote: metrics exclude main-model handoff, review, repair, and verification cost.`,
          "info",
        );
        return;
      }
      let selected: string | undefined;
      if (action === "set" && parts.length === 2) selected = parts[1];
      else if (action === "select" && parts.length === 1) {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("Grunt model selection is available only in Pi TUI.", "error");
          return;
        }
        selected =
          (await ctx.ui.select(
            "Grunt worker model",
            (ctx.scopedModels.length
              ? ctx.scopedModels.map(({ model }) => model)
              : ctx.modelRegistry.getAvailable()
            ).map(modelName),
          )) ?? undefined;
        if (!selected) return;
      } else {
        ctx.ui.notify(usage, action === "help" && parts.length === 1 ? "info" : "warning");
        return;
      }
      const ref = parseModelRef(selected);
      const model = ref && ctx.modelRegistry.find(ref.provider, ref.id);
      if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
        ctx.ui.notify(`Unavailable model: ${selected}`, "error");
        return;
      }
      await saveConfig({ ...(await loadConfig()), version: 1, model: modelName(model), disabled: false });
      await refreshTool();
      ctx.ui.notify(`Grunt model: ${modelName(model)}\nThinking: selected by main model per call`, "info");
    },
  });
}
