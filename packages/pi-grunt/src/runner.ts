import { spawn } from "node:child_process";
import { truncateUtf8 } from "pylon-core/utf8";
import {
  activityRecorder,
  contextTokensFromUsage,
  emptyUsage,
  getPiInvocation,
  lineBuffer,
  stderrTail,
  terminate,
  validTokens,
  type ChildActivity,
  type ChildUsage,
  type Invocation,
} from "pylon-core/child-process";

export const GRUNT_CONTEXT_LIMIT = 262_144;
export const GRUNT_PROTOCOL_MAX_BYTES = 5 * 1024 * 1024;

export { contextTokensFromUsage, getPiInvocation };
export type { ChildUsage, Invocation };
export type WorkerActivity = ChildActivity;
export type WorkerRun = {
  text: string;
  cwd?: string;
  model?: string;
  stopReason?: string;
  error?: string;
  failure?:
    | "aborted"
    | "timed_out"
    | "budget_exceeded"
    | "context_exceeded"
    | "child_error";
  stderr: string;
  durationMs: number;
  usage: ChildUsage;
  turns: number;
  truncated: boolean;
  exitCode: number;
  activity: WorkerActivity[];
};

type RunOptions = {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxTurns?: number;
  maxCostUsd?: number;
  invocation?: Invocation;
  onActivity?: (
    activity: WorkerActivity,
    all: readonly WorkerActivity[],
  ) => void;
  onUsage?: (usage: ChildUsage) => void;
};

function capText(
  text: string,
  maxBytes = 16 * 1024,
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes)
    return { text, truncated: false };
  const suffix = `\n\n[Truncated to ${maxBytes} bytes.]`;
  return {
    text:
      truncateUtf8(text, maxBytes - Buffer.byteLength(suffix, "utf8")) + suffix,
    truncated: true,
  };
}

export async function runPi(
  args: string[],
  options: RunOptions,
): Promise<WorkerRun> {
  const started = Date.now();
  const invocation = options.invocation ?? getPiInvocation(args);
  const child = spawn(invocation.command, invocation.args, {
    cwd: options.cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
    env: process.env,
  });
  const messages: any[] = [];
  const usage = emptyUsage();
  const recorder = activityRecorder(
    (text) => capText(text, 2000).text,
    options.onActivity,
  );
  const stderr = stderrTail();
  let timedOut = false,
    aborted = false,
    protocolOverflow = false,
    protocolMalformed = false;
  let budgetExceeded = "",
    contextExceeded = "";

  const observeTurn = (message: any) => {
    messages.push(message);
    const turnUsage = message.usage ?? {};
    usage.input += validTokens(turnUsage.input);
    usage.output += validTokens(turnUsage.output);
    usage.cacheRead += validTokens(turnUsage.cacheRead);
    usage.cacheWrite += validTokens(turnUsage.cacheWrite);
    usage.cost += validTokens(turnUsage.cost?.total);
    try {
      options.onUsage?.({ ...usage });
    } catch {
      /* Progress observers must not control the child. */
    }
    const contextTokens = contextTokensFromUsage(turnUsage);
    if (contextTokens > GRUNT_CONTEXT_LIMIT)
      contextExceeded = `Worker exceeded context limit (${contextTokens} > ${GRUNT_CONTEXT_LIMIT} tokens).`;
    else if (
      message.stopReason === "toolUse" &&
      options.maxTurns !== undefined &&
      messages.length >= options.maxTurns
    )
      budgetExceeded = `Worker reached turn limit (${options.maxTurns}).`;
    else if (
      message.stopReason === "toolUse" &&
      options.maxCostUsd !== undefined &&
      usage.cost >= options.maxCostUsd
    )
      budgetExceeded = `Worker reached cost limit ($${options.maxCostUsd.toFixed(2)}).`;
    if (contextExceeded || budgetExceeded) terminate(child);
  };

  const processLine = (line: string) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (event.type === "tool_execution_start") return recorder.start(event);
      if (event.type === "tool_execution_end") return recorder.end(event);
      if (event.type !== "message_end" || event.message?.role !== "assistant")
        return;
      observeTurn(event.message);
    } catch {
      protocolMalformed = true;
    }
  };

  const stdout = lineBuffer(processLine, GRUNT_PROTOCOL_MAX_BYTES, () => {
    protocolOverflow = true;
    terminate(child);
  });
  child.stdout!.on("data", (data) => stdout.push(data));
  child.stderr!.on("data", (data) => stderr.push(data));
  const abort = () => {
    aborted = true;
    terminate(child);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate(child);
  }, options.timeoutMs ?? 90_000);
  const exitCode = await new Promise<number>((resolve) => {
    child.once("error", () => resolve(1));
    child.once("close", (code) => resolve(code ?? 1));
  });
  clearTimeout(timeout);
  options.signal?.removeEventListener("abort", abort);
  stdout.flush();
  const final = messages.at(-1);
  const rawText =
    final?.content
      ?.filter((part: any) => part.type === "text")
      .map((part: any) => part.text)
      .join("\n") ?? "";
  const capped = capText(rawText);
  const incomplete = final?.stopReason !== "stop";
  const failure = aborted
    ? "aborted"
    : timedOut
      ? "timed_out"
      : contextExceeded
        ? "context_exceeded"
        : budgetExceeded
          ? "budget_exceeded"
          : protocolOverflow ||
              protocolMalformed ||
              exitCode !== 0 ||
              incomplete ||
              !rawText
            ? "child_error"
            : undefined;
  const error = protocolOverflow
    ? "Worker protocol buffer exceeded 5 MiB."
    : protocolMalformed
      ? "Worker emitted malformed JSON protocol output."
      : aborted
        ? "Worker aborted; edits may remain."
        : timedOut
          ? "Worker timed out; edits may remain."
          : contextExceeded
            ? contextExceeded
            : budgetExceeded
              ? budgetExceeded
              : exitCode !== 0
                ? `Worker exited with code ${exitCode}; edits may remain.`
                : final?.stopReason === "error"
                  ? final.errorMessage ||
                    "Worker model error; edits may remain."
                  : incomplete
                    ? `Worker ended with incomplete stop reason: ${final?.stopReason ?? "missing"}.`
                    : !rawText
                      ? "Worker returned no assistant text; edits may remain."
                      : undefined;
  return {
    text: capped.text,
    cwd: options.cwd,
    model: final?.model,
    stopReason: final?.stopReason,
    error,
    failure,
    stderr: stderr.text,
    durationMs: Date.now() - started,
    usage,
    turns: messages.length,
    truncated: capped.truncated,
    exitCode,
    activity: recorder.items,
  };
}
