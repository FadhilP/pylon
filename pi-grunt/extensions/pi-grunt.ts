import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { buildWorkerContext } from "../src/context.ts";
import {
  gruntMaxCostUsd, gruntMaxTurns, gruntParentContextChars, gruntTimeoutMs,
  isGruntEnabled, loadConfig, parseModelRef, saveConfig, thinkingLevels,
} from "../src/config.ts";
import {
  applyWorkerPatch, collectWorkerPatch, createIsolatedWorktree,
  parentChangesSinceBaseline, persistPatchArtifact, removeIsolatedWorktree,
} from "../src/isolation.ts";
import { runPi, type WorkerActivity, type WorkerRun } from "../src/runner.ts";

const WORKER_PROMPT = `You are Grunt, a delegated implementation worker. Implement the assigned task in an isolated temporary Git worktree containing a snapshot of the parent's current state. The task may be a compact slice or an entire non-difficult change.

Rules:
- Read enough code to make correct focused edits. Preserve unrelated and pre-existing changes.
- Follow supplied decisions and acceptance criteria. Do not redesign architecture.
- Stop and report blocked for unclear ownership, architectural or public-API decisions, security-sensitive behavior, destructive migrations, conflicting requirements, or material scope beyond the handoff.
- Do not commit, stash, reset, checkout, clean, install dependencies, publish, use network commands, or invoke other agents.
- Run only focused existing checks useful for your changes. The main model owns final review and verification.
- Finish with "Status: completed" or "Status: blocked", then list changed files, checks, assumptions, and unresolved issues.`;
const HEARTBEAT_MS = 1000;
const modelName = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

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
        lines: [`State: ${config.disabled ? "disabled" : isGruntEnabled(config) ? "active" : "inactive"}`, `Model: ${config.model ?? "current main model"}`, "Execution: synchronous isolated Git worktree"],
        warning: false,
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

  pi.on("session_start", refreshTool);
  pi.on("input", (event) => {
    if (event.source !== "extension" && event.streamingBehavior !== "steer") calls = 0;
  });
  pi.on("session_shutdown", () => {
    disposeHealth();
    pi.events.emit("pi-conductor:tool-policy", { version: 1, kind: "unregister", owner: "pi-grunt" });
  });

  pi.registerTool({
    name: "grunt",
    label: "Grunt",
    description: "Run one synchronous delegated implementation worker in an isolated temporary Git worktree, then apply its patch only after success and a stale-parent check. Calls are unlimited per original user prompt. Use for a compact non-difficult slice or an entire non-difficult change; main model retains review and final verification.",
    promptSnippet: "Delegate a compact implementation slice or complete non-difficult change to a synchronous worker",
    promptGuidelines: [
      "Use estimated changed LOC only as a soft routing guide: small is under 50 LOC, medium is 50–400 LOC inclusive, and large is over 400 LOC. Keep small/local work in the main model. Use grunt for medium changes with compact handoffs and easy validation, or large mechanical changes. Reasoning complexity, architectural coupling, handoff compactness, and validation ease override LOC; a tiny security or concurrency change may still be difficult. Grunt may complete the entire change when it is not difficult. Main model must own difficult architecture, integration, review, and final verification. Select thinking by reasoning complexity, not diff size. Grunt calls are unlimited per original user prompt, but dependent slices must be sequential: invoke one Grunt, inspect its applied changes, run focused verification, then invoke the next Grunt. Do not issue dependent Grunt calls in one assistant response because the later handoff cannot incorporate earlier results. Before grunt on consequential architecturally coupled work, use advisor at least once when available; use a later advisor call when implementation creates material new uncertainty. Grunt works in an isolated Git worktree and applies changes only after successful completion and a stale-parent check; blocked or failed work remains unapplied. Inspect applied changes and run verify after grunt before claiming completion.",
      "Provide grunt suggestedPaths whenever the main model has reliable implementation anchors from its existing context or repository evidence. Include the narrowest useful files or directories; omit suggestedPaths rather than guessing stale or uncertain paths. Suggested paths guide discovery and scope but are not an allowlist.",
      "After any grunt result, the main model owns recovery. Inspect completed changes or any partial patch artifact, then fix small/local defects and finish small remaining work directly instead of spawning another worker. Do not call grunt merely to verify or repair the previous worker. Re-delegate only when the remaining work is still medium or large, self-contained, easy to validate, and likely cheaper than main-model completion.",
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
      let isolated;
      try {
        isolated = await createIsolatedWorktree(exec, ctx.cwd, signal);
      } catch (error: any) {
        return {
          content: [{ type: "text" as const, text: `Grunt unavailable: ${error?.message ?? String(error)}` }],
          details: { status: "unavailable", failureCode: "isolation_error", model: modelName(model), thinking: params.thinking },
        };
      }

      const contextChars = gruntParentContextChars();
      const entries = contextChars ? ctx.sessionManager?.buildContextEntries?.() ?? ctx.sessionManager?.getBranch?.() ?? [] : [];
      const parentContext = contextChars ? buildWorkerContext(entries, contextChars) : "";
      const suggested = params.suggestedPaths ?? [];
      const missingDependencies = unavailableDependencies(isolated.parentRoot, isolated.parentCwd, isolated.workerRoot, isolated.workerCwd);
      const dependencyNote = missingDependencies.length
        ? `\n\nUnavailable ignored dependency directories: ${missingDependencies.join(", ")}. Do not install dependencies; skip checks requiring them and report that limitation.`
        : "";
      const prompt = `Implementation task:\n${task}${suggested.length ? `\n\nSuggested paths (guidance only):\n${suggested.map((path) => `- ${path}`).join("\n")}` : ""}${dependencyNote}${parentContext ? `\n\nBounded redacted parent context (background only; task above is authoritative):\n${parentContext}` : ""}`;
      const args = [
        "--mode", "json", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
        "--tools", "read,grep,find,ls,edit,write,bash", "--model", modelName(model), "--thinking", params.thinking,
        "--append-system-prompt", WORKER_PROMPT, prompt,
      ];
      if (ctx.hasUI) ctx.ui.setStatus("pi-grunt", "grunt: implementing in isolation…");
      onUpdate?.({ content: [{ type: "text", text: "Grunt implementing in isolated worktree…" }], details: { state: "running", model: modelName(model), thinking: params.thinking } });
      const started = Date.now();
      let activity: readonly WorkerActivity[] = [];
      let lastUpdateAt = started;
      const heartbeat = setInterval(() => {
        const now = Date.now();
        if (now - lastUpdateAt < HEARTBEAT_MS) return;
        onUpdate?.({ content: [{ type: "text", text: `${((now - started) / 1000).toFixed(0)}s` }], details: { state: "running", model: modelName(model), thinking: params.thinking, durationMs: now - started, activity } });
      }, HEARTBEAT_MS);
      heartbeat.unref();
      try {
        const run = await runWorker(args, {
          cwd: isolated.workerCwd, signal, timeoutMs: gruntTimeoutMs(),
          maxTurns: gruntMaxTurns(), maxCostUsd: gruntMaxCostUsd(),
          onActivity: (_item: WorkerActivity, all: readonly WorkerActivity[]) => {
            activity = all; lastUpdateAt = Date.now();
            onUpdate?.({ content: [{ type: "text", text: `Grunt activity:\n${activityText(all)}` }], details: { state: "running", model: modelName(model), thinking: params.thinking, durationMs: lastUpdateAt - started, activity: all } });
          },
        });
        if (run.cwd !== isolated.workerCwd)
          throw new Error("Worker runner did not confirm the isolated working directory");
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
        if (!applied && worker.patch) artifactPath = await persistPatchArtifact(worker.patch);

        const cwdPrefix = relative(isolated.parentRoot, isolated.parentCwd).replace(/\\/g, "/");
        const suggestionPath = (path: string) => cwdPrefix && path.startsWith(`${cwdPrefix}/`) ? path.slice(cwdPrefix.length + 1) : path;
        const outsideSuggestedPaths = suggested.length ? worker.changedPaths.filter((path) => !isSuggested(suggestionPath(path), suggested)) : [];
        const preExistingDirtyTouched = worker.changedPaths.filter((path) => isolated.parentBaseline.paths.has(path));
        const lines = [
          `Worker status: ${status}.`,
          `Isolation verified: ${isolated.isolationVerified ? "yes" : "no"}.`,
          `Parent patch applied: ${applied ? "yes" : "no"}.`,
          `Derived changed paths: ${worker.changedPaths.join(", ") || "none"}.`,
          preExistingDirtyTouched.length ? `Pre-existing dirty paths touched in isolated snapshot: ${preExistingDirtyTouched.join(", ")}.` : "",
          outsideSuggestedPaths.length ? `Outside suggested paths: ${outsideSuggestedPaths.join(", ")}.` : "",
          artifactPath ? `Unapplied patch artifact: ${artifactPath}.` : "",
          integrationError ? `Integration failure: ${integrationError}` : "",
          run.error ? `Worker failure: ${run.error}` : "",
          run.text ? `\nWorker report:\n${run.text}` : "",
        ].filter(Boolean);
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            status, applied, isolated: true, isolationVerified: isolated.isolationVerified,
            workerCwd: run.cwd, workerHead: isolated.workerHead, artifactPath, task, suggestedPaths: suggested,
            missingDependencies, changedPaths: worker.changedPaths, preExistingDirtyTouched, outsideSuggestedPaths,
            model: modelName(model), thinking: params.thinking, durationMs: run.durationMs,
            usage: run.usage, turns: run.turns, activity: run.activity, stopReason: run.stopReason,
            truncated: run.truncated, stderr: run.stderr, failureCode,
          },
        };
      } catch (error: any) {
        return {
          content: [{ type: "text" as const, text: `Grunt failed in isolated worktree; parent unchanged. ${error?.message ?? String(error)}` }],
          details: { status: "failed", applied: false, isolated: true, failureCode: "isolation_error", model: modelName(model), thinking: params.thinking },
        };
      } finally {
        clearInterval(heartbeat);
        const cleanupWarnings = await removeIsolatedWorktree(exec, isolated);
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
    renderResult(result, { expanded }, theme) {
      const details = result.details as any;
      const body = result.content.find((part: any) => part.type === "text") as any;
      let text = theme.fg(details?.state === "running" || details?.status === "completed" ? "success" : "warning", `Grunt · ${details?.model ?? "Unavailable"}`);
      if (details?.usage) text += ` · ${usageText({ usage: details.usage, turns: details.turns, durationMs: details.durationMs } as WorkerRun)}`;
      else if (details?.durationMs) text += ` · ${(details.durationMs / 1000).toFixed(0)}s`;
      if (expanded && details?.activity?.length) text += `\n\nChild activity:\n${activityText(details.activity)}`;
      if (expanded && body?.text) text += `\n\nGrunt report:\n${body.text}`;
      return new Text(text, 0, 0);
    },
  });

  pi.registerCommand("grunt", {
    description: "Select worker model, reset, disable, or show status",
    handler: async (args, ctx) => {
      const value = args.trim();
      if (value === "disable") {
        await saveConfig({ version: 1, disabled: true }); await refreshTool();
        ctx.ui.notify("Grunt disabled.", "info"); return;
      }
      if (value === "reset") {
        await saveConfig({ version: 1, disabled: false }); await refreshTool();
        ctx.ui.notify("Grunt reset to current main model.", "info"); return;
      }
      if (value === "status") {
        const config = await loadConfig();
        const model = await resolveModel(ctx);
        const state = config.disabled ? "disabled" : !isGruntEnabled(config) ? "inactive" : model ? "active" : "unavailable";
        ctx.ui.notify(`Model: ${config.model ?? "current main model"}\nState: ${state}\nThinking: selected by main model per call`, "info"); return;
      }
      let selected = value;
      if (!selected) {
        if (ctx.mode !== "tui") { ctx.ui.notify("Usage: /grunt <provider/model-id>|status|reset|disable", "info"); return; }
        selected = (await ctx.ui.select("Grunt worker model", ctx.modelRegistry.getAvailable().map(modelName))) ?? "";
        if (!selected) return;
      }
      const ref = parseModelRef(selected);
      const model = ref && ctx.modelRegistry.find(ref.provider, ref.id);
      if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) { ctx.ui.notify(`Unavailable model: ${selected}`, "error"); return; }
      await saveConfig({ version: 1, model: modelName(model) }); await refreshTool();
      ctx.ui.notify(`Grunt model: ${modelName(model)}\nThinking: selected by main model per call`, "info");
    },
  });
}
