import { createHash, randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  truncateTail,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { detectChecks } from "../src/detect.ts";

type Result = {
  id: string;
  label: string;
  command: string;
  code: number | null;
  output: string;
  truncated: boolean;
  durationMs: number;
};
type VerificationState = "passed" | "failed" | "cancelled" | "stale" | "error" | "no_checks" | "clean";
type Details = {
  scope: "changed" | "project";
  runId: string;
  state: VerificationState;
  worktreeId?: string;
  initialWorktreeId?: string;
  startedAt: string;
  finishedAt: string;
  skipped?: string;
  omittedChecks?: string[];
  unrunChecks?: string[];
  results: Result[];
};

export default function (pi: ExtensionAPI) {
  let latestContext: any;
  const worktreeState = async (cwd: string, signal?: AbortSignal) => {
    try {
      const [head, status] = await Promise.all([
        pi.exec("git", ["rev-parse", "HEAD"], { cwd, signal, timeout: 15_000 }),
        pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd, signal, timeout: 15_000 }),
      ]);
      if (head.code !== 0 || status.code !== 0) return undefined;
      const value = `${head.stdout.trim()}\n${status.stdout}`;
      return {
        id: createHash("sha256").update(value).digest("hex").slice(0, 16),
        dirty: Boolean(status.stdout.trim()),
      };
    } catch {
      return undefined;
    }
  };
  const publish = (details: Details, cwd: string) => {
    const event = { version: 1 as const, cwd, ...details };
    pi.events.emit("pi-verify:result", event);
    pi.events.emit("pi-verify:lifecycle", event);
    latestContext = {
      ...event,
      results: details.results.map(({ output: _output, ...result }) => result),
    };
    pi.appendEntry("pi-verify-result", {
      ...event,
      results: details.results.map(({ output: _output, ...result }) => result),
    });
  };
  pi.on("session_start", (_event, ctx) => {
    latestContext = ([...(ctx.sessionManager.getEntries?.() ?? [])]
      .reverse()
      .find((entry: any) => entry.type === "custom" && entry.customType === "pi-verify-result" && entry.data?.version === 1) as any)
      ?.data;
  });
  pi.on("context", (event) => latestContext ? {
    messages: [...event.messages, {
      role: "custom",
      customType: "pi-verify-result",
      content: JSON.stringify(latestContext),
      display: false,
      timestamp: Date.now(),
    }],
  } : undefined);
  pi.registerTool({
    name: "verify",
    label: "Verify",
    description:
      "Detect and run existing project verification commands with bounded output. Discovers immediate child packages when root declares no checks. Scope changed skips clean Git worktrees; project always runs. Optionally select up to six stable check IDs.",
    promptSnippet: "Run detected project checks and return bounded failures",
    promptGuidelines: [
      "Use verify after code changes before claiming completion. Use scope changed for normal edits and project for broad refactors or release checks. Verify runs only commands declared or implied by recognized project manifests; never use it to install dependencies.",
    ],
    parameters: Type.Object(
      {
        scope: StringEnum(["changed", "project"] as const),
        checks: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 6, uniqueItems: true })),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, onUpdate, ctx) {
      const runId = randomUUID();
      const startedAt = new Date().toISOString();
      const initial = await worktreeState(ctx.cwd, signal);
      const initialIdentity = initial?.id;
      if (ctx.hasUI) ctx.ui.setStatus("pi-verify", "Verify: running");
      pi.events.emit("pi-verify:lifecycle", {
        version: 1, runId, cwd: ctx.cwd, scope: params.scope, state: "running", worktreeId: initialIdentity, startedAt,
      });
      if (params.scope === "changed") {
        if (initial && !initial.dirty) {
          const details: Details = {
            scope: params.scope, runId, state: "clean", worktreeId: initialIdentity,
            initialWorktreeId: initialIdentity, startedAt, finishedAt: new Date().toISOString(),
            skipped: "Git worktree is clean.", results: [],
          };
          publish(details, ctx.cwd);
          if (ctx.hasUI) ctx.ui.setStatus("pi-verify", "Verify: clean · not verified");
          return { content: [{ type: "text" as const, text: details.skipped! }], details };
        }
      }

      const detection = await detectChecks(ctx.cwd);
      const requested = params.checks ?? [];
      const unknown = requested.filter((id: string) => !detection.available.some((check) => check.id === id));
      if (unknown.length) {
        const details: Details = {
          scope: params.scope, runId, state: "error", worktreeId: initialIdentity,
          initialWorktreeId: initialIdentity, startedAt, finishedAt: new Date().toISOString(),
          skipped: `Unknown check ID(s): ${unknown.join(", ")}. Available: ${detection.available.map((check) => check.id).join(", ") || "none"}.`, results: [],
        };
        publish(details, ctx.cwd);
        if (ctx.hasUI) ctx.ui.setStatus("pi-verify", "Verify: invalid selection");
        return { content: [{ type: "text" as const, text: details.skipped! }], details };
      }
      const checks = requested.length
        ? requested.map((id: string) => detection.available.find((check) => check.id === id)!)
        : detection.checks;
      const omittedChecks = requested.length ? [] : detection.omitted.map((check) => check.id);
      if (!checks.length) {
        const details: Details = {
          scope: params.scope, runId, state: "no_checks", worktreeId: initialIdentity,
          initialWorktreeId: initialIdentity, startedAt, finishedAt: new Date().toISOString(),
          skipped: "No declared verification commands detected.", results: [],
        };
        publish(details, ctx.cwd);
        if (ctx.hasUI) ctx.ui.setStatus("pi-verify", "Verify: no checks");
        return { content: [{ type: "text" as const, text: details.skipped! }], details };
      }

      const results: Result[] = [];
      for (const [index, check] of checks.entries()) {
        if (signal?.aborted) break;
        const progress = `Verify: Running ${index + 1}/${checks.length}`;
        if (ctx.hasUI) ctx.ui.setStatus("pi-verify", progress);
        pi.events.emit("pi-verify:lifecycle", {
          version: 1, runId, cwd: ctx.cwd, scope: params.scope, state: "running",
          worktreeId: initialIdentity, startedAt, completed: index, total: checks.length,
        });
        onUpdate?.({
          content: [{ type: "text", text: `Running ${index + 1}/${checks.length}: ${check.label}` }],
          details: { scope: params.scope, runId, state: "running", worktreeId: initialIdentity, startedAt, results },
        });
        const started = Date.now();
        const execution = await pi.exec(check.command, check.args, {
          cwd: check.cwd,
          signal,
          timeout: 5 * 60_000,
        }).catch((error: unknown) => ({
          code: null,
          stdout: "",
          stderr: `Check unavailable: ${error instanceof Error ? error.message : String(error)}`,
        }));
        const raw = [execution.stdout, execution.stderr].filter(Boolean).join("\n");
        const bounded = truncateTail(raw, { maxLines: 160, maxBytes: 12 * 1024 });
        results.push({
          id: check.id,
          label: check.label,
          command: [check.command, ...check.args].join(" "),
          code: execution.code,
          output: bounded.content.trim(),
          truncated: bounded.truncated,
          durationMs: Date.now() - started,
        });
        if (execution.code !== 0) break;
      }

      const passed = results.length === checks.length && results.every((result) => result.code === 0);
      const summary = results
        .map((result) => `${result.code === 0 ? "PASS" : "FAIL"} ${result.command} (${(result.durationMs / 1000).toFixed(1)}s)${result.output ? `\n${result.output}` : ""}${result.truncated ? "\n[output truncated]" : ""}`)
        .join("\n\n");
      const finalIdentity = (await worktreeState(ctx.cwd, signal))?.id;
      const state: VerificationState = signal?.aborted
        ? "cancelled"
        : !initialIdentity || !finalIdentity
          ? "error"
          : initialIdentity !== finalIdentity
            ? "stale"
            : passed
              ? "passed"
              : "failed";
      const unrunChecks = checks.slice(results.length).map((check) => check.id);
      const details: Details = {
        scope: params.scope, runId, state, worktreeId: finalIdentity,
        initialWorktreeId: initialIdentity, startedAt, finishedAt: new Date().toISOString(),
        ...(omittedChecks.length ? { omittedChecks } : {}),
        ...(unrunChecks.length ? { unrunChecks } : {}), results,
      };
      publish(details, ctx.cwd);
      if (ctx.hasUI) ctx.ui.setStatus("pi-verify", `Verify: ${state}`);
      const outcome = state === "passed" ? "Verification passed."
        : state === "cancelled" ? "Verification cancelled."
          : state === "stale" ? "Verification stale: worktree changed during checks."
            : state === "error" ? "Verification error."
              : "Verification failed.";
      return {
        content: [{ type: "text" as const, text: `${outcome}\n\n${summary}${unrunChecks.length ? `\n\nNot run after stop: ${unrunChecks.join(", ")}.` : ""}${omittedChecks.length ? `\n\nSkipped by six-check cap: ${omittedChecks.join(", ")}. Pass checks to select them explicitly.` : ""}` }],
        details,
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("Verify ")) + theme.fg("muted", `${args.scope}${args.checks?.length ? ` · ${args.checks.join(", ")}` : ""}`),
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as Details | undefined;
      if (!details) return new Text("Verify", 0, 0);
      if (details.skipped) return new Text(theme.fg("muted", details.skipped), 0, 0);
      const failed = details.state !== "passed";
      let text = theme.fg(failed ? "error" : "success", `Verification ${details.state}`);
      text += theme.fg("dim", ` · ${details.results.length} check(s)${details.unrunChecks?.length ? ` · ${details.unrunChecks.length} not run` : ""}${details.omittedChecks?.length ? ` · ${details.omittedChecks.length} capped` : ""}`);
      if (expanded)
        text += `\n${details.results.map((item) => `${item.code === 0 ? "PASS" : "FAIL"} ${item.command}${item.output ? `\n${item.output}` : ""}`).join("\n\n")}`;
      return new Text(text, 0, 0);
    },
  });
}
