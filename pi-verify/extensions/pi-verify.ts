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
  results: Result[];
};

export default function (pi: ExtensionAPI) {
  let latestContext: any;
  const worktreeId = async (cwd: string, signal?: AbortSignal) => {
    const [head, status] = await Promise.all([
      pi.exec("git", ["rev-parse", "HEAD"], { cwd, signal, timeout: 15_000 }),
      pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd, signal, timeout: 15_000 }),
    ]);
    const value = `${head.code === 0 ? head.stdout.trim() : "no-head"}\n${status.code === 0 ? status.stdout : "unknown"}`;
    if (head.code !== 0 || status.code !== 0) return undefined;
    return createHash("sha256").update(value).digest("hex").slice(0, 16);
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
      "Detect and run existing project verification commands with bounded output. Scope changed skips clean Git worktrees; project always runs.",
    promptSnippet: "Run detected project checks and return bounded failures",
    promptGuidelines: [
      "Use verify after code changes before claiming completion. Use scope changed for normal edits and project for broad refactors or release checks. Verify runs only commands declared or implied by recognized project manifests; never use it to install dependencies.",
    ],
    parameters: Type.Object(
      { scope: StringEnum(["changed", "project"] as const) },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, onUpdate, ctx) {
      const runId = randomUUID();
      const startedAt = new Date().toISOString();
      const initialIdentity = await worktreeId(ctx.cwd, signal);
      if (ctx.hasUI) ctx.ui.setStatus("pi-verify", "verify: running");
      pi.events.emit("pi-verify:lifecycle", {
        version: 1, runId, cwd: ctx.cwd, scope: params.scope, state: "running", worktreeId: initialIdentity, startedAt,
      });
      if (params.scope === "changed") {
        const status = await pi.exec("git", ["status", "--porcelain"], {
          cwd: ctx.cwd,
          signal,
          timeout: 15_000,
        });
        if (status.code === 0 && !status.stdout.trim()) {
          const details: Details = {
            scope: params.scope, runId, state: "clean", worktreeId: initialIdentity,
            initialWorktreeId: initialIdentity, startedAt, finishedAt: new Date().toISOString(),
            skipped: "Git worktree is clean.", results: [],
          };
          publish(details, ctx.cwd);
          if (ctx.hasUI) ctx.ui.setStatus("pi-verify", "verify: clean · not verified");
          return { content: [{ type: "text" as const, text: details.skipped! }], details };
        }
      }

      const checks = await detectChecks(ctx.cwd);
      if (!checks.length) {
        const details: Details = {
          scope: params.scope, runId, state: "no_checks", worktreeId: initialIdentity,
          initialWorktreeId: initialIdentity, startedAt, finishedAt: new Date().toISOString(),
          skipped: "No declared verification commands detected.", results: [],
        };
        publish(details, ctx.cwd);
        if (ctx.hasUI) ctx.ui.setStatus("pi-verify", "verify: no checks");
        return { content: [{ type: "text" as const, text: details.skipped! }], details };
      }

      const results: Result[] = [];
      for (const [index, check] of checks.entries()) {
        if (signal?.aborted) break;
        const progress = `verify: running ${index + 1}/${checks.length}`;
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
          cwd: ctx.cwd,
          signal,
          timeout: 5 * 60_000,
        });
        const raw = [execution.stdout, execution.stderr].filter(Boolean).join("\n");
        const bounded = truncateTail(raw, { maxLines: 160, maxBytes: 12 * 1024 });
        results.push({
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
      const finalIdentity = await worktreeId(ctx.cwd, signal);
      const state: VerificationState = signal?.aborted
        ? "cancelled"
        : !initialIdentity || !finalIdentity
          ? "error"
          : initialIdentity !== finalIdentity
            ? "stale"
            : passed
              ? "passed"
              : "failed";
      const details: Details = {
        scope: params.scope, runId, state, worktreeId: finalIdentity,
        initialWorktreeId: initialIdentity, startedAt, finishedAt: new Date().toISOString(), results,
      };
      publish(details, ctx.cwd);
      if (ctx.hasUI) ctx.ui.setStatus("pi-verify", `verify: ${state}`);
      return {
        content: [{ type: "text" as const, text: `${state === "passed" ? "Verification passed." : state === "cancelled" ? "Verification cancelled." : "Verification failed."}\n\n${summary}` }],
        details,
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("Verify ")) + theme.fg("muted", args.scope),
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
      text += theme.fg("dim", ` · ${details.results.length} check(s)`);
      if (expanded)
        text += `\n${details.results.map((item) => `${item.code === 0 ? "PASS" : "FAIL"} ${item.command}${item.output ? `\n${item.output}` : ""}`).join("\n\n")}`;
      return new Text(text, 0, 0);
    },
  });
}
