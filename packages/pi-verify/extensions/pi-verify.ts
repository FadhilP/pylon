import { createHash, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { truncateTail, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { detectChecks } from "../src/detect.ts";
import { runGrouped } from "../src/schedule.ts";

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

const hygieneText = (hygiene: Hygiene) =>
  [
    `Changed-set hygiene ${hygiene.code === 0 ? "passed" : "failed"}: ${hygiene.command}`,
    hygiene.output,
    hygiene.status ? `Changed paths:\n${hygiene.status}${hygiene.statusTruncated ? "\n[status truncated]" : ""}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

const contextText = (value: any) => {
  const checks = (value.results ?? []).map((result: any) => `${result.id}=${result.code ?? "error"}`).join(", ");
  return [
    `Verification: ${value.state}; scope: ${value.scope}; run: ${value.runId}`,
    value.worktreeId ? `Worktree: ${value.worktreeId}` : "",
    checks ? `Checks: ${checks}` : "Checks: none",
  ]
    .filter(Boolean)
    .join("\n");
};

/** A cancelled run, an unreadable worktree, and a worktree edited mid-run all outrank pass/fail. */
function verificationState(input: {
  aborted: boolean;
  initialIdentity?: string;
  finalIdentity?: string;
  errored?: boolean;
  passed: boolean;
}): VerificationState {
  if (input.aborted) return "cancelled";
  if (input.errored || !input.initialIdentity || !input.finalIdentity) return "error";
  if (input.initialIdentity !== input.finalIdentity) return "stale";
  return input.passed ? "passed" : "failed";
}

const OUTCOMES: Partial<Record<VerificationState, string>> = {
  passed: "Verification passed.",
  cancelled: "Verification cancelled.",
  stale: "Verification stale: worktree changed during checks.",
  error: "Verification error.",
};
const cappedNote = (omittedChecks: string[]) =>
  `Skipped by six-check cap: ${omittedChecks.join(", ")}. Pass checks to select them explicitly.`;

function resultText(input: {
  state: VerificationState;
  results: Result[];
  checkCount: number;
  durationMs: number;
  hygiene?: Hygiene;
  unrunChecks: string[];
  omittedChecks: string[];
}): string {
  const outcome = OUTCOMES[input.state] ?? "Verification failed.";
  if (input.state === "passed") {
    const ids = input.results.map(result => result.id).join(", ");
    const omitted = input.omittedChecks.length
      ? ` Skipped by six-check cap (${input.omittedChecks.length}): ${input.omittedChecks.join(", ")}. Pass checks to select them explicitly.`
      : "";
    return `${outcome} ${input.results.length}/${input.checkCount} checks: ${ids} · ${(input.durationMs / 1000).toFixed(1)}s.${input.hygiene ? " Hygiene passed." : ""}${omitted}`;
  }
  const summary = input.results
    .map(
      result =>
        `${result.code === 0 ? "PASS" : "FAIL"} ${result.command} (${(result.durationMs / 1000).toFixed(1)}s)${result.code !== 0 && result.output ? `\n${result.output}` : ""}${result.code !== 0 && result.truncated ? "\n[output truncated]" : ""}`,
    )
    .join("\n\n");
  return [
    `${outcome}${input.hygiene ? `\n\n${hygieneText(input.hygiene)}` : ""}`,
    summary,
    input.unrunChecks.length ? `Not run after stop: ${input.unrunChecks.join(", ")}.` : "",
    input.omittedChecks.length ? cappedNote(input.omittedChecks) : "",
  ]
    .filter((section, index) => index < 2 || section)
    .join("\n\n");
}

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
      checks: detection.available
        .slice(0, 100)
        .map(check => ({
          id: check.id.slice(0, 100),
          label: check.label.slice(0, 200),
          command: [check.command, ...check.args].join(" ").slice(0, 500),
        })),
    };
  };
  const publishCatalog = async (cwd: string, sessionId: string) => {
    const value = await catalog(cwd);
    if (!cwd || currentCwd !== cwd || currentSessionId !== sessionId) return;
    pi.events.emit("pi-verify:catalog", value);
  };
  const disposePolicy = pi.events.on?.("pylon:runtime-policy", (value: any) => {
    if (value?.version !== 2 || value.sessionId !== currentSessionId) return;
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
    if (
      request?.version !== 1 ||
      request.sessionId !== currentSessionId ||
      typeof request.respond !== "function" ||
      !currentCwd
    )
      return;
    request.respond(catalog(currentCwd));
  });
  const worktreeState = async (cwd: string, signal?: AbortSignal) => {
    try {
      const options = { cwd, signal, timeout: 15_000 };
      const [head, status, index, paths] = await Promise.all([
        pi.exec("git", ["rev-parse", "HEAD"], options),
        pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], options),
        pi.exec("git", ["diff", "--cached", "--raw", "-z", "HEAD", "--"], options),
        pi.exec("git", ["ls-files", "--modified", "--deleted", "--others", "--exclude-standard", "-z"], options),
      ]);
      if ([head, status, index, paths].some(result => result.code !== 0)) return undefined;
      const changedPaths = [...new Set(paths.stdout.split("\0").filter(Boolean))].sort();
      const content = createHash("sha256")
        .update(head.stdout.trim())
        .update("\0")
        .update(status.stdout)
        .update("\0")
        .update(index.stdout)
        .update("\0");
      for (let offset = 0; offset < changedPaths.length; offset += 64) {
        const existing = (
          await Promise.all(
            changedPaths.slice(offset, offset + 64).map(
              async path =>
                await lstat(join(cwd, path)).then(
                  () => path,
                  () => undefined,
                ),
            ),
          )
        ).filter((path): path is string => path !== undefined);
        if (!existing.length) continue;
        const hashes = await pi.exec("git", ["hash-object", "--no-filters", "--", ...existing], options);
        if (hashes.code !== 0) return undefined;
        content.update(
          existing.map((path, index) => `${path}\0${hashes.stdout.split(/\r?\n/)[index] ?? ""}\0`).join(""),
        );
      }
      return { id: content.digest("hex").slice(0, 16), dirty: Boolean(status.stdout.trim()), status: status.stdout };
    } catch {
      return undefined;
    }
  };
  const runHygiene = async (cwd: string, status: string, signal?: AbortSignal): Promise<Hygiene> => {
    const started = Date.now();
    const execution = await pi
      .exec("git", ["diff", "--check", "HEAD", "--"], { cwd, signal, timeout: 15_000 })
      .catch((error: unknown) => ({
        code: null,
        stdout: "",
        stderr: `Hygiene check unavailable: ${error instanceof Error ? error.message : String(error)}`,
      }));
    const output = truncateTail([execution.stdout, execution.stderr].filter(Boolean).join("\n"), {
      maxLines: 80,
      maxBytes: 8 * 1024,
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
  const publish = (details: Details, cwd: string) => {
    const event = { version: 1 as const, sessionId: currentSessionId, cwd, ...details };
    if (["failed", "cancelled", "stale", "error"].includes(details.state)) nonPassingState = details.state;
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
    latestContext = (
      [...(ctx.sessionManager.getEntries?.() ?? [])]
        .reverse()
        .find(
          (entry: any) =>
            entry.type === "custom" && entry.customType === "pi-verify-result" && entry.data?.version === 1,
        ) as any
    )?.data;
    if (latestContext) pi.events.emit("pi-verify:lifecycle", latestContext);
    pi.events.emit("pylon:tool-policy", {
      version: 1,
      kind: "register",
      owner: "pi-verify",
      managedTools: ["verify"],
      enabledTools: ["verify"],
      toolUsage: { verify: "run bounded changed-set hygiene and existing project verification checks" },
    });
    void publishCatalog(currentCwd, currentSessionId).catch(() => undefined);
  });
  pi.on("session_shutdown", () => {
    disposePolicy?.();
    disposeCatalog?.();
    pi.events.emit("pylon:tool-policy", { version: 1, kind: "unregister", owner: "pi-verify" });
    currentCwd = "";
    currentSessionId = "";
    nonPassingState = undefined;
  });
  pi.on("input", event => {
    if (event.source !== "extension") nonPassingState = undefined;
  });
  pi.on("tool_call", (event, ctx) => {
    if (nonPassingState)
      return {
        block: true,
        reason: `Verification already ended this agent run with ${nonPassingState}. Write one caveated evidence-aware text-only final response and stop; do not call more tools.`,
      };
    if (event.toolName === "verify") {
      const lastAssistant = [...(ctx?.sessionManager?.getEntries?.() ?? [])]
        .reverse()
        .find((entry: any) => entry.type === "message" && entry.message?.role === "assistant") as any;
      const siblings = (lastAssistant?.message?.content ?? []).filter(
        (part: any) => part.type === "toolCall" && part.id !== event.toolCallId,
      );
      if (siblings.length > 0)
        return {
          block: true,
          reason:
            "Verify was batched with other tool calls in the same turn. Finish all edits first, then call Verify alone in a tool-only assistant turn and wait for its result.",
        };
    }
    if (["write", "edit", "bash", "heartbeat_start"].includes(event.toolName)) latestContext = undefined;
  });
  pi.on("context", event => {
    if (!latestContext) return;
    const alreadyPresent = event.messages.some(
      (message: any) =>
        message.role === "toolResult" &&
        message.toolName === "verify" &&
        message.details?.runId === latestContext.runId,
    );
    if (alreadyPresent) return;
    return {
      messages: [
        ...event.messages,
        {
          role: "custom",
          customType: "pi-verify-result",
          content: contextText(latestContext),
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });
  pi.registerTool({
    name: "verify",
    label: "Verify",
    description:
      "Run bounded changed-set hygiene, then detect and run existing project verification commands. Discovers immediate child packages when root declares no checks. Scope changed skips clean Git worktrees; project always runs. Optionally select up to six stable check IDs.",
    promptSnippet: "Run detected project checks and return bounded failures",
    promptGuidelines: [
      "Use verify only after all code changes are final—never mid-task while more edits remain, and never in the same assistant message as other tool calls. Call Verify in a tool-only assistant turn with no user-facing prose, wait for its result, then write exactly one evidence-aware final response. After failed, stale, cancelled, or error results, stop without another tool call. Omit checks by default; only pass exact IDs supplied by the user or verification catalog, and never infer IDs from scripts or labels. It runs git diff --check for dirty Git worktrees before declared checks. Use scope changed for normal edits and project for broad refactors or release checks. Verify never installs dependencies.",
    ],
    parameters: Type.Object(
      {
        scope: StringEnum(["changed", "project"] as const),
        checks: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 6, uniqueItems: true }),
        ),
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
        version: 1,
        runId,
        cwd: ctx.cwd,
        scope: params.scope,
        state: "running",
        worktreeId: initialIdentity,
        startedAt,
      });
      /** Publishes one terminal outcome and returns the tool result for it. */
      const finish = (state: VerificationState, options: { text: string; status?: string } & Partial<Details>) => {
        const { text, status, ...extra } = options;
        const details: Details = {
          scope: params.scope,
          runId,
          state,
          worktreeId: initialIdentity,
          initialWorktreeId: initialIdentity,
          startedAt,
          finishedAt: new Date().toISOString(),
          results: [],
          ...extra,
        };
        publish(details, ctx.cwd);
        if (ctx.hasUI) ctx.ui.setStatus("pi-verify", status ?? `Verify: ${state}`);
        return { content: [{ type: "text" as const, text }], details };
      };

      if (params.scope === "changed" && initial && !initial.dirty) {
        const skipped = "Git worktree is clean.";
        return finish("clean", { text: skipped, status: "Verify: clean · not verified", skipped });
      }

      const hygiene = initial?.dirty ? await runHygiene(ctx.cwd, initial.status, signal) : undefined;
      if (hygiene && hygiene.code !== 0) {
        const finalIdentity = (await worktreeState(ctx.cwd, signal))?.id;
        const state = verificationState({
          aborted: Boolean(signal?.aborted),
          initialIdentity,
          finalIdentity,
          errored: hygiene.code === null,
          passed: false,
        });
        return finish(state, { text: hygieneText(hygiene), worktreeId: finalIdentity, hygiene });
      }

      const detection = await detectChecks(ctx.cwd);
      const selectedPolicy = policy.mode === "selected" ? policy : undefined;
      const requested = selectedPolicy?.checks ?? params.checks ?? [];
      const unknown = requested.filter((id: string) => !detection.available.some(check => check.id === id));
      if (unknown.length) {
        const available = detection.available.map(check => check.id).join(", ") || "none";
        const skipped = `Unknown check ID(s): ${unknown.join(", ")}. Available: ${available}.`;
        return finish("error", { text: skipped, status: "Verify: invalid selection", skipped, hygiene });
      }
      const checks =
        selectedPolicy || requested.length
          ? requested.map((id: string) => detection.available.find(check => check.id === id)!)
          : detection.checks;
      const omittedChecks = selectedPolicy || requested.length ? [] : detection.omitted.map(check => check.id);
      if (!checks.length) {
        const skipped = "No declared verification commands detected.";
        return finish("no_checks", {
          text: `${skipped}${hygiene ? `\n\n${hygieneText(hygiene)}` : ""}`,
          status: "Verify: no checks",
          skipped,
          hygiene,
        });
      }

      const indexedResults: Array<{ index: number; result: Result }> = [];
      const runStarted = Date.now();
      const checkIndexes = new Map(checks.map((check, index) => [check.id, index]));
      const groups = new Map<string, typeof checks>();
      for (const check of checks) groups.set(check.cwd, [...(groups.get(check.cwd) ?? []), check]);
      let startedChecks = 0;
      let stopped = false;
      const orderedResults = () =>
        indexedResults
          .slice()
          .sort((a, b) => a.index - b.index)
          .map(item => item.result);
      const runningDetails = (extra: object = {}) => ({
        scope: params.scope,
        runId,
        state: "running",
        worktreeId: initialIdentity,
        startedAt,
        results: orderedResults(),
        ...extra,
      });
      const runCheck = async (check: (typeof checks)[number]) => {
        const displayIndex = ++startedChecks;
        const progress = `Verify: Running ${displayIndex}/${checks.length}`;
        if (ctx.hasUI) ctx.ui.setStatus("pi-verify", progress);
        pi.events.emit("pi-verify:lifecycle", {
          version: 1,
          runId,
          cwd: ctx.cwd,
          scope: params.scope,
          state: "running",
          worktreeId: initialIdentity,
          startedAt,
          completed: indexedResults.length,
          total: checks.length,
        });
        onUpdate?.({
          content: [{ type: "text", text: `Running ${displayIndex}/${checks.length}: ${check.label}` }],
          details: runningDetails(),
        });
        const started = Date.now();
        const heartbeat = setInterval(() => {
          const durationMs = Date.now() - runStarted;
          if (ctx.hasUI) ctx.ui.setStatus("pi-verify", `${progress} · ${(durationMs / 1000).toFixed(0)}s`);
          onUpdate?.({
            content: [{ type: "text", text: `${(durationMs / 1000).toFixed(0)}s` }],
            details: runningDetails({ durationMs }),
          });
        }, HEARTBEAT_MS);
        heartbeat.unref();
        const execution = await pi
          .exec(check.command, check.args, { cwd: check.cwd, signal, timeout: 5 * 60_000 })
          .catch((error: unknown) => ({
            code: null,
            stdout: "",
            stderr: `Check unavailable: ${error instanceof Error ? error.message : String(error)}`,
          }))
          .finally(() => clearInterval(heartbeat));
        const raw = [execution.stdout, execution.stderr].filter(Boolean).join("\n");
        const output = truncateTail(raw, { maxLines: 160, maxBytes: 12 * 1024 });
        indexedResults.push({
          index: checkIndexes.get(check.id)!,
          result: {
            id: check.id,
            label: check.label,
            command: [check.command, ...check.args].join(" "),
            code: execution.code,
            output: output.content.trim(),
            truncated: output.truncated,
            durationMs: Date.now() - started,
          },
        });
        if (execution.code !== 0) stopped = true;
      };
      await runGrouped(
        [...groups.values()],
        MAX_PARALLEL_DIRECTORIES,
        runCheck,
        () => stopped || Boolean(signal?.aborted),
      );
      const results = orderedResults();

      const finalIdentity = (await worktreeState(ctx.cwd, signal))?.id;
      const state = verificationState({
        aborted: Boolean(signal?.aborted),
        initialIdentity,
        finalIdentity,
        passed: results.length === checks.length && results.every(result => result.code === 0),
      });
      const completedIds = new Set(results.map(result => result.id));
      const unrunChecks = checks.filter(check => !completedIds.has(check.id)).map(check => check.id);
      const durationMs = Date.now() - runStarted;
      return finish(state, {
        text: resultText({
          state,
          results,
          checkCount: checks.length,
          durationMs,
          hygiene,
          unrunChecks,
          omittedChecks,
        }),
        worktreeId: finalIdentity,
        durationMs,
        ...(omittedChecks.length ? { omittedChecks } : {}),
        ...(unrunChecks.length ? { unrunChecks } : {}),
        ...(hygiene ? { hygiene } : {}),
        results,
      });
    },
    renderCall(args, theme) {
      const scope = args.scope === "changed" ? "worktree changes" : args.scope;
      return new Text(
        theme.fg("toolTitle", theme.bold("Verify ")) +
          theme.fg("muted", `${scope}${args.checks?.length ? ` · ${args.checks.join(", ")}` : ""}`),
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as Details | undefined;
      if (!details) return new Text("Verify", 0, 0);
      if (details.skipped)
        return new Text(theme.fg("muted", `${details.skipped}${details.hygiene ? " · Hygiene passed" : ""}`), 0, 0);
      const failed = details.state !== "passed";
      let text = theme.fg(failed ? "error" : "success", `Verification ${details.state}`);
      text += theme.fg(
        "dim",
        ` · ${details.results.length} check(s)${details.unrunChecks?.length ? ` · ${details.unrunChecks.length} not run` : ""}${details.omittedChecks?.length ? ` · ${details.omittedChecks.length} capped` : ""}${details.durationMs ? ` · ${(details.durationMs / 1000).toFixed(details.state === "running" ? 0 : 1)}s` : ""}`,
      );
      if (expanded) {
        const sections = [
          details.hygiene ? hygieneText(details.hygiene) : "",
          details.results
            .map(item => `${item.code === 0 ? "PASS" : "FAIL"} ${item.command}${item.output ? `\n${item.output}` : ""}`)
            .join("\n\n"),
        ].filter(Boolean);
        if (sections.length) text += `\n${sections.join("\n\n")}`;
      }
      return new Text(text, 0, 0);
    },
  });
}
