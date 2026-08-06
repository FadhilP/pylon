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
  id?: string;
  kind: "call" | "result";
  tool: string;
  text: string;
  isError?: boolean;
};

export type SpawnRun = {
  text: string;
  model?: string;
  thinking?: string;
  stopReason?: string;
  error?: string;
  stderr: string;
  durationMs: number;
  usage: SpawnUsage;
  sessionUsage?: SpawnUsage;
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
  onState?: (state: { model?: string; thinking?: string }) => void;
};

const emptyUsage = (): SpawnUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
const validNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
};
const sessionUsage = (value: unknown): SpawnUsage | undefined => {
  const stats = value && typeof value === "object" ? value as Record<string, any> : {};
  const tokens = stats.tokens && typeof stats.tokens === "object" ? stats.tokens as Record<string, unknown> : {};
  const values = [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite, stats.cost];
  if (!values.every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0)) return;
  return { input: tokens.input as number, output: tokens.output as number, cacheRead: tokens.cacheRead as number, cacheWrite: tokens.cacheWrite as number, cost: stats.cost as number };
};
const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const sessionState = (value: unknown): { model?: string; thinking?: string } | undefined => {
  const state = value && typeof value === "object" ? value as Record<string, any> : {};
  const model = state.model && typeof state.model === "object" ? state.model as Record<string, unknown> : {};
  const modelRef = typeof model.provider === "string" && typeof model.id === "string"
    ? `${model.provider}/${model.id}`
    : undefined;
  const thinking = thinkingLevels.has(String(state.thinkingLevel)) ? String(state.thinkingLevel) : undefined;
  return modelRef || thinking ? { ...(modelRef ? { model: modelRef } : {}), ...(thinking ? { thinking } : {}) } : undefined;
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
  let cumulativeUsage: SpawnUsage | undefined;
  let effectiveState: { model?: string; thinking?: string } | undefined;
  let stdout = "", stderr = "", commandError = "", timedOut = false, aborted = false;
  let settled = false, settlementFinished = false, commandId = 0;
  let initialStateCommandId: string | undefined;
  let finalStateCommandId: string | undefined;
  let statsCommandId: string | undefined;
  const settlementCommands = new Set<string>();
  let timeout: NodeJS.Timeout, settlementTimer: NodeJS.Timeout | undefined;

  const finishSettled = () => {
    if (settlementFinished) return;
    settlementFinished = true;
    if (settlementTimer) clearTimeout(settlementTimer);
    settlementTimer = undefined;
    terminate(child);
  };
  const completeSettlementCommand = (id: string) => {
    settlementCommands.delete(id);
    if (!settlementCommands.size) finishSettled();
  };
  const stopWithCommandError = (message: string) => {
    if (commandError) return;
    commandError = message;
    terminate(child);
  };
  const pushActivity = (item: SpawnActivity) => {
    activity.push(item);
    try { options.onActivity?.(item, activity); } catch { /* Progress observers must not control the child. */ }
  };
  const processLine = (line: string) => {
    if (!line.trim()) return;
    let event: any;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === "response") {
      if (event.command === "prompt" && event.success === false)
        stopWithCommandError(`Spawn RPC prompt command failed${event.error ? `: ${event.error}` : ""}`);
      if (event.command === "get_state" && (event.id === initialStateCommandId || event.id === finalStateCommandId)) {
        if (event.success === true) {
          const state = sessionState(event.data);
          if (state) {
            effectiveState = { ...effectiveState, ...state };
            try { options.onState?.({ ...effectiveState }); } catch { /* Progress observers must not control the child. */ }
          }
        }
        if (event.id === finalStateCommandId) completeSettlementCommand(event.id);
      }
      if (event.command === "get_session_stats" && event.id === statsCommandId) {
        if (event.success === true) cumulativeUsage = sessionUsage(event.data);
        completeSettlementCommand(event.id);
      }
      return;
    }
    if (event.type === "agent_settled") {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      finalStateCommandId = `spawn-${++commandId}`;
      statsCommandId = `spawn-${++commandId}`;
      settlementCommands.add(finalStateCommandId);
      settlementCommands.add(statsCommandId);
      settlementTimer = setTimeout(finishSettled, 1_000);
      settlementTimer.unref();
      for (const command of [
        { id: finalStateCommandId, type: "get_state" },
        { id: statsCommandId, type: "get_session_stats" },
      ]) {
        try {
          child.stdin!.write(`${JSON.stringify(command)}\n`, (error) => {
            if (error) completeSettlementCommand(command.id);
          });
        } catch { completeSettlementCommand(command.id); }
      }
      return;
    }
    if (event.type === "tool_execution_start") {
      const text = truncateHead(JSON.stringify(event.args ?? {}), { maxBytes: 2000, maxLines: 40 }).content;
      pushActivity({ ...(typeof event.toolCallId === "string" ? { id: event.toolCallId } : {}), kind: "call", tool: event.toolName, text });
      return;
    }
    if (event.type === "tool_execution_end") {
      const text = textContent(event.result);
      const bounded = truncateHead(text, { maxBytes: 2000, maxLines: 40 }).content;
      pushActivity({ ...(typeof event.toolCallId === "string" ? { id: event.toolCallId } : {}), kind: "result", tool: event.toolName, text: bounded, ...(event.isError ? { isError: true } : {}) });
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
  const abort = () => {
    if (settled) { finishSettled(); return; }
    aborted = true;
    terminate(child);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  timeout = setTimeout(() => { timedOut = true; terminate(child); }, options.timeoutMs ?? spawnTimeoutMs());

  if (!aborted) {
    initialStateCommandId = `spawn-${++commandId}`;
    const promptCommand = { id: `spawn-${++commandId}`, type: "prompt", message: options.prompt };
    child.stdin!.write(`${JSON.stringify({ id: initialStateCommandId, type: "get_state" })}\n`);
    child.stdin!.write(`${JSON.stringify(promptCommand)}\n`);
  }
  const exitCode = await new Promise<number>((resolveExit) => {
    child.once("error", () => resolveExit(1));
    child.once("close", (code) => resolveExit(code ?? 1));
  });
  clearTimeout(timeout);
  if (settlementTimer) clearTimeout(settlementTimer);
  options.signal?.removeEventListener("abort", abort);
  if (stdout.trim()) processLine(stdout.endsWith("\r") ? stdout.slice(0, -1) : stdout);

  const final = messages.at(-1);
  const rawText = textContent(final);
  const capped = truncateHead(rawText, { maxBytes: 50 * 1024, maxLines: 2000 });
  const error = aborted ? "Spawned thread turn was aborted."
    : timedOut ? "Spawned thread turn timed out."
    : commandError || (!settled ? `Spawned thread exited before settlement${exitCode ? ` (code ${exitCode})` : ""}.` : "")
      || (final?.stopReason === "error" ? final.errorMessage || "Spawned thread model error." : "")
      || (!rawText ? "Spawned thread returned no assistant text." : "");
  return {
    text: capped.content,
    model: effectiveState?.model ?? final?.model,
    ...(effectiveState?.thinking ? { thinking: effectiveState.thinking } : {}),
    stopReason: final?.stopReason,
    ...(error ? { error } : {}),
    stderr,
    durationMs: Date.now() - started,
    usage,
    ...(cumulativeUsage ? { sessionUsage: cumulativeUsage } : {}),
    turns: messages.length,
    truncated: capped.truncated,
    activity,
  };
}
