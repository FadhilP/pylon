import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { truncateUtf8 } from "pylon-core/utf8";

export const GRUNT_CONTEXT_LIMIT = 262_144;
export const GRUNT_PROTOCOL_MAX_BYTES = 5 * 1024 * 1024;

export type ChildUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
export type WorkerActivity = {
  id?: string;
  kind: "call" | "result";
  tool: string;
  text: string;
  isError?: boolean;
  startedAt?: string;
  durationMs?: number;
};
export type WorkerRun = {
  text: string;
  cwd?: string;
  model?: string;
  stopReason?: string;
  error?: string;
  failure?: "aborted" | "timed_out" | "budget_exceeded" | "context_exceeded" | "child_error";
  stderr: string;
  durationMs: number;
  usage: ChildUsage;
  turns: number;
  truncated: boolean;
  exitCode: number;
  activity: WorkerActivity[];
};
export type Invocation = { command: string; args: string[] };

type RunOptions = {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxTurns?: number;
  maxCostUsd?: number;
  invocation?: Invocation;
  onActivity?: (activity: WorkerActivity, all: readonly WorkerActivity[]) => void;
  onUsage?: (usage: ChildUsage) => void;
};

const emptyUsage = (): ChildUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
const validTokens = (value: unknown): number => {
  const tokens = Number(value);
  return Number.isFinite(tokens) && tokens >= 0 ? tokens : 0;
};
export function contextTokensFromUsage(usage: any): number {
  const cacheRead = validTokens(usage?.cacheRead);
  const totalTokens = Number(usage?.totalTokens);
  if (Number.isFinite(totalTokens) && totalTokens > 0)
    return Math.max(0, totalTokens - cacheRead);
  const parts = [usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite].map(Number);
  if (!parts.every((value) => Number.isFinite(value) && value >= 0)) return 0;
  return Math.max(0, parts.reduce((sum, value) => sum + value, 0) - cacheRead);
}

function capText(text: string, maxBytes = 16 * 1024): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  const suffix = `\n\n[Truncated to ${maxBytes} bytes.]`;
  return {
    text: truncateUtf8(text, maxBytes - Buffer.byteLength(suffix, "utf8")) + suffix,
    truncated: true,
  };
}

export function getPiInvocation(args: string[]): Invocation {
  const packageDir = getPackageDir();
  const cli = join(packageDir, "dist", "cli.js");
  const script = process.argv[1];
  const piEntrypoints = [cli, join(packageDir, "dist", "rpc-entry.js"), join(packageDir, "src", "cli.ts"), join(packageDir, "src", "cli-new.ts"), join(packageDir, "src", "rpc-entry.ts")]
    .map((path) => resolve(path));
  if (script && !script.startsWith("/$bunfs/root/") && existsSync(script) && piEntrypoints.includes(resolve(script)))
    return { command: process.execPath, args: [script, ...args] };
  if (!/^(node|bun)(\.exe)?$/i.test(basename(process.execPath)))
    return { command: process.execPath, args };
  return { command: process.execPath, args: [cli, ...args] };
}

function terminate(child: ChildProcess): void {
  if (child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid)
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { shell: false, stdio: "ignore" });
  else if (child.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    setTimeout(() => {
      if (child.exitCode !== null) return;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }, 1000).unref();
  }
}

