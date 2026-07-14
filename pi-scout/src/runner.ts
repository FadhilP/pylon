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
  stderr: string;
  durationMs: number;
  usage: ChildUsage;
  turns: ChildTurnUsage[];
  truncated: boolean;
  exitCode: number;
  activity: ScoutActivity[];
};
export type Invocation = { command: string; args: string[] };

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

export async function runPi(
  args: string[],
  options: {
    cwd: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    invocation?: Invocation;
    env?: NodeJS.ProcessEnv;
    inheritEnv?: boolean;
    onActivity?: (activity: ScoutActivity, all: readonly ScoutActivity[]) => void;
  },
): Promise<ScoutRun> {
  const started = Date.now();
  const invocation = options.invocation ?? getPiInvocation(args);
  const child = spawn(invocation.command, invocation.args, {
    cwd: options.cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
    env: options.inheritEnv === false ? options.env : options.env ? { ...process.env, ...options.env } : process.env,
  });
  const messages: any[] = [];
  const turns: ChildTurnUsage[] = [];
  const activity: ScoutActivity[] = [];
  let stdout = "",
    stderr = "",
    timedOut = false,
    aborted = false,
    protocolOverflow = false;
  const processLine = (line: string) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (event.type === "tool_execution_start") {
        const item: ScoutActivity = { kind: "call", tool: event.toolName, text: JSON.stringify(event.args ?? {}) };
        activity.push(item);
        if (activity.length > 100) activity.shift();
        options.onActivity?.(item, activity);
        return;
      }
      if (event.type === "tool_execution_end") {
        const text = (event.result?.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
        const item: ScoutActivity = { kind: "result", tool: event.toolName, text: capText(text, 2000, 40).text, ...(event.isError ? { isError: true } : {}) };
        activity.push(item);
        if (activity.length > 100) activity.shift();
        options.onActivity?.(item, activity);
        return;
      }
      if (event.type !== "message_end" || event.message?.role !== "assistant") return;
      const message = event.message;
      messages.push(message);
      const usage = message.usage ?? {};
      turns.push({
        input: usage.input ?? 0,
        output: usage.output ?? 0,
        cacheRead: usage.cacheRead ?? 0,
        cacheWrite: usage.cacheWrite ?? 0,
        cost: usage.cost?.total ?? 0,
        model: message.model,
        stopReason: message.stopReason,
      });
    } catch {
      /* malformed lines handled if no final response */
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
    if (Buffer.byteLength(stderr) > 8192)
      stderr = Buffer.from(stderr).subarray(-8192).toString("utf8");
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
  }, options.timeoutMs ?? 90_000);
  const exitCode = await new Promise<number>((resolve) => {
    child.once("error", () => resolve(1));
    child.once("close", (code) => resolve(code ?? 1));
  });
  clearTimeout(timeout);
  options.signal?.removeEventListener("abort", abort);
  if (stdout.trim()) processLine(stdout);
  const usage = turns.reduce(
    (sum, turn) => ({
      input: sum.input + turn.input,
      output: sum.output + turn.output,
      cacheRead: sum.cacheRead + turn.cacheRead,
      cacheWrite: sum.cacheWrite + turn.cacheWrite,
      cost: sum.cost + turn.cost,
    }),
    emptyUsage(),
  );
  const final = messages.at(-1);
  const rawText =
    final?.content
      ?.filter((part: any) => part.type === "text")
      .map((part: any) => part.text)
      .join("\n") ?? "";
  const capped = capText(rawText);
  const error = protocolOverflow
    ? "Scout protocol output exceeded 1 MiB."
    : aborted
      ? "Scout aborted."
      : timedOut
        ? "Scout timed out."
        : exitCode !== 0
          ? `Scout exited with code ${exitCode}.`
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
    stderr,
    durationMs: Date.now() - started,
    usage,
    turns,
    truncated: capped.truncated,
    exitCode,
    activity,
  };
}
