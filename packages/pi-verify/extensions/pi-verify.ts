import { createHash, randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  truncateTail,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { detectChecks } from "../src/detect.ts";

const HEARTBEAT_MS = 1_000;
const MAX_PARALLEL_DIRECTORIES = 4;

type Result = {
  id: string;
  label: string;
  command: string;
  code: number | null;
  output: string;
  truncated: boolean;
  durationMs: number;
};
type VerificationState = "running" | "passed" | "failed" | "cancelled" | "stale" | "error" | "no_checks" | "clean";
type Hygiene = {
  command: string;
  code: number | null;
  output: string;
  truncated: boolean;
  status: string;
  statusTruncated: boolean;
  durationMs: number;
};
type Details = {
  scope: "changed" | "project";
  runId: string;
  state: VerificationState;
  worktreeId?: string;
  initialWorktreeId?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  skipped?: string;
  omittedChecks?: string[];
  unrunChecks?: string[];
  hygiene?: Hygiene;
  results: Result[];
};
type VerifyPolicy = { mode: "auto" } | { mode: "selected"; checks: string[] };

export default function verifyExtension(pi: ExtensionAPI) {
  let latestContext: any;
  let currentCwd = "";
  let currentSessionId = "";
  let nonPassingState: VerificationState | undefined;
  let policy: VerifyPolicy = { mode: "auto" };
  const catalog = async (cwd: string) => {
    const detection = await detectChecks(cwd);
    return {
      version: 1,
      checks: detection.available.slice(0, 100).map((check) => ({
        id: check.id.slice(0, 100),
        label: check.label.slice(0, 200),
        command: [check.command, ...check.args].join(" ").slice(0, 500),
      })),
    };
  };
  const publishCatalog = async () => {
    if (!currentCwd) return;
    pi.events.emit("pi-verify:catalog", await catalog(currentCwd));
  };
  const disposePolicy = pi.events.on?.("pylon:runtime-policy", (value: any) => {
    if (value?.version !== 1 || value.sessionId !== currentSessionId) return;
    const verify = value.verify;
    if (verify?.mode === "auto") policy = { mode: "auto" };
    else if (verify?.mode === "selected" && Array.isArray(verify.checks)) {
      policy = {
        mode: "selected",
        checks: verify.checks
          .filter((id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 100)
          .slice(0, 6),
      };
    }
  });
  const disposeCatalog = pi.events.on?.("pi-verify:catalog-request", (request: any) => {
    if (request?.version !== 1
      || request.sessionId !== currentSessionId
      || typeof request.respond !== "function"
      || !currentCwd) return;
    request.respond(catalog(currentCwd));
  });
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
        status: status.stdout,
      };
    } catch {
      return undefined;
    }
  };
  const runHygiene = async (cwd: string, status: string, signal?: AbortSignal): Promise<Hygiene> => {
    const started = Date.now();
    const execution = await pi.exec("git", ["diff", "--check", "HEAD", "--"], {
      cwd, signal, timeout: 15_000,
    }).catch((error: unknown) => ({
      code: null,
      stdout: "",
      stderr: `Hygiene check unavailable: ${error instanceof Error ? error.message : String(error)}`,
    }));
    const output = truncateTail([execution.stdout, execution.stderr].filter(Boolean).join("\n"), {
      maxLines: 80, maxBytes: 8 * 1024,
    });
    const changed = truncateTail(status, { maxLines: 80, maxBytes: 8 * 1024 });
    return {
      command: "git diff --check HEAD --",
      code: execution.code,
      output: output.content.trim(),
      truncated: output.truncated,
      status: changed.content.trimEnd(),
      statusTruncated: changed.truncated,
      durationMs: Date.now() - started,
    };
  };
  const hygieneText = (hygiene: Hygiene) => [
    `Changed-set hygiene ${hygiene.code === 0 ? "passed" : "failed"}: ${hygiene.command}`,
    hygiene.output,
    hygiene.status ? `Changed paths:\n${hygiene.status}${hygiene.statusTruncated ? "\n[status truncated]" : ""}` : "",
  ].filter(Boolean).join("\n\n");
  const contextText = (value: any) => {
    const checks = (value.results ?? [])
      .map((result: any) => `${result.id}=${result.code ?? "error"}`)
      .join(", ");
    return [
      `Verification: ${value.state}; scope: ${value.scope}; run: ${value.runId}`,
      value.worktreeId ? `Worktree: ${value.worktreeId}` : "",
      checks ? `Checks: ${checks}` : "Checks: none",
    ].filter(Boolean).join("\n");
  };
  const publish = (details: Details, cwd: string) => {
    const event = { version: 1 as const, cwd, ...details };
    if (["failed", "cancelled", "stale", "error"].includes(details.state))
      nonPassingState = details.state;
    pi.events.emit("pi-verify:result", event);
    pi.events.emit("pi-verify:lifecycle", event);
    const hygiene = details.hygiene
      ? (({ output: _output, status: _status, ...value }) => value)(details.hygiene)
      : undefined;
    const persisted = {
      ...event,
      ...(hygiene ? { hygiene } : {}),
      results: details.results.map(({ output: _output, ...result }) => result),
    };
    latestContext = persisted;
    pi.appendEntry("pi-verify-result", persisted);
  };
  pi.on("session_start", (_event, ctx) => {
    currentCwd = ctx.cwd;
    currentSessionId = ctx.sessionManager.getSessionId();
    nonPassingState = undefined;
    latestContext = ([...(ctx.sessionManager.getEntries?.() ?? [])]
      .reverse()
      .find((entry: any) => entry.type === "custom" && entry.customType === "pi-verify-result" && entry.data?.version === 1) as any)
      ?.data;
    if (latestContext) pi.events.emit("pi-verify:lifecycle", latestContext);
    void publishCatalog();
  });
  pi.on("session_shutdown", () => {
    disposePolicy?.();
    disposeCatalog?.();
    currentCwd = "";
    currentSessionId = "";
    nonPassingState = undefined;
  });
  pi.on("input", (event) => {
    if (event.source !== "extension") nonPassingState = undefined;
  });
  pi.on("tool_call", (event) => {
    if (nonPassingState)
      return {
        block: true,
        reason: `Verification already ended this agent run with ${nonPassingState}. Write one caveated evidence-aware text-only final response and stop; do not call more tools.`,
      };
    if (["write", "edit", "bash", "heartbeat_start"].includes(event.toolName))
      latestContext = undefined;
  });
  pi.on("context", (event) => {
    if (!latestContext) return;
    const alreadyPresent = event.messages.some(
      (message: any) =>
        message.role === "toolResult" &&
        message.toolName === "verify" &&
        message.details?.runId === latestContext.runId,
    );
    if (alreadyPresent) return;
    return {
      messages: [...event.messages, {
        role: "custom",
        customType: "pi-verify-result",
        content: contextText(latestContext),
        display: false,
        timestamp: Date.now(),
      }],
    };
  });
  pi.registerTool({
    name: "verify",
    label: "Verify",
    description:
      "Run bounded changed-set hygiene, then detect and run existing project verification commands. Discovers immediate child packages when root declares no checks. Scope changed skips clean Git worktrees; project always runs. Optionally select up to six stable check IDs.",
    promptSnippet: "Run detected project checks and return bounded failures",
    promptGuidelines: [
      "Use verify after code changes before claiming completion. Call Verify in a tool-only assistant turn with no user-facing prose, wait for its result, then write exactly one evidence-aware final response. After failed, stale, cancelled, or error results, stop without another tool call. Omit checks by default; only pass exact IDs supplied by the user or verification catalog, and never infer IDs from scripts or labels. It runs git diff --check for dirty Git worktrees before declared checks. Use scope changed for normal edits and project for broad refactors or release checks. Verify never installs dependencies.",
    ],
    parameters: Type.Object(
      {
        scope: StringEnum(["changed", "project"] as const),
        checks: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 6, uniqueItems: true })),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
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

      const hygiene = initial?.dirty ? await runHygiene(ctx.cwd, initial.status, signal) : undefined;
      if (hygiene && hygiene.code !== 0) {
        const finalIdentity = (await worktreeState(ctx.cwd, signal))?.id;
        const state: VerificationState = signal?.aborted ? "cancelled"
          : hygiene.code === null || !initialIdentity || !finalIdentity ? "error"
            : initialIdentity !== finalIdentity ? "stale" : "failed";
        const details: Details = {
          scope: params.scope, runId, state, worktreeId: finalIdentity,
          initialWorktreeId: initialIdentity, startedAt, finishedAt: new Date().toISOString(),
          hygiene, results: [],
        };
        publish(details, ctx.cwd);
        if (ctx.hasUI) ctx.ui.setStatus("pi-verify", `Verify: ${state}`);
        return { content: [{ type: "text" as const, text: hygieneText(hygiene) }], details };
      }

      const detection = await detectChecks(ctx.cwd);
      const selectedPolicy = policy.mode === "selected" ? policy : undefined;
      const requested = selectedPolicy?.checks ?? params.checks ?? [];
      const unknown = requested.filter((id: string) => !detection.available.some((check) => check.id === id));
      if (unknown.length) {
        const details: Details = {
          scope: params.scope, runId, state: "error", worktreeId: initialIdentity,
          initialWorktreeId: initialIdentity, startedAt, finishedAt: new Date().toISOString(),
          skipped: `Unknown check ID(s): ${unknown.join(", ")}. Available: ${detection.available.map((check) => check.id).join(", ") || "none"}.`, hygiene, results: [],
        };
        publish(details, ctx.cwd);
        if (ctx.hasUI) ctx.ui.setStatus("pi-verify", "Verify: invalid selection");
        return { content: [{ type: "text" as const, text: details.skipped! }], details };
      }
      const checks = selectedPolicy || requested.length
        ? requested.map((id: string) => detection.available.find((check) => check.id === id)!)
        : detection.checks;
      const omittedChecks = selectedPolicy || requested.length ? [] : detection.omitted.map((check) => check.id);
      if (!checks.length) {
        const details: Details = {
          scope: params.scope, runId, state: "no_checks", worktreeId: initialIdentity,
          initialWorktreeId: initialIdentity, startedAt, finishedAt: new Date().toISOString(),
          skipped: "No declared verification commands detected.", hygiene, results: [],
        };
        publish(details, ctx.cwd);
        if (ctx.hasUI) ctx.ui.setStatus("pi-verify", "Verify: no checks");
        return { content: [{ type: "text" as const, text: `${details.skipped}${hygiene ? `\n\n${hygieneText(hygiene)}` : ""}` }], details };
      }

      const indexedResults: Array<{ index: number; result: Result }> = [];
      const runStarted = Date.now();
      const checkIndexes = new Map(checks.map((check, index) => [check.id, index]));
      const groups = new Map<string, typeof checks>();
      for (const check of checks) groups.set(check.cwd, [...(groups.get(check.cwd) ?? []), check]);
      let nextGroup = 0;
      let startedChecks = 0;
      let stopped = false;
      const orderedResults = () => indexedResults
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((item) => item.result);
      const runCheck = async (check: (typeof checks)[number]) => {
        const displayIndex = ++startedChecks;
        const progress = `Verify: Running ${displayIndex}/${checks.length}`;
        if (ctx.hasUI) ctx.ui.setStatus("pi-verify", progress);
        pi.events.emit("pi-verify:lifecycle", {
          version: 1, runId, cwd: ctx.cwd, scope: params.scope, state: "running",
          worktreeId: initialIdentity, startedAt, completed: indexedResults.length, total: checks.length,
        });
        onUpdate?.({
          content: [{ type: "text", text: `Running ${displayIndex}/${checks.length}: ${check.label}` }],
          details: { scope: params.scope, runId, state: "running", worktreeId: initialIdentity, startedAt, results: orderedResults() },
        });
        const started = Date.now();
        const heartbeat = setInterval(() => {
          const durationMs = Date.now() - runStarted;
          if (ctx.hasUI) ctx.ui.setStatus("pi-verify", `${progress} · ${(durationMs / 1000).toFixed(0)}s`);
          onUpdate?.({
            content: [{ type: "text", text: `${(durationMs / 1000).toFixed(0)}s` }],
            details: { scope: params.scope, runId, state: "running", worktreeId: initialIdentity, startedAt, durationMs, results: orderedResults() },
          });
        }, HEARTBEAT_MS);
        heartbeat.unref();
        const execution = await (async () => {
          try {
            return await pi.exec(check.command, check.args, {
              cwd: check.cwd,
              signal,
              timeout: 5 * 60_000,
            }).catch((error: unknown) => ({
              code: null,
              stdout: "",
              stderr: `Check unavailable: ${error instanceof Error ? error.message : String(error)}`,
            }));
          } finally {
            clearInterval(heartbeat);
          }
        })();
        const raw = [execution.stdout, execution.stderr].filter(Boolean).join("\n");
        const bounded = truncateTail(raw, { maxLines: 160, maxBytes: 12 * 1024 });
        indexedResults.push({
          index: checkIndexes.get(check.id)!,
          result: {
            id: check.id,
            label: check.label,
            command: [check.command, ...check.args].join(" "),
            code: execution.code,
            output: bounded.content.trim(),
            truncated: bounded.truncated,
            durationMs: Date.now() - started,
          },
        });
        if (execution.code !== 0) stopped = true;
      };
      const queues = [...groups.values()];
      const worker = async () => {
        while (!stopped && !signal?.aborted) {
          const group = queues[nextGroup++];
          if (!group) return;
          for (const check of group) {
            if (stopped || signal?.aborted) return;
            await runCheck(check);
          }
        }
      };
      await Promise.all(Array.from(
        { length: Math.min(MAX_PARALLEL_DIRECTORIES, queues.length) },
        () => worker(),
      ));
      const results = orderedResults();

      const passed = results.length === checks.length && results.every((result) => result.code === 0);
      const summary = results
        .map((result) => `${result.code === 0 ? "PASS" : "FAIL"} ${result.command} (${(result.durationMs / 1000).toFixed(1)}s)${result.code !== 0 && result.output ? `\n${result.output}` : ""}${result.code !== 0 && result.truncated ? "\n[output truncated]" : ""}`)
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
      const completedIds = new Set(results.map((result) => result.id));
      const unrunChecks = checks.filter((check) => !completedIds.has(check.id)).map((check) => check.id);
      const details: Details = {
        scope: params.scope, runId, state, worktreeId: finalIdentity,
        initialWorktreeId: initialIdentity, startedAt, finishedAt: new Date().toISOString(),
        durationMs: Date.now() - runStarted,
        ...(omittedChecks.length ? { omittedChecks } : {}),
        ...(unrunChecks.length ? { unrunChecks } : {}),
        ...(hygiene ? { hygiene } : {}),
        results,
      };
      publish(details, ctx.cwd);
      if (ctx.hasUI) ctx.ui.setStatus("pi-verify", `Verify: ${state}`);
      const outcome = state === "passed" ? "Verification passed."
        : state === "cancelled" ? "Verification cancelled."
          : state === "stale" ? "Verification stale: worktree changed during checks."
            : state === "error" ? "Verification error."
              : "Verification failed.";
      const omitted = omittedChecks.length
        ? ` Skipped by six-check cap (${omittedChecks.length}): ${omittedChecks.join(", ")}. Pass checks to select them explicitly.`
        : "";
      const text = state === "passed"
        ? `${outcome} ${results.length}/${checks.length} checks: ${results.map((result) => result.id).join(", ")} · ${(details.durationMs! / 1000).toFixed(1)}s.${hygiene ? " Hygiene passed." : ""}${omitted}`
        : `${outcome}${hygiene ? `\n\n${hygieneText(hygiene)}` : ""}\n\n${summary}${unrunChecks.length ? `\n\nNot run after stop: ${unrunChecks.join(", ")}.` : ""}${omittedChecks.length ? `\n\nSkipped by six-check cap: ${omittedChecks.join(", ")}. Pass checks to select them explicitly.` : ""}`;
      return {
        content: [{ type: "text" as const, text }],
        details,
      };
    },
    renderCall(args, theme) {
      const scope = args.scope === "changed" ? "worktree changes" : args.scope;
      return new Text(
        theme.fg("toolTitle", theme.bold("Verify ")) + theme.fg("muted", `${scope}${args.checks?.length ? ` · ${args.checks.join(", ")}` : ""}`),
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as Details | undefined;
      if (!details) return new Text("Verify", 0, 0);
      if (details.skipped) return new Text(theme.fg("muted", `${details.skipped}${details.hygiene ? " · Hygiene passed" : ""}`), 0, 0);
      const failed = details.state !== "passed";
      let text = theme.fg(failed ? "error" : "success", `Verification ${details.state}`);
      text += theme.fg("dim", ` · ${details.results.length} check(s)${details.unrunChecks?.length ? ` · ${details.unrunChecks.length} not run` : ""}${details.omittedChecks?.length ? ` · ${details.omittedChecks.length} capped` : ""}${details.durationMs ? ` · ${(details.durationMs / 1000).toFixed(details.state === "running" ? 0 : 1)}s` : ""}`);
      if (expanded) {
        const sections = [
          details.hygiene ? hygieneText(details.hygiene) : "",
          details.results.map((item) => `${item.code === 0 ? "PASS" : "FAIL"} ${item.command}${item.output ? `\n${item.output}` : ""}`).join("\n\n"),
        ].filter(Boolean);
        if (sections.length) text += `\n${sections.join("\n\n")}`;
      }
      return new Text(text, 0, 0);
    },
  });
}
