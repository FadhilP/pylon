import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { capText } from "./result.ts";

export type ChildUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};
export type ChildTurnUsage = ChildUsage & {
  model?: string;
  stopReason?: string;
};
export type ScoutActivity = { kind: "call" | "result"; tool: string; text: string; isError?: boolean };
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
  exitCode: number;
  activity: ScoutActivity[];
  contextTokens: number;
  cacheReadTokens: number;
};
export type Invocation = { command: string; args: string[] };

let scoutRunQueue = Promise.resolve();

export function getPiInvocation(args: string[]): Invocation {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && existsSync(script))
    return { command: process.execPath, args: [script, ...args] };
  if (!/^(node|bun)(\.exe)?$/i.test(basename(process.execPath)))
    return { command: process.execPath, args };
  return { command: process.platform === "win32" ? "pi.cmd" : "pi", args };
}

function emptyUsage(): ChildUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}
const validTokens = (value: unknown): number => {
  const tokens = Number(value);
  return Number.isFinite(tokens) && tokens >= 0 ? tokens : 0;
};
const validCost = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
export function cacheReadTokensFromUsage(usage: any): number {
  return validTokens(usage?.cacheRead);
}
export function contextTokensFromUsage(usage: any): number {
  const cacheRead = cacheReadTokensFromUsage(usage);
  const nativeTotal = Number(usage?.totalTokens);
  if (Number.isFinite(nativeTotal) && nativeTotal > 0)
    return Math.max(0, nativeTotal - cacheRead);
  const parts = [usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite]
    .map(Number);
  if (!parts.every((value) => Number.isFinite(value) && value >= 0)) return 0;
  return Math.max(0, parts.reduce((sum, value) => sum + value, 0) - cacheRead);
}
function terminate(child: ChildProcess): void {
  if (child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid)
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      shell: false,
      stdio: "ignore",
    });
  else if (child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    setTimeout(() => {
      if (child.exitCode !== null) return;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, 1000).unref();
  }
}

export type RunPiOptions = {
  cwd: string;
  /** Initial RPC prompt. Prompts are never passed as positional CLI arguments. */
  prompt: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxCostUsd?: number;
  invocation?: Invocation;
  env?: NodeJS.ProcessEnv;
  inheritEnv?: boolean;
  onActivity?: (activity: ScoutActivity, all: readonly ScoutActivity[]) => void;
};

export async function runPi(args: string[], options: RunPiOptions): Promise<ScoutRun> {
  const previousRun = scoutRunQueue;
  let releaseRun = () => {};
  scoutRunQueue = new Promise<void>((resolve) => { releaseRun = resolve; });
  await previousRun;
  try {
    return await runPiUnlocked(args, options);
  } finally {
    releaseRun();
  }
}

