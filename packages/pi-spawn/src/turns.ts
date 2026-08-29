import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SPAWN_TOOLS, SPECIALIST_TOOLS } from "./constants.ts";
import { failure, label, runText, scientistName } from "./results.ts";
import {
  resultDetails,
  withThreadLock,
  SessionAdoptionError,
  type AgentPolicy,
  type SpawnKind,
  type SpawnMarker,
} from "./sessions.ts";
import { runSpawn, type SpawnActivity, type SpawnUiRequest, type SpawnUiResponse } from "./runner.ts";

export type RunChild = typeof runSpawn;

export type TurnRequest = {
  kind: SpawnKind;
  id: string;
  path: string;
  cwd: string;
  prompt: string;
  policy?: AgentPolicy | SpawnMarker;
  ctx: any;
  signal?: AbortSignal;
  /** Pi's tool progress callback; typed loosely because the payload shape is tool-defined. */
  onUpdate?: any;
  /** Runs inside the thread lock, immediately before the child starts. */
  beforeRun?: () => void | Promise<void>;
  runId?: string;
  background?: boolean;
};

export function childArgs(kind: SpawnKind, path: string, policy?: AgentPolicy | SpawnMarker): string[] {
  const args = ["--mode", "rpc", "--session", path];
  if (kind === "session") {
    if (policy?.model) args.push("--model", policy.model);
    return args;
  }
  const agentPolicy = policy as AgentPolicy | undefined;
  const excluded = [...SPAWN_TOOLS, ...(agentPolicy?.disableSpecialists ? SPECIALIST_TOOLS : [])];
  args.push("--exclude-tools", excluded.join(","));
  if (agentPolicy?.model) args.push("--model", agentPolicy.model);
  if (agentPolicy?.thinking) args.push("--thinking", agentPolicy.thinking);
  if (agentPolicy?.systemPrompt) args.push("--system-prompt", agentPolicy.systemPrompt);
  if (agentPolicy?.tools !== undefined) {
    if (agentPolicy.tools.length) args.push("--tools", agentPolicy.tools.join(","));
    else args.push("--no-tools");
  }
  return args;
}

/** Serializes the guard policy other packages contribute for this child, or marks it invalid. */
function spawnRuntimePolicy(pi: ExtensionAPI, cwd: string, sessionId: string): string {
  let policy: unknown;
  pi.events.emit("pylon:spawn-runtime-policy-request", {
    version: 1,
    cwd,
    sessionId,
    provide: (value: unknown) => {
      if (policy === undefined) policy = value;
    },
  });
  const invalid = JSON.stringify({ version: 1, invalid: true });
  const serialized = policy === undefined ? undefined : JSON.stringify(policy);
  return serialized !== undefined && Buffer.byteLength(serialized) <= 16 * 1024 ? serialized : invalid;
}