export async function runPi(args: string[], options: RunOptions): Promise<WorkerRun> {
  const started = Date.now();
  const invocation = options.invocation ?? getPiInvocation(args);
  const child = spawn(invocation.command, invocation.args, {
    cwd: options.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    detached: process.platform !== "win32", env: process.env,
  });
  const messages: any[] = [];
  const usage = emptyUsage();
  const activity: WorkerActivity[] = [];
  const activityStarts = new Map<string, { startedAtMs: number }>();
  let stdout = "", stderr = "", timedOut = false, aborted = false, protocolOverflow = false, protocolMalformed = false;
  let budgetExceeded = "", contextExceeded = "";
  const processLine = (line: string) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (event.type === "tool_execution_start") {
        const startedAtMs = Date.now();
        const id = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
        if (id) activityStarts.set(id, { startedAtMs });
        const item: WorkerActivity = { ...(id ? { id } : {}), kind: "call", tool: event.toolName, text: JSON.stringify(event.args ?? {}), startedAt: new Date(startedAtMs).toISOString() };
        activity.push(item); if (activity.length > 100) activity.shift(); options.onActivity?.(item, activity); return;
      }
      if (event.type === "tool_execution_end") {
        const raw = (event.result?.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
        const id = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
        const timing = id ? activityStarts.get(id) : undefined;
        if (id) activityStarts.delete(id);
        const durationMs = timing ? Math.max(0, Date.now() - timing.startedAtMs) : undefined;
        const item: WorkerActivity = { ...(id ? { id } : {}), kind: "result", tool: event.toolName, text: capText(raw, 2000).text, ...(event.isError ? { isError: true } : {}), ...(durationMs === undefined ? {} : { durationMs }) };
        activity.push(item); if (activity.length > 100) activity.shift(); options.onActivity?.(item, activity); return;
      }
      if (event.type !== "message_end" || event.message?.role !== "assistant") return;
      const message = event.message;
      messages.push(message);
      const turnUsage = message.usage ?? {};
      usage.input += validTokens(turnUsage.input);
      usage.output += validTokens(turnUsage.output);
      usage.cacheRead += validTokens(turnUsage.cacheRead);
      usage.cacheWrite += validTokens(turnUsage.cacheWrite);
      usage.cost += validTokens(turnUsage.cost?.total);
      try { options.onUsage?.({ ...usage }); } catch { /* Progress observers must not control the child. */ }
      const contextTokens = contextTokensFromUsage(turnUsage);
      if (contextTokens > GRUNT_CONTEXT_LIMIT)
        contextExceeded = `Worker exceeded context limit (${contextTokens} > ${GRUNT_CONTEXT_LIMIT} tokens).`;
      else if (message.stopReason === "toolUse" && options.maxTurns !== undefined && messages.length >= options.maxTurns)
        budgetExceeded = `Worker reached turn limit (${options.maxTurns}).`;
      else if (message.stopReason === "toolUse" && options.maxCostUsd !== undefined && usage.cost >= options.maxCostUsd)
        budgetExceeded = `Worker reached cost limit ($${options.maxCostUsd.toFixed(2)}).`;
      if (contextExceeded || budgetExceeded) terminate(child);
    } catch { protocolMalformed = true; }
  };
  child.stdout!.on("data", (data) => {
    stdout += data;
    if (Buffer.byteLength(stdout) > GRUNT_PROTOCOL_MAX_BYTES) { protocolOverflow = true; stdout = ""; terminate(child); return; }
    const lines = stdout.split("\n"); stdout = lines.pop() ?? ""; for (const line of lines) processLine(line);
  });
  child.stderr!.on("data", (data) => {
    stderr += data;
    if (Buffer.byteLength(stderr) > 8192) stderr = Buffer.from(stderr).subarray(-8192).toString("utf8");
  });
  const abort = () => { aborted = true; terminate(child); };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timeout = setTimeout(() => { timedOut = true; terminate(child); }, options.timeoutMs ?? 90_000);
  const exitCode = await new Promise<number>((resolve) => {
    child.once("error", () => resolve(1)); child.once("close", (code) => resolve(code ?? 1));
  });
  clearTimeout(timeout); options.signal?.removeEventListener("abort", abort);
  if (stdout.trim()) processLine(stdout);
  const final = messages.at(-1);
  const rawText = final?.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") ?? "";
  const capped = capText(rawText);
  const incomplete = final?.stopReason !== "stop";
  const failure = aborted ? "aborted" : timedOut ? "timed_out" : contextExceeded ? "context_exceeded"
    : budgetExceeded ? "budget_exceeded" : protocolOverflow || protocolMalformed || exitCode !== 0 || incomplete || !rawText ? "child_error" : undefined;
  const error = protocolOverflow ? "Worker protocol buffer exceeded 5 MiB."
    : protocolMalformed ? "Worker emitted malformed JSON protocol output."
    : aborted ? "Worker aborted; edits may remain."
    : timedOut ? "Worker timed out; edits may remain."
    : contextExceeded ? contextExceeded
    : budgetExceeded ? budgetExceeded
    : exitCode !== 0 ? `Worker exited with code ${exitCode}; edits may remain.`
    : final?.stopReason === "error" ? final.errorMessage || "Worker model error; edits may remain."
    : incomplete ? `Worker ended with incomplete stop reason: ${final?.stopReason ?? "missing"}.`
    : !rawText ? "Worker returned no assistant text; edits may remain." : undefined;
  return { text: capped.text, cwd: options.cwd, model: final?.model, stopReason: final?.stopReason, error, failure, stderr, durationMs: Date.now() - started, usage, turns: messages.length, truncated: capped.truncated, exitCode, activity };
}
