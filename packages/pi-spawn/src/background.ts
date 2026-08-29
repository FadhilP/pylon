import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SPAWN_PROGRESS_CHANNEL } from "./constants.ts";
import { failure, label, scientistName } from "./results.ts";
import { isThreadActive, resultDetails, type SpawnKind } from "./sessions.ts";
import type { ExecuteTurn, TurnRequest } from "./turns.ts";

const MAX_TERMINAL_RUNS = 20;
const MAX_CONTEXT_RUNS = 8;

type BackgroundRun = {
  kind: SpawnKind;
  parentSessionId: string;
  toolCallId: string;
  id: string;
  path: string;
  cwd: string;
  runId: string;
  agentName: string;
  started: number;
  controller: AbortController;
  state: "running" | "completed" | "failed" | "cancelled";
  promise: Promise<any>;
  result?: any;
};

export type BackgroundRequest = TurnRequest & { toolCallId: string; parentSessionId: string };

/** Owns the background spawn runs of one parent session: their lifecycle, progress events, and shutdown. */
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
  const prune = () => {
    const terminal = [...runs.values()].filter(run => run.state !== "running").sort((a, b) => b.started - a.started);
    for (const run of terminal.slice(MAX_TERMINAL_RUNS)) runs.delete(run.runId);
  };
  const runningSummary = (run: BackgroundRun, id: string, durationMs?: number) => ({
    content: [
      {
        type: "text" as const,
        text: `${label(run.kind)} ${run.agentName} (${id}) background run ${run.runId} is still running.`,
      },
    ],
    details: {
      ...resultDetails(run.kind, id, run.path, run.cwd),
      runId: run.runId,
      agentName: run.agentName,
      startedAt: new Date(run.started).toISOString(),
      status: "running",
      state: "running",
      background: true,
      ...(durationMs === undefined ? {} : { durationMs }),
    },
  });

  return {
    get shuttingDown() {
      return shuttingDown;
    },

    start(request: BackgroundRequest) {
      const { kind, id, path, cwd, toolCallId, parentSessionId, policy } = request;
      if (shuttingDown) return failure("shutting_down", "Background spawning is unavailable during session shutdown.");
      if (isThreadActive(path)) return failure("busy", "Spawned thread is already running in this Pi process.");
      const runId = randomUUID();
      const started = Date.now();
      const controller = new AbortController();
      const entry: BackgroundRun = {
        kind,
        id,
        path,
        cwd,
        runId,
        parentSessionId,
        toolCallId,
        agentName: scientistName(id),
        started,
        controller,
        state: "running",
        promise: Promise.resolve(undefined),
      };
      runs.set(runId, entry);
      entry.promise = executeTurn({
        ...request,
        signal: controller.signal,
        onUpdate: (result: unknown) => emitProgress(entry, "update", result),
        beforeRun: undefined,
        runId,
        background: true,
      }).then(result => {
        entry.result = result;
        entry.state =
          result.details?.status === "completed"
            ? "completed"
            : result.details?.status === "cancelled"
              ? "cancelled"
              : "failed";
        emitProgress(entry, "end", result);
        prune();
        return result;
      });
      const agentPolicy = kind === "agent" ? (policy as { thinking?: string } | undefined) : undefined;
      return {
        content: [
          {
            type: "text" as const,
            text: `${label(kind)} ${entry.agentName} (${id}) started in background as run ${runId}. Continue independent work, then use ${kind === "agent" ? "spawn_agent" : "spawn_session"} status with id and runId.`,
          },
        ],
        details: {
          ...resultDetails(kind, id, path, cwd),
          runId,
          agentName: entry.agentName,
          startedAt: new Date(started).toISOString(),
          status: "running",
          state: "running",
          background: true,
          ...(policy?.model ? { model: policy.model } : {}),
          ...(agentPolicy?.thinking ? { thinking: agentPolicy.thinking } : {}),
        },
      };
    },

    async collect(kind: SpawnKind, id: string, runId: string, cancel: boolean) {
      const entry = runs.get(runId);
      if (!entry || entry.kind !== kind || entry.id !== id)
        return failure("not_found", "Background run is unavailable in this session runtime.");
      if (cancel && entry.state === "running") entry.controller.abort();
      if (cancel) await entry.promise;
      if (entry.state === "running") return runningSummary(entry, id, Date.now() - entry.started);
      if (runs.get(runId) !== entry) return failure("not_found", "Background run result was already collected.");
      runs.delete(runId);
      return entry.result;
    },

    /** Reminds the parent model which background runs are outstanding. */
    contextLines(): string | undefined {
      const all = [...runs.values()];
      const visible = [
        ...all.filter(run => run.state === "running"),
        ...all.filter(run => run.state !== "running"),
      ].slice(0, MAX_CONTEXT_RUNS);
      if (!visible.length) return;
      return visible
        .map(
          run =>
            `${run.kind} ${run.id}, run ${run.runId}: ${run.state}${run.state === "running" ? "" : "; call status to collect the result"}`,
        )
        .join("\n");
    },

    reset() {
      shuttingDown = false;
    },

    async shutdown() {
      shuttingDown = true;
      const running = [...runs.values()].filter(run => run.state === "running");
      for (const run of running) run.controller.abort();
      await Promise.allSettled(running.map(run => run.promise));
      runs.clear();
    },
  };
}
