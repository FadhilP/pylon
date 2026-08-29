import { spawn } from "node:child_process";
import {
  activityRecorder,
  cacheReadTokensFromUsage,
  contextTokensFromUsage,
  emptyUsage,
  getPiInvocation,
  lineBuffer,
  stderrTail,
  terminate,
  validCost,
  validTokens,
  type ChildActivity,
  type ChildUsage,
  type Invocation,
} from "pylon-core/child-process";
import { capReport, capText, type EvidenceAnchor } from "./result.ts";

const SCOUT_PROTOCOL_MAX_BYTES = 5 * 1024 * 1024;

export { cacheReadTokensFromUsage, contextTokensFromUsage, getPiInvocation };
export type { ChildUsage, Invocation };
export type ChildTurnUsage = ChildUsage & {
  model?: string;
  stopReason?: string;
};
export type ScoutActivity = ChildActivity;
export type ScoutRun = {
  text: string;
  model?: string;
  stopReason?: string;
  error?: string;
  failure?: "budget_exceeded";
  /** The discovery ceiling was reached and Scout was instructed to finalize. */
  budgetExceeded: boolean;
  finalizationAttempted: boolean;
  finalizationSucceeded: boolean;
  stderr: string;
  durationMs: number;
  usage: ChildUsage;
  turns: ChildTurnUsage[];
  truncated: boolean;
  omittedEvidence?: EvidenceAnchor[];
  exitCode: number;
  activity: ScoutActivity[];
  contextTokens: number;
  cacheReadTokens: number;
};

let scoutRunQueue = Promise.resolve();

export type RunPiOptions = {
  cwd: string;
  /** Initial RPC prompt. Prompts are never passed as positional CLI arguments. */
  prompt: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Ask the child to return its final report after this many milliseconds, before the hard timeout. */
  finalizeAfterMs?: number;
  maxCostUsd?: number;
  /** Caller-local final-report cap; false leaves final capping to the caller. */
  resultMaxBytes?: number | false;
  invocation?: Invocation;
  env?: NodeJS.ProcessEnv;
  inheritEnv?: boolean;
  /** Bypass the shared child-process queue for callers with isolated per-run state. */
  concurrent?: boolean;
  onActivity?: (activity: ScoutActivity, all: readonly ScoutActivity[]) => void;
  onUsage?: (usage: ChildUsage) => void;
};

export async function runPi(
  args: string[],
  options: RunPiOptions,
): Promise<ScoutRun> {
  if (options.concurrent) return runPiUnlocked(args, options);
  const previousRun = scoutRunQueue;
  let releaseRun = () => {};
  scoutRunQueue = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  await previousRun;
  try {
    if (options.signal?.aborted)
      throw new DOMException("Scout run was aborted.", "AbortError");
    return await runPiUnlocked(args, options);
  } finally {
    releaseRun();
  }
}

