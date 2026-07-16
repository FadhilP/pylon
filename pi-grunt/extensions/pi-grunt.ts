import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { buildWorkerContext } from "../src/context.ts";
import {
  gruntMaxCostUsd, gruntMaxTurns, gruntMode, gruntParentContextChars, gruntTimeoutMs,
  isGruntEnabled, loadConfig, parseModelRef, saveConfig, thinkingLevels,
} from "../src/config.ts";
import {
  applyWorkerPatch, cleanupSessionPatchArtifacts, collectWorkerPatch,
  createIsolatedWorktree, parentChangesSinceBaseline, persistPatchArtifact,
  pruneStalePatchArtifacts, removeIsolatedWorktree,
} from "../src/isolation.ts";
import { DIRECT_WORKER_PROMPT, WORKER_PROMPT } from "../src/prompts.ts";
import { runPi, type WorkerActivity, type WorkerRun } from "../src/runner.ts";

const HEARTBEAT_MS = 1000;
const modelName = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

async function resolveExecutionMode(configured: ReturnType<typeof gruntMode>, exec: any, cwd: string): Promise<"isolated" | "direct"> {
  if (configured !== "dynamic") return configured;
  const git = await exec("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree", "--verify", "HEAD"], { timeout: 10_000 });
  return git.code === 0 && git.stdout.trim().startsWith("true") ? "isolated" : "direct";
}

function activityText(activity: readonly WorkerActivity[]): string {
  return activity.map((item) => `${item.kind === "call" ? ">" : item.isError ? "!" : "<"} ${item.tool} ${item.text.replace(/\s+/g, " ").slice(0, 180)}`).join("\n");
}

function usageText(run: WorkerRun): string {
  const u = run.usage;
  return `${run.turns} turn${run.turns === 1 ? "" : "s"} · ${u.input} input · ${u.output} output · R${u.cacheRead} · W${u.cacheWrite} · $${u.cost.toFixed(4)} · ${(run.durationMs / 1000).toFixed(1)}s`;
}

