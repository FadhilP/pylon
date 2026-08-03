import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { getPackageDir, truncateHead } from "@earendil-works/pi-coding-agent";

export type SpawnUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};

export type SpawnActivity = {
  kind: "call" | "result";
  tool: string;
  text: string;
  isError?: boolean;
};

export type SpawnRun = {
  text: string;
  model?: string;
  stopReason?: string;
  error?: string;
  stderr: string;
  durationMs: number;
  usage: SpawnUsage;
  turns: number;
  truncated: boolean;
  activity: SpawnActivity[];
};

export type Invocation = { command: string; args: string[] };

export type RunSpawnOptions = {
  cwd: string;
  prompt: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  invocation?: Invocation;
  env?: NodeJS.ProcessEnv;
  onActivity?: (item: SpawnActivity, all: readonly SpawnActivity[]) => void;
  onUsage?: (usage: SpawnUsage) => void;
};

const emptyUsage = (): SpawnUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
const validNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
};

export function spawnTimeoutMs(value = process.env.PI_SPAWN_TIMEOUT_MS): number {
  if (value === undefined) return 15 * 60 * 1000;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 7_200_000)
    throw new Error("PI_SPAWN_TIMEOUT_MS must be an integer between 1 and 7200000");
  return timeout;
}

export function getPiInvocation(args: string[]): Invocation {
  const packageDir = getPackageDir();
  const cli = join(packageDir, "dist", "cli.js");
  const script = process.argv[1];
  const piEntrypoints = [cli, join(packageDir, "src", "cli.ts"), join(packageDir, "src", "cli-new.ts")]
    .map((path) => resolve(path));
  if (script && !script.startsWith("/$bunfs/root/") && existsSync(script) && piEntrypoints.includes(resolve(script)))
    return { command: process.execPath, args: [script, ...args] };
  if (!/^(node|bun)(\.exe)?$/i.test(basename(process.execPath)))
    return { command: process.execPath, args };
  return { command: process.execPath, args: [cli, ...args] };
}

function terminate(child: ChildProcess): void {
  if (child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { shell: false, stdio: "ignore" });
    return;
  }
  if (!child.pid) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  setTimeout(() => {
    if (child.exitCode !== null) return;
    try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }, 1000).unref();
}

const textContent = (message: any): string =>
  (message?.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");

export async function runSpawn(args: string[], options: RunSpawnOptions): Promise<SpawnRun> {
  const started = Date.now();
  const invocation = options.invocation ?? getPiInvocation(args);
  const child = spawn(invocation.command, invocation.args, {
    cwd: options.cwd,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });
  const messages: any[] = [];
  const activity: SpawnActivity[] = [];
  const usage = emptyUsage();
  let stdout = "", stderr = "", commandError = "", timedOut = false, aborted = false;
  let protocolOverflow = false, settled = false, commandId = 0;

  const stopWithCommandError = (message: string) => {
    if (commandError) return;
    commandError = message;
    terminate(child);
  };
  const pushActivity = (item: SpawnActivity) => {
    activity.push(item);
    if (activity.length > 100) activity.shift();
    try { options.onActivity?.(item, activity); } catch { /* Progress observers must not control the child. */ }
  };
  const processLine = (line: string) => {
    if (!line.trim()) return;
    let event: any;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === "response") {
      if (event.command === "prompt" && event.success === false)
        stopWithCommandError(`Spawn RPC prompt command failed${event.error ? `: ${event.error}` : ""}`);
      return;
    }
    if (event.type === "agent_settled") {
      settled = true;
      terminate(child);
      return;
    }
    if (event.type === "tool_execution_start") {
      pushActivity({ kind: "call", tool: event.toolName, text: JSON.stringify(event.args ?? {}) });
      return;
    }
    if (event.type === "tool_execution_end") {
      const text = textContent(event.result);
      const bounded = truncateHead(text, { maxBytes: 2000, maxLines: 40 }).content;
      pushActivity({ kind: "result", tool: event.toolName, text: bounded, ...(event.isError ? { isError: true } : {}) });
      return;
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const message = event.message;
      const item = message.usage ?? {};
      messages.push(message);
      usage.input += validNumber(item.input);
      usage.output += validNumber(item.output);
      usage.cacheRead += validNumber(item.cacheRead);
      usage.cacheWrite += validNumber(item.cacheWrite);
      usage.cost += validNumber(item.cost?.total);
      try { options.onUsage?.({ ...usage }); } catch { /* Progress observers must not control the child. */ }
    }
  };

  child.stdout!.on("data", (chunk) => {
    stdout += chunk.toString();
    if (Buffer.byteLength(stdout) > 1024 * 1024) {
      protocolOverflow = true;
      stdout = "";
      terminate(child);
      return;
    }
    const lines = stdout.split("\n");
    stdout = lines.pop() ?? "";
    for (const line of lines) processLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  });
  child.stderr!.on("data", (chunk) => {
    stderr += chunk.toString();
    if (Buffer.byteLength(stderr) > 8192) stderr = Buffer.from(stderr).subarray(-8192).toString("utf8");
  });
  child.stdin!.on("error", (error) => {
    if (!settled && !timedOut && !aborted) stopWithCommandError(`Spawn RPC write failed: ${error.message}`);
  });
  const abort = () => { aborted = true; terminate(child); };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timeout = setTimeout(() => { timedOut = true; terminate(child); }, options.timeoutMs ?? spawnTimeoutMs());

  if (!aborted) {
    const command = { id: `spawn-${++commandId}`, type: "prompt", message: options.prompt };
    child.stdin!.write(`${JSON.stringify(command)}\n`);
  }
  const exitCode = await new Promise<number>((resolveExit) => {
    child.once("error", () => resolveExit(1));
    child.once("close", (code) => resolveExit(code ?? 1));
  });
  clearTimeout(timeout);
  options.signal?.removeEventListener("abort", abort);
  if (stdout.trim()) processLine(stdout.endsWith("\r") ? stdout.slice(0, -1) : stdout);

  const final = messages.at(-1);
  const rawText = textContent(final);
  const capped = truncateHead(rawText, { maxBytes: 50 * 1024, maxLines: 2000 });
  const error = protocolOverflow ? "Spawn protocol output exceeded 1 MiB."
    : aborted ? "Spawned thread turn was aborted."
    : timedOut ? "Spawned thread turn timed out."
    : commandError || (!settled ? `Spawned thread exited before settlement${exitCode ? ` (code ${exitCode})` : ""}.` : "")
      || (final?.stopReason === "error" ? final.errorMessage || "Spawned thread model error." : "")
      || (!rawText ? "Spawned thread returned no assistant text." : "");
  return {
    text: capped.content,
    model: final?.model,
    stopReason: final?.stopReason,
    ...(error ? { error } : {}),
    stderr,
    durationMs: Date.now() - started,
    usage,
    turns: messages.length,
    truncated: capped.truncated,
    activity,
  };
}
