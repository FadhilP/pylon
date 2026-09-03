/**
 * Plumbing shared by every package that drives a `pi` child agent over NDJSON.
 *
 * This module owns only mechanism — locating the CLI, killing a process group,
 * framing lines, bounding buffers, tallying usage. Which events matter and what
 * counts as failure stays with each caller, because those policies genuinely differ.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

export type Invocation = { command: string; args: string[] };
export type CostParts = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type ChildUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  costParts: CostParts;
};
export type ChildActivity = {
  id?: string;
  kind: "call" | "result";
  tool: string;
  text: string;
  isError?: boolean;
  startedAt?: string;
  durationMs?: number;
};

/** Resolves how to re-invoke this same pi build as a child process. */
export function getPiInvocation(args: string[]): Invocation {
  const packageDir = getPackageDir();
  const cli = join(packageDir, "dist", "cli.js");
  const script = process.argv[1];
  const piEntrypoints = [
    cli,
    join(packageDir, "dist", "rpc-entry.js"),
    join(packageDir, "src", "cli.ts"),
    join(packageDir, "src", "cli-new.ts"),
    join(packageDir, "src", "rpc-entry.ts"),
  ].map(path => resolve(path));
  if (script && !script.startsWith("/$bunfs/root/") && existsSync(script) && piEntrypoints.includes(resolve(script)))
    return { command: process.execPath, args: [script, ...args] };
  if (!/^(node|bun)(\.exe)?$/i.test(basename(process.execPath))) return { command: process.execPath, args };
  return { command: process.execPath, args: [cli, ...args] };
}

/** Kills the child and its descendants, escalating to SIGKILL after a second. */
export function terminate(child: ChildProcess): void {
  if (child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid)
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { shell: false, stdio: "ignore" });
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

export const emptyUsage = (): ChildUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  costParts: emptyCostParts(),
});

/**
 * A provider bills a turn in four parts and reports them beside the total. A
 * delegate that keeps only the total leaves whoever reads its usage later
 * unable to say what the prompt cost against what the reply cost, so the parts
 * ride along with it — the total stays the number every budget is measured in.
 */
export const emptyCostParts = (): CostParts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/** Two tallies added: the parts add like the totals beside them. */
export const sumCostParts = (left: CostParts, right: CostParts): CostParts => ({
  input: left.input + right.input,
  output: left.output + right.output,
  cacheRead: left.cacheRead + right.cacheRead,
  cacheWrite: left.cacheWrite + right.cacheWrite,
});

/** A snapshot for an observer: the parts are copied, not shared with the tally. */
export const usageSnapshot = <T extends { costParts: CostParts }>(usage: T): T => ({
  ...usage,
  costParts: { ...usage.costParts },
});

export function addCostParts(total: CostParts, cost: unknown): void {
  const parts =
    cost && typeof cost === "object" && !Array.isArray(cost) ? (cost as Record<string, unknown>) : undefined;
  if (!parts) return;
  total.input += validCost(parts.input);
  total.output += validCost(parts.output);
  total.cacheRead += validCost(parts.cacheRead);
  total.cacheWrite += validCost(parts.cacheWrite);
}

/** Coerces a reported token count, treating anything non-finite or negative as zero. */
export const validTokens = (value: unknown): number => {
  const tokens = Number(value);
  return Number.isFinite(tokens) && tokens >= 0 ? tokens : 0;
};

export const validCost = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

export const cacheReadTokensFromUsage = (usage: any): number => validTokens(usage?.cacheRead);

/** Live context size: the provider's own total when present, otherwise the summed parts, less cache reads. */
export function contextTokensFromUsage(usage: any): number {
  const cacheRead = cacheReadTokensFromUsage(usage);
  const nativeTotal = Number(usage?.totalTokens);
  if (Number.isFinite(nativeTotal) && nativeTotal > 0) return Math.max(0, nativeTotal - cacheRead);
  const parts = [usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite].map(Number);
  if (!parts.every(value => Number.isFinite(value) && value >= 0)) return 0;
  return Math.max(0, parts.reduce((sum, value) => sum + value, 0) - cacheRead);
}

/** Context-window occupancy: provider total when available, otherwise every billed token component. */
export function contextWindowTokensFromUsage(usage: any): number {
  const nativeTotal = Number(usage?.totalTokens);
  if (Number.isFinite(nativeTotal) && nativeTotal > 0) return nativeTotal;
  const parts = [usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite].map(Number);
  if (!parts.every(value => Number.isFinite(value) && value >= 0)) return 0;
  return parts.reduce((sum, value) => sum + value, 0);
}

/** Records tool-call/result pairs, timing each call by its id. */
export function activityRecorder(
  capResultText: (text: string) => string,
  onActivity?: (activity: ChildActivity, all: readonly ChildActivity[]) => void,
) {
  const items: ChildActivity[] = [];
  const startedById = new Map<string, number>();
  const push = (item: ChildActivity) => {
    items.push(item);
    onActivity?.(item, items);
  };
  const idOf = (event: any) => (typeof event.toolCallId === "string" ? event.toolCallId : undefined);
  return {
    items,
    start(event: any) {
      const startedAtMs = Date.now();
      const id = idOf(event);
      if (id) startedById.set(id, startedAtMs);
      push({
        ...(id ? { id } : {}),
        kind: "call",
        tool: event.toolName,
        text: JSON.stringify(event.args ?? {}),
        startedAt: new Date(startedAtMs).toISOString(),
      });
    },
    end(event: any) {
      const raw = (event.result?.content ?? [])
        .filter((part: any) => part.type === "text")
        .map((part: any) => part.text)
        .join("\n");
      const id = idOf(event);
      const startedAtMs = id ? startedById.get(id) : undefined;
      if (id) startedById.delete(id);
      const durationMs = startedAtMs === undefined ? undefined : Math.max(0, Date.now() - startedAtMs);
      push({
        ...(id ? { id } : {}),
        kind: "result",
        tool: event.toolName,
        text: capResultText(raw),
        ...(event.isError ? { isError: true } : {}),
        ...(durationMs === undefined ? {} : { durationMs }),
      });
    },
  };
}

/**
 * Buffers a stdout stream into whole LF-delimited lines.
 * Exceeding `maxBytes` before a newline arrives calls `onOverflow` and drops the buffer,
 * so a child that never emits a newline cannot exhaust memory.
 */
export function lineBuffer(onLine: (line: string) => void, maxBytes: number, onOverflow: () => void) {
  let pending = "";
  return {
    push(chunk: unknown) {
      pending += chunk;
      if (Buffer.byteLength(pending) > maxBytes) {
        pending = "";
        onOverflow();
        return;
      }
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    },
    /** Feeds any trailing partial line once the stream has closed. */
    flush() {
      if (pending.trim()) onLine(pending);
      pending = "";
    },
  };
}

/** Keeps only the last `maxBytes` of a stderr stream. */
export function stderrTail(maxBytes = 8192) {
  let text = "";
  return {
    push(chunk: unknown) {
      text += chunk;
      if (Buffer.byteLength(text) > maxBytes) text = Buffer.from(text).subarray(-maxBytes).toString("utf8");
    },
    get text() {
      return text;
    },
  };
}