export function createTurnRunner(pi: ExtensionAPI, runChild: RunChild) {
  return async function executeTurn(request: TurnRequest) {
    const { kind, id, path, cwd, prompt, policy, ctx, signal, onUpdate, beforeRun, background = false } = request;
    const runId = request.runId ?? randomUUID();
    const started = Date.now();
    const agentName = scientistName(id);
    const name = label(kind);
    let model = policy?.model;
    let thinking = kind === "agent" ? (policy as AgentPolicy | undefined)?.thinking : undefined;
    let activity: readonly SpawnActivity[] = [];
    let authorized = beforeRun === undefined;
    const elapsed = () => Date.now() - started;

    const runningDetails = () => ({
      ...resultDetails(kind, id, path, cwd),
      runId,
      agentName,
      startedAt: new Date(started).toISOString(),
      state: "running",
      ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}),
      ...(background ? { background: true } : {}),
    });
    const report = (text: string, extra: Record<string, unknown>) => {
      // UI updates must not control child lifecycle.
      try {
        onUpdate?.({ content: text ? [{ type: "text", text }] : [], details: { ...runningDetails(), ...extra } });
      } catch {
        /* ignored */
      }
    };

    const onUiRequest = async (uiRequest: SpawnUiRequest, uiSignal: AbortSignal): Promise<SpawnUiResponse> => {
      if (background || !ctx.hasUI || uiRequest.method === "editor")
        return uiRequest.method === "confirm" ? { confirmed: false } : { cancelled: true };
      report(`${name} ${agentName} is waiting for input…`, { state: "attention", durationMs: elapsed() });
      const title = `${name} ${agentName}: ${uiRequest.title}`;
      const dialogOptions = {
        signal: uiSignal,
        ...(uiRequest.timeout !== undefined ? { timeout: uiRequest.timeout } : {}),
      };
      if (uiRequest.method === "confirm")
        return { confirmed: await ctx.ui.confirm(title, uiRequest.message, dialogOptions) };
      if (uiRequest.method === "select") {
        const value = await ctx.ui.select(title, uiRequest.options, dialogOptions);
        return value === undefined ? { cancelled: true } : { value };
      }
      const value = await ctx.ui.input(title, uiRequest.placeholder, dialogOptions);
      return value === undefined ? { cancelled: true } : { value };
    };

    report(`${name} ${agentName} is working…`, { activity });
    try {
      const run = await withThreadLock(
        path,
        async () => {
          if (beforeRun) await beforeRun();
          authorized = true;
          return runChild(childArgs(kind, path, policy), {
            cwd,
            prompt,
            signal,
            env: {
              PI_SPAWN_CHILD: kind,
              PI_SPAWN_AUTONOMOUS: "1",
              PI_SPAWN_DEPTH: String(Number(process.env.PI_SPAWN_DEPTH ?? 0) + 1),
              PI_SPAWN_GUARD_POLICY: spawnRuntimePolicy(pi, cwd, id),
            },
            onUiRequest,
            onUsage: usage => report(`${name} usage updated`, { durationMs: elapsed(), usage }),
            onText: text => report("", { durationMs: elapsed(), partialResponse: text }),
            onState: state => {
              model = state.model ?? model;
              thinking = state.thinking ?? thinking;
              report(`${name} runtime ready`, { durationMs: elapsed() });
            },
            onActivity: (item, all) => {
              activity = all;
              report(`${name} activity: ${item.tool}`, { durationMs: elapsed(), activityDelta: [item] });
            },
          });
        },
        signal,
      );
      return {
        content: [{ type: "text" as const, text: runText(kind, id, agentName, run) }],
        details: {
          ...resultDetails(kind, id, path, cwd),
          runId,
          agentName,
          startedAt: new Date(started).toISOString(),
          status: signal?.aborted ? "cancelled" : run.error ? "failed" : "completed",
          model: run.model ?? model,
          ...(background ? { background: true } : {}),
          ...((run.thinking ?? thinking) ? { thinking: run.thinking ?? thinking } : {}),
          durationMs: run.durationMs,
          usage: run.usage,
          ...(run.sessionUsage ? { sessionUsage: run.sessionUsage } : {}),
          turns: run.turns,
          activity: run.activity,
          stopReason: run.stopReason,
          truncated: run.truncated,
          ...(run.error ? { failureCode: "child_error", failureMessage: run.error } : {}),
        },
        usage: {
          input: run.usage.input,
          output: run.usage.output,
          cacheRead: run.usage.cacheRead,
          cacheWrite: run.usage.cacheWrite,
          totalTokens: run.usage.input + run.usage.output + run.usage.cacheRead + run.usage.cacheWrite,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: run.usage.cost },
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(
        error instanceof SessionAdoptionError ? error.code : "runner_error",
        `${name} ${id} turn failed: ${message}`,
        {
          ...(authorized ? resultDetails(kind, id, path, cwd) : {}),
          runId,
          agentName,
          startedAt: new Date(started).toISOString(),
          status: signal?.aborted ? "cancelled" : "failed",
          ...(background ? { background: true } : {}),
          failureMessage: message,
        },
      );
    }
  };
}

export type ExecuteTurn = ReturnType<typeof createTurnRunner>;