async function runPiUnlocked(
  args: string[],
  options: RunPiOptions,
): Promise<ScoutRun> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 90_000;
  if (
    options.finalizeAfterMs !== undefined &&
    (!Number.isFinite(options.finalizeAfterMs) ||
      options.finalizeAfterMs <= 0 ||
      options.finalizeAfterMs >= timeoutMs)
  ) {
    throw new Error(
      "Scout finalization deadline must be positive and earlier than its timeout",
    );
  }
  const invocation = options.invocation ?? getPiInvocation(args);
  const child = spawn(invocation.command, invocation.args, {
    cwd: options.cwd,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
    env:
      options.inheritEnv === false
        ? options.env
        : options.env
          ? { ...process.env, ...options.env }
          : process.env,
  });
  const messages: any[] = [];
  const turns: ChildTurnUsage[] = [];
  const usage = emptyUsage();
  const recorder = activityRecorder(
    (text) => capText(text, 2000, 40).text,
    options.onActivity,
  );
  const stderr = stderrTail();
  let timedOut = false,
    aborted = false,
    protocolOverflow = false;
  let commandError: string | undefined;
  let agentSettled = false;
  let controlledCompletion = false;
  let budgetExceeded = false;
  let contextTokens = 0,
    cacheReadTokens = 0,
    reportedCost = 0;
  let commandId = 0;

  /**
   * Scout can be told to stop searching and return early, on budget or on deadline.
   * The request, the reply that answers it, and whether that reply was usable are one
   * unit of state; keeping them together is what makes the outcome ladder below readable.
   */
  const finalization = {
    attempted: false,
    succeeded: false,
    failed: false,
    reason: undefined as "budget" | "deadline" | undefined,
    message: undefined as any,
  };

  const failCommand = (command: string, detail?: unknown) => {
    if (commandError) return;
    const suffix = typeof detail === "string" && detail ? `: ${detail}` : "";
    commandError = `Scout RPC ${command} command failed${suffix}`;
    terminate(child);
  };
  const sendCommand = (type: "prompt" | "steer", message: string) => {
    const command = { id: `scout-${++commandId}`, type, message };
    try {
      child.stdin!.write(`${JSON.stringify(command)}\n`, (error) => {
        if (
          error &&
          !controlledCompletion &&
          !timedOut &&
          !aborted &&
          !finalization.failed
        )
          failCommand(type, error.message);
      });
    } catch (error) {
      failCommand(type, error instanceof Error ? error.message : String(error));
    }
  };
  const requestFinalization = (
    reason: "budget" | "deadline",
    message: string,
  ) => {
    if (
      finalization.attempted ||
      controlledCompletion ||
      timedOut ||
      aborted ||
      commandError
    )
      return;
    finalization.attempted = true;
    finalization.reason = reason;
    sendCommand("steer", message);
  };
  /** Returns true when the message was consumed as the reply to a finalization request. */
  const observeFinalization = (message: any) => {
    if (!finalization.attempted || finalization.message) return false;
    if (message.stopReason === "toolUse") {
      // A budget finalization treats "more tools" as a hard failure; a deadline one keeps waiting.
      if (finalization.reason === "budget") {
        finalization.message = message;
        finalization.failed = true;
        terminate(child);
      }
      return true;
    }
    finalization.message = message;
    if (message.stopReason !== "error" && message.stopReason !== "aborted")
      finalization.succeeded = true;
    return true;
  };

  const observeTurn = (message: any) => {
    messages.push(message);
    const rawUsage = message.usage ?? {};
    const latestContextTokens = contextTokensFromUsage(rawUsage);
    const latestCacheReadTokens = cacheReadTokensFromUsage(rawUsage);
    if (
      message.stopReason !== "aborted" &&
      message.stopReason !== "error" &&
      (latestContextTokens > 0 || latestCacheReadTokens > 0)
    ) {
      contextTokens = latestContextTokens;
      cacheReadTokens = latestCacheReadTokens;
    }
    const turn = {
      input: validTokens(rawUsage.input),
      output: validTokens(rawUsage.output),
      cacheRead: validTokens(rawUsage.cacheRead),
      cacheWrite: validTokens(rawUsage.cacheWrite),
      cost: validCost(rawUsage.cost?.total),
      model: message.model,
      stopReason: message.stopReason,
    };
    turns.push(turn);
    reportedCost += turn.cost;
    usage.input += turn.input;
    usage.output += turn.output;
    usage.cacheRead += turn.cacheRead;
    usage.cacheWrite += turn.cacheWrite;
    usage.cost += turn.cost;
    try {
      options.onUsage?.({ ...usage });
    } catch {
      /* Progress observers must not control the child. */
    }

    if (observeFinalization(message)) return;
    if (
      !budgetExceeded &&
      message.stopReason === "toolUse" &&
      options.maxCostUsd !== undefined &&
      reportedCost >= options.maxCostUsd
    ) {
      budgetExceeded = true;
      requestFinalization(
        "budget",
        "Discovery budget exhausted. Stop searching and return your compact cited findings now. Do not call more tools.",
      );
    }
  };

  const processLine = (line: string) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      // RPC responses are envelopes, not agent events. Only rejected commands matter.
      if (event.type === "response") {
        if (
          event.success === false &&
          (event.command === "prompt" || event.command === "steer")
        )
          failCommand(event.command, event.error);
        return;
      }
      if (event.type === "agent_settled") {
        agentSettled = true;
        controlledCompletion = true;
        terminate(child);
        return;
      }
      if (event.type === "tool_execution_start") return recorder.start(event);
      if (event.type === "tool_execution_end") return recorder.end(event);
      if (event.type !== "message_end" || event.message?.role !== "assistant")
        return;
      observeTurn(event.message);
    } catch {
      /* Malformed lines remain harmless unless no usable final response arrives. */
    }
  };

  const stdout = lineBuffer(processLine, SCOUT_PROTOCOL_MAX_BYTES, () => {
    protocolOverflow = true;
    terminate(child);
  });
  child.stdout!.on("data", (data) => stdout.push(data));
  child.stderr!.on("data", (data) => stderr.push(data));
  child.stdin!.on("error", (error) => {
    if (!controlledCompletion && !timedOut && !aborted && !finalization.failed)
      failCommand("write", error.message);
  });
  const abort = () => {
    aborted = true;
    terminate(child);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate(child);
  }, timeoutMs);
  const finalizationTimer =
    options.finalizeAfterMs === undefined
      ? undefined
      : setTimeout(() => {
          requestFinalization(
            "deadline",
            "Research deadline approaching. Stop searching and return your compact cited findings now. Do not call more tools.",
          );
        }, options.finalizeAfterMs);
  finalizationTimer?.unref();
  // Attach every handler before the initial command; RPC uses strict LF-delimited JSON.
  if (!aborted) sendCommand("prompt", options.prompt);
  const exitCode = await new Promise<number>((resolve) => {
    child.once("error", () => resolve(1));
    child.once("close", (code) => resolve(code ?? 1));
  });
  clearTimeout(timeout);
  if (finalizationTimer) clearTimeout(finalizationTimer);
  options.signal?.removeEventListener("abort", abort);
  stdout.flush();

  const final = finalization.message ?? messages.at(-1);
  const rawText =
    final?.content
      ?.filter((part: any) => part.type === "text")
      .map((part: any) => part.text)
      .join("\n") ?? "";
  const capped =
    options.resultMaxBytes === false
      ? { text: rawText, truncated: false, omittedEvidence: [] }
      : options.resultMaxBytes === undefined
        ? capText(rawText)
        : capReport(rawText, options.resultMaxBytes);
  const incompleteFinalization =
    agentSettled && finalization.attempted && !finalization.succeeded;
  const finalizationFailure = finalization.failed || incompleteFinalization;
  const finalizationLabel =
    finalization.reason === "deadline"
      ? "deadline finalization"
      : "budget finalization";
  // First matching row wins; order is the diagnosis priority, most specific cause first.
  const errorLadder: Array<[boolean, string]> = [
    [protocolOverflow, "Scout protocol buffer exceeded 5 MiB."],
    [aborted, "Scout aborted."],
    [timedOut, "Scout timed out."],
    [commandError !== undefined, commandError!],
    [
      finalization.failed,
      `Scout requested more tools during finalization (${finalizationLabel}).`,
    ],
    [
      incompleteFinalization,
      `Scout settled before returning its finalization (${finalizationLabel}).`,
    ],
    [
      !agentSettled && !controlledCompletion,
      "Scout exited before agent settlement.",
    ],
    [
      final?.stopReason === "error",
      final?.errorMessage || "Scout model error.",
    ],
    [!rawText, "Scout returned no assistant text."],
  ];
  const error = errorLadder.find(([failed]) => failed)?.[1];
  return {
    text: capped.text,
    model: final?.model,
    stopReason: final?.stopReason,
    error,
    ...(finalization.reason === "budget" && finalizationFailure
      ? { failure: "budget_exceeded" as const }
      : {}),
    budgetExceeded,
    finalizationAttempted: finalization.attempted,
    finalizationSucceeded: finalization.succeeded,
    stderr: stderr.text,
    durationMs: Date.now() - started,
    usage,
    turns,
    truncated: capped.truncated,
    omittedEvidence: capped.omittedEvidence,
    exitCode,
    activity: recorder.items,
    contextTokens,
    cacheReadTokens,
  };
}
