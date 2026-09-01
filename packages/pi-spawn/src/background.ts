import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SPAWN_PROGRESS_CHANNEL } from "./constants.ts";
import { failure, label, scientistName } from "./results.ts";
import { isThreadActive, resultDetails, type SpawnKind } from "./sessions.ts";
import type { ExecuteTurn, TurnRequest } from "./turns.ts";

const MAX_TERMINAL_RUNS = 20;
const MAX_CONTEXT_RUNS = 8;

type RunState = "queued" | "running" | "completed" | "failed" | "cancelled";
type BackgroundRun = {
  kind: SpawnKind;
  parentSessionId: string;
  toolCallId: string;
  id: string;
  path: string;
  cwd: string;
  runId: string;
  agentName: string;
  queued: number;
  started?: number;
  controller: AbortController;
  state: RunState;
  request: BackgroundRequest;
  promise?: Promise<any>;
  result?: any;
};

export type BackgroundRequest = TurnRequest & { toolCallId: string; parentSessionId: string };

/** Owns the background spawn runs of one parent session: their lifecycle, progress events, and queue. */
export function createBackgroundRuns(pi: ExtensionAPI, executeTurn: ExecuteTurn) {
  const runs = new Map<string, BackgroundRun>();
  let shuttingDown = false;

  const emitProgress = (run: BackgroundRun, phase: "update" | "end", result: unknown) => {
    pi.events.emit(SPAWN_PROGRESS_CHANNEL, {
      version: 1,
      parentSessionId: run.parentSessionId,
      toolCallId: run.toolCallId,
      kind: run.kind,
      id: run.id,
      runId: run.runId,
      phase,
      result,
    });
  };
  const terminal = (state: RunState) => state !== "queued" && state !== "running";
  const prune = () => {
    const settled = [...runs.values()].filter(run => terminal(run.state)).sort((a, b) => b.queued - a.queued);
    for (const run of settled.slice(MAX_TERMINAL_RUNS)) runs.delete(run.runId);
  };
  const commonDetails = (run: BackgroundRun) => ({
    ...resultDetails(run.kind, run.id, run.path, run.cwd),
    runId: run.runId,
    agentName: run.agentName,
    queuedAt: new Date(run.queued).toISOString(),
    ...(run.started === undefined ? {} : { startedAt: new Date(run.started).toISOString() }),
    background: true,
  });
  const queuedSummary = (run: BackgroundRun) => ({
    content: [
      {
        type: "text" as const,
        text: `${label(run.kind)} ${run.agentName} (${run.id}) background run ${run.runId} is queued.`,
      },
    ],
    details: {
      ...commonDetails(run),
      // The delegated-run projection treats background work as nonterminal via status=running.
      startedAt: new Date(run.queued).toISOString(),
      status: "running",
      state: "queued",
    },
  });
  const runningSummary = (run: BackgroundRun, durationMs?: number) => ({
    content: [
      {
        type: "text" as const,
        text: `${label(run.kind)} ${run.agentName} (${run.id}) background run ${run.runId} is still running.`,
      },
    ],
    details: {
      ...commonDetails(run),
      status: "running",
      state: "running",
      ...(durationMs === undefined ? {} : { durationMs }),
    },
  });
  const cancelledResult = (run: BackgroundRun) => ({
    content: [
      {
        type: "text" as const,
        text: `${label(run.kind)} ${run.agentName} (${run.id}) queued background run ${run.runId} was cancelled.`,
      },
    ],
    details: { ...commonDetails(run), status: "cancelled", state: "cancelled" },
  });
  const createEntry = (request: BackgroundRequest, state: RunState): BackgroundRun => ({
    kind: request.kind,
    id: request.id,
    path: request.path,
    cwd: request.cwd,
    runId: randomUUID(),
    parentSessionId: request.parentSessionId,
    toolCallId: request.toolCallId,
    agentName: scientistName(request.id),
    queued: Date.now(),
    controller: new AbortController(),
    state,
    request,
  });
  const stateFrom = (result: any): RunState =>
    result?.details?.status === "completed"
      ? "completed"
      : result?.details?.status === "cancelled"
        ? "cancelled"
        : "failed";

  const drain = (path: string) => {
    if (shuttingDown || [...runs.values()].some(run => run.path === path && run.state === "running")) return;
    const next = [...runs.values()].find(run => run.path === path && run.state === "queued");
    if (next) startEntry(next);
  };
  const settle = (run: BackgroundRun, result: any) => {
    run.result = result;
    run.state = stateFrom(result);
    emitProgress(run, "end", result);
    prune();
    drain(run.path);
    return result;
  };
  const startEntry = (run: BackgroundRun) => {
    if (run.state !== "queued" || shuttingDown) return;
    run.state = "running";
    run.started = Date.now();
    const request = run.request;
    run.promise = Promise.resolve(
      executeTurn({
        ...request,
        signal: run.controller.signal,
        onUpdate: (result: unknown) => emitProgress(run, "update", result),
        beforeRun: undefined,
        runId: run.runId,
        background: true,
      }),
    )
      .then(result => settle(run, result))
      .catch(error =>
        settle(
          run,
          failure("runner_error", error instanceof Error ? error.message : String(error), {
            ...commonDetails(run),
            status: run.controller.signal.aborted ? "cancelled" : "failed",
          }),
        ),
      );
  };
  const startResult = (run: BackgroundRun, policy?: TurnRequest["policy"]) => {
    const agentPolicy = run.kind === "agent" ? (policy as { thinking?: string } | undefined) : undefined;
    return {
      content: [
        {
          type: "text" as const,
          text: `${label(run.kind)} ${run.agentName} (${run.id}) started in background as run ${run.runId}. Continue independent work, then use ${run.kind === "agent" ? "spawn_agent" : "spawn_session"} status with id and runId.`,
        },
      ],
      details: {
        ...commonDetails(run),
        status: "running",
        state: "running",
        ...(policy?.model ? { model: policy.model } : {}),
        ...(agentPolicy?.thinking ? { thinking: agentPolicy.thinking } : {}),
      },
    };
  };

  return {
    get shuttingDown() {
      return shuttingDown;
    },

    start(request: BackgroundRequest) {
      if (shuttingDown) return failure("shutting_down", "Background spawning is unavailable during session shutdown.");
      if (isThreadActive(request.path)) return failure("busy", "Spawned thread is already running in this Pi process.");
      const run = createEntry(request, "queued");
      runs.set(run.runId, run);
      startEntry(run);
      return startResult(run, request.policy);
    },

    queue(request: BackgroundRequest) {
      if (shuttingDown) return failure("shutting_down", "Background spawning is unavailable during session shutdown.");
      const ownedPredecessor = [...runs.values()].some(
        run => run.path === request.path && (run.state === "queued" || run.state === "running"),
      );
      if (!ownedPredecessor && isThreadActive(request.path))
        return failure("busy", "Spawned thread is already running outside this background queue.");
      const run = createEntry(request, "queued");
      runs.set(run.runId, run);
      if (!ownedPredecessor) {
        startEntry(run);
        return startResult(run, request.policy);
      }
      return queuedSummary(run);
    },

    async collect(kind: SpawnKind, id: string, runId: string, cancel: boolean) {
      const run = runs.get(runId);
      if (!run || run.kind !== kind || run.id !== id)
        return failure("not_found", "Background run is unavailable in this session runtime.");
      if (cancel && run.state === "queued") {
        run.result = cancelledResult(run);
        run.state = "cancelled";
        emitProgress(run, "end", run.result);
        runs.delete(runId);
        drain(run.path);
        return run.result;
      }
      if (cancel && run.state === "running") run.controller.abort();
      if (cancel && run.promise) await run.promise;
      if (run.state === "queued") return queuedSummary(run);
      if (run.state === "running")
        return runningSummary(run, run.started === undefined ? undefined : Date.now() - run.started);
      if (runs.get(runId) !== run) return failure("not_found", "Background run result was already collected.");
      runs.delete(runId);
      return run.result;
    },

    /** Reminds the parent model which background runs are outstanding. */
    contextLines(): string | undefined {
      const all = [...runs.values()];
      const visible = [
        ...all.filter(run => run.state === "queued" || run.state === "running"),
        ...all.filter(run => terminal(run.state)),
      ].slice(0, MAX_CONTEXT_RUNS);
      if (!visible.length) return;
      return visible
        .map(
          run =>
            `${run.kind} ${run.id}, run ${run.runId}: ${run.state}${terminal(run.state) ? "; call status to collect the result" : ""}`,
        )
        .join("\n");
    },

    reset() {
      shuttingDown = false;
    },

    async shutdown() {
      shuttingDown = true;
      const active = [...runs.values()];
      for (const run of active) {
        if (run.state === "running") run.controller.abort();
        if (run.state === "queued") {
          run.result = cancelledResult(run);
          run.state = "cancelled";
          emitProgress(run, "end", run.result);
        }
      }
      await Promise.allSettled(active.flatMap(run => (run.promise ? [run.promise] : [])));
      runs.clear();
    },
  };
}