async function runPiUnlocked(args: string[], options: RunPiOptions): Promise<ScoutRun> {
  const started = Date.now();
  const invocation = options.invocation ?? getPiInvocation(args);
  const child = spawn(invocation.command, invocation.args, {
    cwd: options.cwd,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
    env: options.inheritEnv === false ? options.env : options.env ? { ...process.env, ...options.env } : process.env,
  });
  const messages: any[] = [];
  const turns: ChildTurnUsage[] = [];
  const activity: ScoutActivity[] = [];
  let stdout = "", stderr = "", timedOut = false, aborted = false, protocolOverflow = false;
  let commandError: string | undefined;
  let agentSettled = false;
  let controlledCompletion = false;
  let budgetExceeded = false;
  let finalizationAttempted = false;
  let finalizationSucceeded = false;
  let finalizationFailed = false;
  let contextTokens = 0, cacheReadTokens = 0, reportedCost = 0;
  let finalizationMessage: any;
  let commandId = 0;

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
        if (error && !controlledCompletion && !timedOut && !aborted && !finalizationFailed) failCommand(type, error.message);
      });
    } catch (error) {
      failCommand(type, error instanceof Error ? error.message : String(error));
    }
  };
  const pushActivity = (item: ScoutActivity) => {
    activity.push(item);
    if (activity.length > 100) activity.shift();
    options.onActivity?.(item, activity);
  };
  const processLine = (line: string) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      // RPC responses are envelopes, not agent events. Only rejected commands matter.
      if (event.type === "response") {
        if (event.success === false && (event.command === "prompt" || event.command === "steer"))
          failCommand(event.command, event.error);
        return;
      }
      if (event.type === "agent_settled") {
        agentSettled = true;
        controlledCompletion = true;
        terminate(child);
        return;
      }
      if (event.type === "tool_execution_start") {
        pushActivity({ kind: "call", tool: event.toolName, text: JSON.stringify(event.args ?? {}) });
        return;
      }
      if (event.type === "tool_execution_end") {
        const text = (event.result?.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
        pushActivity({ kind: "result", tool: event.toolName, text: capText(text, 2000, 40).text, ...(event.isError ? { isError: true } : {}) });
        return;
      }
      if (event.type !== "message_end" || event.message?.role !== "assistant") return;
      const message = event.message;
      messages.push(message);
      const usage = message.usage ?? {};
      const latestContextTokens = contextTokensFromUsage(usage);
      const latestCacheReadTokens = cacheReadTokensFromUsage(usage);
      if (message.stopReason !== "aborted" && message.stopReason !== "error" && (latestContextTokens > 0 || latestCacheReadTokens > 0)) {
        contextTokens = latestContextTokens;
        cacheReadTokens = latestCacheReadTokens;
      }
      const cost = validCost(usage.cost?.total);
      turns.push({ input: usage.input ?? 0, output: usage.output ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0, cost, model: message.model, stopReason: message.stopReason });
      reportedCost += cost;

      if (finalizationAttempted && !finalizationMessage) {
        finalizationMessage = message;
        if (message.stopReason === "toolUse") {
          finalizationFailed = true;
          terminate(child);
        } else if (message.stopReason !== "error" && message.stopReason !== "aborted") {
          finalizationSucceeded = true;
        }
        return;
      }
      if (!budgetExceeded && message.stopReason === "toolUse" && options.maxCostUsd !== undefined && reportedCost >= options.maxCostUsd) {
        budgetExceeded = true;
        finalizationAttempted = true;
        sendCommand("steer", "Discovery budget exhausted. Stop searching and return your compact cited findings now. Do not call more tools.");
      }
    } catch {
      /* Malformed lines remain harmless unless no usable final response arrives. */
    }
  };

  child.stdout!.on("data", (data) => {
    stdout += data;
    if (Buffer.byteLength(stdout) > 1024 * 1024) {
      protocolOverflow = true;
      stdout = "";
      terminate(child);
      return;
    }
    const lines = stdout.split("\n");
    stdout = lines.pop() ?? "";
    for (const line of lines) processLine(line);
  });
  child.stderr!.on("data", (data) => {
    stderr += data;
    if (Buffer.byteLength(stderr) > 8192) stderr = Buffer.from(stderr).subarray(-8192).toString("utf8");
  });
  child.stdin!.on("error", (error) => {
    if (!controlledCompletion && !timedOut && !aborted && !finalizationFailed) failCommand("write", error.message);
  });
  const abort = () => { aborted = true; terminate(child); };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timeout = setTimeout(() => { timedOut = true; terminate(child); }, options.timeoutMs ?? 90_000);
  // Attach every handler before the initial command; RPC uses strict LF-delimited JSON.
  if (!aborted) sendCommand("prompt", options.prompt);
  const exitCode = await new Promise<number>((resolve) => {
    child.once("error", () => resolve(1));
    child.once("close", (code) => resolve(code ?? 1));
  });
  clearTimeout(timeout);
  options.signal?.removeEventListener("abort", abort);
  if (stdout.trim()) processLine(stdout);

  const usage = turns.reduce((sum, turn) => ({
    input: sum.input + turn.input, output: sum.output + turn.output,
    cacheRead: sum.cacheRead + turn.cacheRead, cacheWrite: sum.cacheWrite + turn.cacheWrite, cost: sum.cost + turn.cost,
  }), emptyUsage());
  const final = finalizationMessage ?? messages.at(-1);
  const rawText = final?.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") ?? "";
  const capped = capText(rawText);
  const incompleteFinalization = agentSettled && finalizationAttempted && !finalizationSucceeded;
  const budgetFailure = finalizationFailed || incompleteFinalization;
  const error = protocolOverflow
    ? "Scout protocol output exceeded 1 MiB."
    : aborted
      ? "Scout aborted."
      : timedOut
        ? "Scout timed out."
        : commandError
          ? commandError
          : finalizationFailed
            ? "Scout exceeded its discovery budget and requested more tools during finalization."
            : incompleteFinalization
              ? "Scout settled before returning its budget finalization."
              : !agentSettled && !controlledCompletion
                ? "Scout exited before agent settlement."
                : final?.stopReason === "error"
                  ? final.errorMessage || "Scout model error."
                  : !rawText
                    ? "Scout returned no assistant text."
                    : undefined;
  return {
    text: capped.text,
    model: final?.model,
    stopReason: final?.stopReason,
    error,
    ...(budgetFailure ? { failure: "budget_exceeded" as const } : {}),
    budgetExceeded,
    finalizationAttempted,
    finalizationSucceeded,
    stderr,
    durationMs: Date.now() - started,
    usage,
    turns,
    truncated: capped.truncated,
    exitCode,
    activity,
    contextTokens,
    cacheReadTokens,
  };
}