function isSuggested(path: string, suggestions: readonly string[]): boolean {
  const normalized = path.replace(/\\/g, "/");
  return suggestions.some((item) => {
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
  return "completed";
}

function unavailableDependencies(parentRoot: string, parentCwd: string, workerRoot: string, workerCwd: string): string[] {
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

export default function gruntExtension(pi: ExtensionAPI, runWorker = runPi) {
  let calls = 0;
  const sessionPatchArtifacts = new Set<string>();
  const resolveModel = async (ctx: any) => {
    const config = await loadConfig();
    if (!config.model) return ctx.model;
    const ref = parseModelRef(config.model);
    return ref ? ctx.modelRegistry.find(ref.provider, ref.id) : undefined;
  };
  const disposeHealth = pi.events.on("pi-conductor:health-request", (request: any) => {
    if (request?.version !== 1 || typeof request.respond !== "function") return;
    request.respond((async () => {
      const config = await loadConfig();
      return {
        version: 1, owner: "pi-grunt", label: "Grunt",
        lines: [`State: ${config.disabled ? "disabled" : isGruntEnabled(config) ? "active" : "inactive"}`, `Model: ${config.model ?? "current main model"}`, `Execution: synchronous ${gruntMode(config) === "isolated" ? "isolated Git worktree" : gruntMode(config) === "direct" ? "DIRECT current working directory" : "DYNAMIC (isolated with Git HEAD, direct otherwise)"}`],
        warning: gruntMode(config) !== "isolated",
      };
    })());
  });
  const refreshTool = async () => {
    const enabled = isGruntEnabled(await loadConfig());
    let coordinated = false;
    pi.events.emit("pi-conductor:tool-policy", {
      version: 1, kind: "register", owner: "pi-grunt",
      managedTools: ["grunt"], enabledTools: enabled ? ["grunt"] : [],
      acknowledge: () => { coordinated = true; },
    });
    if (coordinated) return;
    const active = pi.getActiveTools().filter((name) => name !== "grunt");
    if (enabled) active.push("grunt");
    pi.setActiveTools(active);
  };

  pi.on("session_start", async () => {
    await pruneStalePatchArtifacts();
    await refreshTool();
  });
  pi.on("input", (event) => {
    if (event.source !== "extension" && event.streamingBehavior !== "steer") calls = 0;
  });
  pi.on("session_shutdown", async () => {
    await cleanupSessionPatchArtifacts(sessionPatchArtifacts);
    sessionPatchArtifacts.clear();
    disposeHealth();
    pi.events.emit("pi-conductor:tool-policy", { version: 1, kind: "unregister", owner: "pi-grunt" });
  });

  pi.registerTool({
    name: "grunt",
    label: "Grunt",
    description: "Run one synchronous delegated implementation worker using the configured execution mode. Isolated mode is default; direct mode edits the current working directory immediately; dynamic mode chooses based on Git HEAD availability. Calls are unlimited per original user prompt. Main model retains review and final verification.",
    promptSnippet: "Delegate a compact implementation slice or complete non-difficult change to a synchronous worker",
    promptGuidelines: [
      "Use estimated changed LOC only as a soft routing guide: small is under 50 LOC, medium is 50–400 LOC inclusive, and large is over 400 LOC. Keep small/local work in the main model. Use grunt for medium changes with compact handoffs and easy validation, or large mechanical changes. Large non-mechanical work must be decomposed into coherent sequential slices; prefer roughly 200–300 changed LOC or less per semantic slice. Delegate a whole large change only when behavior is simple and validation is decisive. Reasoning complexity, architectural coupling, handoff compactness, and validation ease override LOC; a tiny security or concurrency change may still be difficult. Main model must own difficult architecture, integration, review, and final verification. Select thinking by reasoning complexity, not diff size. Grunt calls are unlimited per original user prompt, but dependent slices must be sequential: invoke one Grunt, inspect its applied changes, run focused verification, then invoke the next Grunt. Do not issue dependent Grunt calls in one assistant response because the later handoff cannot incorporate earlier results. Before grunt on consequential architecturally coupled work, use advisor at least once when available; use a later advisor call when implementation creates material new uncertainty. In default isolated mode, Grunt applies changes only after successful completion and a stale-parent check; blocked or failed work remains unapplied. Inspect applied or direct changes and run verify after grunt before claiming completion.",
      "Provide grunt suggestedPaths whenever the main model has reliable implementation anchors from its existing context or repository evidence. Include the narrowest useful files or directories; omit suggestedPaths rather than guessing stale or uncertain paths. Suggested paths guide discovery and scope but are not an allowlist.",
      "After any grunt result, the main model owns recovery. Inspect completed changes or any partial patch artifact, then fix small/local defects and finish small remaining work directly instead of spawning another worker. Do not call grunt merely to verify or repair the previous worker. Re-delegate only when the remaining work is still medium or large, self-contained, easy to validate, and likely cheaper than main-model completion.",
      "Grunt direct execution, whether configured directly or selected by dynamic mode outside Git, edits the current working directory immediately. It provides no rollback, stale-parent check, changed-path derivation, or protection from partial edits after failure or cancellation.",
    ],
    parameters: Type.Object({
      task: Type.String({ minLength: 1, maxLength: 8000, description: "Self-contained implementation handoff including decisions and acceptance criteria" }),
      thinking: StringEnum(thinkingLevels, { description: "Worker thinking effort selected by the main model" }),
      suggestedPaths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 40, uniqueItems: true, description: "Scope guidance, not an allowlist" })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_id, params, signal, onUpdate, ctx) {
      const config = await loadConfig();
      if (!isGruntEnabled(config)) return { content: [{ type: "text" as const, text: "Grunt inactive. Configure it with /grunt or use /grunt reset." }], details: { status: "disabled" } };
      const task = params.task.trim();
      if (!task) return { content: [{ type: "text" as const, text: "Grunt task must not be empty." }], details: { status: "invalid" } };
      const model = await resolveModel(ctx);
      if (!model) return { content: [{ type: "text" as const, text: "Grunt unavailable: no selected model." }], details: { status: "unavailable" } };
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) return { content: [{ type: "text" as const, text: "Grunt unavailable: selected model has no credentials." }], details: { status: "unavailable", model: modelName(model) } };
      calls++;

      const exec = pi.exec.bind(pi);
      const configuredMode = gruntMode(config);
      let mode = await resolveExecutionMode(configuredMode, exec, ctx.cwd);
      let isolated;
      let isolationFallback: string | undefined;
      if (mode === "isolated") {
        try {
          isolated = await createIsolatedWorktree(exec, ctx.cwd, signal);
        } catch (error: any) {
          const message = error?.message ?? String(error);
          if (configuredMode !== "dynamic") throw new Error(`Grunt isolation unavailable: ${message}`);
          mode = "direct";
          isolationFallback = message;
        }
      }
      const workerCwd = isolated?.workerCwd ?? ctx.cwd;

      const contextChars = gruntParentContextChars();
      const entries = contextChars ? ctx.sessionManager?.buildContextEntries?.() ?? ctx.sessionManager?.getBranch?.() ?? [] : [];
      const parentContext = contextChars ? buildWorkerContext(entries, contextChars) : "";
      const suggested = params.suggestedPaths ?? [];
      const missingDependencies = isolated
        ? unavailableDependencies(isolated.parentRoot, isolated.parentCwd, isolated.workerRoot, isolated.workerCwd)
        : [];
      const dependencyNote = missingDependencies.length
        ? `\n\nUnavailable ignored dependency directories: ${missingDependencies.join(", ")}. Do not install dependencies; skip checks requiring them and report that limitation.`
        : "";
      const prompt = `Implementation task:\n${task}${suggested.length ? `\n\nSuggested paths (guidance only):\n${suggested.map((path) => `- ${path}`).join("\n")}` : ""}${dependencyNote}${parentContext ? `\n\nBounded redacted parent context (background only; task above is authoritative):\n${parentContext}` : ""}`;
      const args = [
        "--mode", "json", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
        "--tools", "read,grep,find,ls,edit,write,bash", "--model", modelName(model), "--thinking", params.thinking,
        "--append-system-prompt", mode === "isolated" ? WORKER_PROMPT : DIRECT_WORKER_PROMPT, prompt,
      ];
      const runningText = mode === "isolated" ? "implementing in isolation" : "DIRECT — editing current working directory";
      if (ctx.hasUI) ctx.ui.setStatus("pi-grunt", `grunt: ${runningText}…`);
      onUpdate?.({ content: [{ type: "text", text: `Grunt ${runningText}…` }], details: { state: "running", mode, configuredMode, model: modelName(model), thinking: params.thinking } });
      const started = Date.now();
      let activity: readonly WorkerActivity[] = [];
      let lastUpdateAt = started;
      const heartbeat = setInterval(() => {
        const now = Date.now();
        if (now - lastUpdateAt < HEARTBEAT_MS) return;
        onUpdate?.({ content: [{ type: "text", text: `${((now - started) / 1000).toFixed(0)}s` }], details: { state: "running", mode, configuredMode, model: modelName(model), thinking: params.thinking, durationMs: now - started, activity } });
      }, HEARTBEAT_MS);
      heartbeat.unref();
      try {
        const run = await runWorker(args, {
          cwd: workerCwd, signal, timeoutMs: gruntTimeoutMs(),
          maxTurns: gruntMaxTurns(), maxCostUsd: gruntMaxCostUsd(),
          onActivity: (_item: WorkerActivity, all: readonly WorkerActivity[]) => {
            activity = all; lastUpdateAt = Date.now();
            onUpdate?.({ content: [{ type: "text", text: `Grunt activity:\n${activityText(all)}` }], details: { state: "running", mode, configuredMode, model: modelName(model), thinking: params.thinking, durationMs: lastUpdateAt - started, activity: all } });
          },
        });
        if (run.cwd !== workerCwd)
          throw new Error(`Worker runner did not confirm the ${mode} working directory`);
        if (!isolated) {
          const status = derivedStatus(run, 0);
          const recovery = status !== "completed";
          const lines = [
            `Worker status: ${status}.`,
            "Execution mode: DIRECT; worker edits affected the current working directory immediately.",
            "Rollback and changed-path derivation: unavailable.",
            isolationFallback ? `Dynamic isolation fallback: ${isolationFallback}` : "",
            recovery && run.error ? `Worker failure: ${run.error}` : "",
            recovery && run.text ? `\nWorker report:\n${run.text}` : "",
          ].filter(Boolean);
          return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
            details: {
              status, mode, configuredMode, isolationFallback, isolated: false, workerCwd: run.cwd,
              ...(recovery ? { task, suggestedPaths: suggested } : {}),
              model: modelName(model), thinking: params.thinking, durationMs: run.durationMs,
              usage: run.usage, turns: run.turns, activity: run.activity, stopReason: run.stopReason,
              truncated: run.truncated, stderr: run.stderr, failureCode: run.failure,
            },
          };
        }
        const worker = await collectWorkerPatch(exec, isolated);
        let status = derivedStatus(run, worker.changedPaths.length);
        let applied = false;
        let artifactPath: string | undefined;
        let failureCode: string | undefined = run.failure;
        let integrationError = "";

        if (status === "completed") {
          const parentChanges = await parentChangesSinceBaseline(exec, isolated);
          if (parentChanges.length) {
            status = "stale";
            failureCode = "stale_parent";
            integrationError = `Parent changed while worker ran: ${parentChanges.join(", ")}.`;
          } else {
            try {
              await applyWorkerPatch(exec, isolated, worker.patch);
              applied = true;
            } catch (error: any) {
              integrationError = error?.message ?? String(error);
              const stale = integrationError.startsWith("Parent changed immediately before patch apply:");
              status = stale ? "stale" : "failed";
              failureCode = stale ? "stale_parent" : "apply_failed";
            }
          }
        }
        if (!applied && worker.patch) {
          artifactPath = await persistPatchArtifact(worker.patch);
          if (artifactPath) sessionPatchArtifacts.add(artifactPath);
        }

        const cwdPrefix = relative(isolated.parentRoot, isolated.parentCwd).replace(/\\/g, "/");
        const suggestionPath = (path: string) => cwdPrefix && path.startsWith(`${cwdPrefix}/`) ? path.slice(cwdPrefix.length + 1) : path;
        const outsideSuggestedPaths = suggested.length ? worker.changedPaths.filter((path) => !isSuggested(suggestionPath(path), suggested)) : [];
        const preExistingDirtyTouched = worker.changedPaths.filter((path) => isolated.parentBaseline.paths.has(path));
        const recovery = status !== "completed";
        const lines = [
          `Worker status: ${status}.`,
          `Isolation verified: ${isolated.isolationVerified ? "yes" : "no"}.`,
          `Parent patch applied: ${applied ? "yes" : "no"}.`,
          recovery ? `Derived changed paths: ${worker.changedPaths.join(", ") || "none"}.` : "",
          recovery && preExistingDirtyTouched.length ? `Pre-existing dirty paths touched in isolated snapshot: ${preExistingDirtyTouched.join(", ")}.` : "",
          recovery && outsideSuggestedPaths.length ? `Outside suggested paths: ${outsideSuggestedPaths.join(", ")}.` : "",
          artifactPath ? `Unapplied patch artifact: ${artifactPath}.` : "",
          integrationError ? `Integration failure: ${integrationError}` : "",
          recovery && run.error ? `Worker failure: ${run.error}` : "",
          recovery && run.text ? `\nWorker report:\n${run.text}` : "",
        ].filter(Boolean);
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            status, applied, mode, configuredMode, isolated: true, isolationVerified: isolated.isolationVerified,
            workerCwd: run.cwd, workerHead: isolated.workerHead, artifactPath,
            ...(recovery ? { task, suggestedPaths: suggested, missingDependencies, changedPaths: worker.changedPaths, preExistingDirtyTouched, outsideSuggestedPaths } : {}),
            model: modelName(model), thinking: params.thinking, durationMs: run.durationMs,
            usage: run.usage, turns: run.turns, activity: run.activity, stopReason: run.stopReason,
            truncated: run.truncated, stderr: run.stderr, failureCode,
          },
        };
      } catch (error: any) {
        return {
          content: [{ type: "text" as const, text: mode === "isolated" ? `Grunt failed in isolated worktree; parent unchanged. ${error?.message ?? String(error)}` : `Grunt failed in DIRECT mode; partial edits may remain. ${error?.message ?? String(error)}` }],
          details: { status: "failed", mode, configuredMode, applied: mode === "isolated" ? false : undefined, isolated: mode === "isolated", failureCode: mode === "isolated" ? "isolation_error" : "worker_error", model: modelName(model), thinking: params.thinking },
        };
      } finally {
        clearInterval(heartbeat);
        const cleanupWarnings = isolated ? await removeIsolatedWorktree(exec, isolated) : [];
        if (cleanupWarnings.length) {
          const text = `Grunt cleanup warning: ${cleanupWarnings.join("; ")}`;
          if (ctx.hasUI) ctx.ui.notify(text, "warning");
          else onUpdate?.({ content: [{ type: "text", text }], details: { state: "cleanup_warning", cleanupWarnings } });
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
      const color = context?.isError || details?.failureCode === "isolation_error"
        ? "error"
        : details?.state === "running" || details?.status === "completed" ? "success" : "warning";
      const modeLabel = details?.configuredMode === "dynamic"
        ? ` · DYNAMIC/${details?.mode === "direct" ? "DIRECT" : "ISOLATED"}`
        : details?.mode === "direct" ? " · DIRECT" : "";
      let text = theme.fg(color, `Grunt · ${details?.model ?? "Unavailable"}${modeLabel}`);
      if (details?.usage) text += ` · ${usageText({ usage: details.usage, turns: details.turns, durationMs: details.durationMs } as WorkerRun)}`;
      else if (details?.durationMs) text += ` · ${(details.durationMs / 1000).toFixed(0)}s`;
      if (expanded && details?.activity?.length) text += `\n\nChild activity:\n${activityText(details.activity)}`;
      if (expanded && body?.text) text += `\n\nGrunt report:\n${body.text}`;
      return new Text(text, 0, 0);
    },
  });

  pi.registerCommand("grunt", {
    description: "Select worker model, execution mode, reset, disable, or show status",
    handler: async (args, ctx) => {
      const value = args.trim();
      if (value === "disable") {
        await saveConfig({ ...await loadConfig(), version: 1, disabled: true }); await refreshTool();
        ctx.ui.notify("Grunt disabled.", "info"); return;
      }
      if (value === "reset") {
        await saveConfig({ version: 1, disabled: false, mode: "isolated" }); await refreshTool();
        ctx.ui.notify("Grunt reset to current main model in isolated mode.", "info"); return;
      }
      if (value === "isolated" || value === "direct" || value === "dynamic") {
        const config = await loadConfig();
        await saveConfig({ ...config, mode: value }); await refreshTool();
        const message = value === "isolated"
          ? "Grunt mode: isolated Git worktree."
          : value === "direct"
            ? "Grunt mode: DIRECT. Worker edits affect the current working directory immediately."
            : "Grunt mode: dynamic. Uses isolation with a Git HEAD; DIRECT otherwise.";
        ctx.ui.notify(message, value === "direct" ? "warning" : "info"); return;
      }
      if (value === "status") {
        const config = await loadConfig();
        const model = await resolveModel(ctx);
        const state = config.disabled ? "disabled" : !isGruntEnabled(config) ? "inactive" : model ? "active" : "unavailable";
        ctx.ui.notify(`Model: ${config.model ?? "current main model"}\nState: ${state}\nMode: ${gruntMode(config)}\nThinking: selected by main model per call`, "info"); return;
      }
      let selected = value;
      if (!selected) {
        if (ctx.mode !== "tui") { ctx.ui.notify("Usage: /grunt <provider/model-id>|isolated|direct|dynamic|status|reset|disable", "info"); return; }
        selected = (await ctx.ui.select("Grunt worker model", ctx.modelRegistry.getAvailable().map(modelName))) ?? "";
        if (!selected) return;
      }
      const ref = parseModelRef(selected);
      const model = ref && ctx.modelRegistry.find(ref.provider, ref.id);
      if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) { ctx.ui.notify(`Unavailable model: ${selected}`, "error"); return; }
      await saveConfig({ ...await loadConfig(), version: 1, model: modelName(model), disabled: false }); await refreshTool();
      ctx.ui.notify(`Grunt model: ${modelName(model)}\nThinking: selected by main model per call`, "info");
    },
  });
}
