import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";

export type ChildUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
export type WorkerActivity = { kind: "call" | "result"; tool: string; text: string; isError?: boolean };
export type WorkerRun = {
  text: string;
  cwd?: string;
  model?: string;
  stopReason?: string;
  error?: string;
  failure?: "aborted" | "timed_out" | "child_error";
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
  invocation?: Invocation;
  onActivity?: (activity: WorkerActivity, all: readonly WorkerActivity[]) => void;
};

let workerQueue = Promise.resolve();
const emptyUsage = (): ChildUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

function capText(text: string, maxBytes = 16 * 1024): { text: string; truncated: boolean } {
  let output = text;
  let truncated = false;
  while (Buffer.byteLength(output, "utf8") > maxBytes) {
    output = output.slice(0, -1);
    truncated = true;
  }
  return { text: truncated ? `${output}\n\n[Truncated to ${maxBytes} bytes.]` : output, truncated };
}

export function getPiInvocation(args: string[]): Invocation {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && existsSync(script))
    return { command: process.execPath, args: [script, ...args] };
  if (!/^(node|bun)(\.exe)?$/i.test(basename(process.execPath)))
    return { command: process.execPath, args };
  return { command: process.platform === "win32" ? "pi.cmd" : "pi", args };
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
  const previous = workerQueue;
  let release = () => {};
  workerQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await runUnlocked(args, options); }
  finally { release(); }
}

async function runUnlocked(args: string[], options: RunOptions): Promise<WorkerRun> {
  const started = Date.now();
  const invocation = options.invocation ?? getPiInvocation(args);
  const child = spawn(invocation.command, invocation.args, {
    cwd: options.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    detached: process.platform !== "win32", env: process.env,
  });
  const messages: any[] = [];
  const usages: ChildUsage[] = [];
  const activity: WorkerActivity[] = [];
  let stdout = "", stderr = "", timedOut = false, aborted = false, protocolOverflow = false;
  const processLine = (line: string) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (event.type === "tool_execution_start") {
        const item: WorkerActivity = { kind: "call", tool: event.toolName, text: JSON.stringify(event.args ?? {}) };
        activity.push(item); if (activity.length > 100) activity.shift(); options.onActivity?.(item, activity); return;
      }
      if (event.type === "tool_execution_end") {
        const raw = (event.result?.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
        const item: WorkerActivity = { kind: "result", tool: event.toolName, text: capText(raw, 2000).text, ...(event.isError ? { isError: true } : {}) };
        activity.push(item); if (activity.length > 100) activity.shift(); options.onActivity?.(item, activity); return;
      }
      if (event.type !== "message_end" || event.message?.role !== "assistant") return;
      const message = event.message;
      messages.push(message);
      const usage = message.usage ?? {};
      usages.push({ input: usage.input ?? 0, output: usage.output ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0, cost: usage.cost?.total ?? 0 });
    } catch { /* final response reports malformed protocol */ }
  };
  child.stdout!.on("data", (data) => {
    stdout += data;
    if (Buffer.byteLength(stdout) > 1024 * 1024) { protocolOverflow = true; stdout = ""; terminate(child); return; }
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
  const usage = usages.reduce((sum, item) => ({
    input: sum.input + item.input, output: sum.output + item.output,
    cacheRead: sum.cacheRead + item.cacheRead, cacheWrite: sum.cacheWrite + item.cacheWrite,
    cost: sum.cost + item.cost,
  }), emptyUsage());
  const final = messages.at(-1);
  const rawText = final?.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") ?? "";
  const capped = capText(rawText);
  const failure = aborted ? "aborted" : timedOut ? "timed_out" : protocolOverflow || exitCode !== 0 || final?.stopReason === "error" || !rawText ? "child_error" : undefined;
  const error = protocolOverflow ? "Worker protocol output exceeded 1 MiB."
    : aborted ? "Worker aborted; edits may remain."
    : timedOut ? "Worker timed out; edits may remain."
    : exitCode !== 0 ? `Worker exited with code ${exitCode}; edits may remain.`
    : final?.stopReason === "error" ? final.errorMessage || "Worker model error; edits may remain."
    : !rawText ? "Worker returned no assistant text; edits may remain." : undefined;
  return { text: capped.text, cwd: options.cwd, model: final?.model, stopReason: final?.stopReason, error, failure, stderr, durationMs: Date.now() - started, usage, turns: messages.length, truncated: capped.truncated, exitCode, activity };
}
