import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { getPackageDir, truncateHead } from "@earendil-works/pi-coding-agent";
import { contextWindowTokensFromUsage } from "pylon-core/child-process";
import { createSettlement } from "./settlement.ts";
import { boundedString, deniedUiResponse, dialogMethods, parseUiRequest, validUiResponse } from "./ui-request.ts";

export type SpawnUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };

export type SpawnActivity = {
  id?: string;
  kind: "call" | "result";
  tool: string;
  text: string;
  isError?: boolean;
  startedAt?: string;
  durationMs?: number;
};

export type SpawnUiRequest =
  | { id: string; method: "select"; title: string; options: string[]; timeout?: number }
  | { id: string; method: "confirm"; title: string; message: string; timeout?: number }
  | { id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
  | { id: string; method: "editor"; title: string; prefill?: string; timeout?: number };

export type SpawnUiResponse = { value: string } | { confirmed: boolean } | { cancelled: true };

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
  contextTokens?: number | null;
  contextLimit?: number;
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
  onContext?: (tokens: number | null) => void;
  onText?: (text: string) => void;
  onState?: (state: { model?: string; thinking?: string; contextLimit?: number }) => void;
  onUiRequest?: (request: SpawnUiRequest, signal: AbortSignal) => Promise<SpawnUiResponse>;
};

const emptyUsage = (): SpawnUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
const TEXT_LIMITS = { maxBytes: 50 * 1024, maxLines: 2000 };
const ACTIVITY_LIMITS = { maxBytes: 2000, maxLines: 40 };
const activityInput = (value: unknown): string => {
  try {
    return truncateHead(JSON.stringify(value ?? {}), ACTIVITY_LIMITS).content;
  } catch {
    return "{}";
  }
};

const validNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
};
const sessionUsage = (value: unknown): SpawnUsage | undefined => {
  const stats = value && typeof value === "object" ? (value as Record<string, any>) : {};
  const tokens = stats.tokens && typeof stats.tokens === "object" ? (stats.tokens as Record<string, unknown>) : {};
  const values = [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite, stats.cost];
  if (!values.every(item => typeof item === "number" && Number.isFinite(item) && item >= 0)) return;
  return {
    input: tokens.input as number,
    output: tokens.output as number,
    cacheRead: tokens.cacheRead as number,
    cacheWrite: tokens.cacheWrite as number,
    cost: stats.cost as number,
  };
};
const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const sessionState = (value: unknown): { model?: string; thinking?: string; contextLimit?: number } | undefined => {
  const state = value && typeof value === "object" ? (value as Record<string, any>) : {};
  const model = state.model && typeof state.model === "object" ? (state.model as Record<string, unknown>) : {};
  const modelRef =
    typeof model.provider === "string" && typeof model.id === "string" ? `${model.provider}/${model.id}` : undefined;
  const thinking = thinkingLevels.has(String(state.thinkingLevel)) ? String(state.thinkingLevel) : undefined;
  const rawContextLimit = Number(model.contextWindow);
  const contextLimit = Number.isSafeInteger(rawContextLimit) && rawContextLimit > 0 ? rawContextLimit : undefined;
  return modelRef || thinking || contextLimit
    ? {
        ...(modelRef ? { model: modelRef } : {}),
        ...(thinking ? { thinking } : {}),
        ...(contextLimit ? { contextLimit } : {}),
      }
    : undefined;
};

export function spawnTimeoutMs(value = process.env.PI_SPAWN_TIMEOUT_MS): number | undefined {
  if (value === undefined) return;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 7_200_000)
    throw new Error("PI_SPAWN_TIMEOUT_MS must be an integer between 1 and 7200000");
  return timeout;
}

export function getPiInvocation(args: string[]): Invocation {
  const packageDir = getPackageDir();
  const cli = join(packageDir, "dist", "cli.js");
  const script = process.argv[1];
  const piEntrypoints = [cli, join(packageDir, "src", "cli.ts"), join(packageDir, "src", "cli-new.ts")].map(path =>
    resolve(path),
  );
  if (script && !script.startsWith("/$bunfs/root/") && existsSync(script) && piEntrypoints.includes(resolve(script)))
    return { command: process.execPath, args: [script, ...args] };
  if (!/^(node|bun)(\.exe)?$/i.test(basename(process.execPath))) return { command: process.execPath, args };
  return { command: process.execPath, args: [cli, ...args] };
}

function terminate(child: ChildProcess): void {
  if (child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { shell: false, stdio: "ignore" });
    return;
  }
  if (!child.pid) return;
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

const textContent = (message: any): string =>
  (message?.content ?? [])
    .filter((part: any) => part.type === "text")
    .map((part: any) => part.text)
    .join("\n");

/** Progress observers report to the host UI and must never control the child's lifecycle. */
const observer =
  <T>(callback: ((value: T) => void) | undefined) =>
  (value: T) => {
    try {
      callback?.(value);
    } catch {
      /* ignored */
    }
  };

/** Splits a stream into complete lines, returning the trailing partial line for the next chunk. */
function lineSplitter(onLine: (line: string) => void) {
  let buffer = "";
  return {
    push(chunk: string) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    },
    flush() {
      if (!buffer.trim()) return;
      onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
      buffer = "";
    },
  };
}

type RunState = {
  messages: any[];
  activity: SpawnActivity[];
  usage: SpawnUsage;
  cumulativeUsage?: SpawnUsage;
  contextTokens: number | null;
  effectiveState?: { model?: string; thinking?: string; contextLimit?: number };
  streamedText: string;
  stderr: string;
  commandError: string;
  timedOut: boolean;
  aborted: boolean;
  settled: boolean;
  exitCode: number;
  startedAt: number;
};

/** Turns the accumulated stream state into the run result, including the first applicable error. */
function buildRun(state: RunState): SpawnRun {
  const final = state.messages.at(-1);
  const rawText = textContent(final);
  const capped = truncateHead(rawText, TEXT_LIMITS);
  const error = state.aborted
    ? "Spawned thread turn was aborted."
    : state.timedOut
      ? "Spawned thread turn timed out."
      : state.commandError ||
        (!state.settled
          ? `Spawned thread exited before settlement${state.exitCode ? ` (code ${state.exitCode})` : ""}.`
          : "") ||
        (final?.stopReason === "error" ? final.errorMessage || "Spawned thread model error." : "") ||
        (!rawText ? "Spawned thread returned no assistant text." : "");
  return {
    text: capped.content,
    model: state.effectiveState?.model ?? final?.model,
    ...(state.effectiveState?.thinking ? { thinking: state.effectiveState.thinking } : {}),
    stopReason: final?.stopReason,
    ...(error ? { error } : {}),
    stderr: state.stderr,
    durationMs: Date.now() - state.startedAt,
    usage: state.usage,
    ...(state.cumulativeUsage ? { sessionUsage: state.cumulativeUsage } : {}),
    contextTokens: state.contextTokens,
    ...(state.effectiveState?.contextLimit ? { contextLimit: state.effectiveState.contextLimit } : {}),
    turns: state.messages.length,
    truncated: capped.truncated,
    activity: state.activity,
  };
}

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
  const activityStarts = new Map<string, { startedAt: string; startedAtMs: number }>();
  const assistantToolInputs = new Map<string, string>();
  const activityCallIds = new Set<string>();
  const usage = emptyUsage();
  let cumulativeUsage: SpawnUsage | undefined;
  let contextTokens: number | null = null;
  let effectiveState: { model?: string; thinking?: string; contextLimit?: number } | undefined;
  let stderr = "",
    commandError = "",
    timedOut = false,
    aborted = false;
  let streamedText = "";
  let commandId = 0;
  let initialStateCommandId: string | undefined;
  let timeout: NodeJS.Timeout | undefined;
  const handledUiRequestIds = new Set<string>();
  const uiLifecycle = new AbortController();

  const emitActivity = observer(options.onActivity && ((item: SpawnActivity) => options.onActivity!(item, activity)));
  const emitUsage = observer(options.onUsage);
  const emitText = observer(options.onText);
  const emitState = observer(options.onState);
  const emitContext = observer(options.onContext);

  const settlement = createSettlement({
    child,
    nextCommandId: () => `spawn-${++commandId}`,
    onBegin: () => {
      uiLifecycle.abort();
      if (timeout) clearTimeout(timeout);
    },
    onFinish: () => {
      uiLifecycle.abort();
      terminate(child);
    },
  });

  const stopWithCommandError = (message: string) => {
    if (commandError) return;
    commandError = message;
    uiLifecycle.abort();
    terminate(child);
  };
  const writeUiResponse = (id: string, response: SpawnUiResponse) => {
    if (uiLifecycle.signal.aborted || child.stdin?.destroyed || !child.stdin?.writable) return;
    try {
      child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, ...response })}\n`, error => {
        if (error && !uiLifecycle.signal.aborted)
          stopWithCommandError(`Spawn RPC UI response failed: ${error.message}`);
      });
    } catch (error) {
      if (!uiLifecycle.signal.aborted)
        stopWithCommandError(`Spawn RPC UI response failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const handleUiRequest = (event: any) => {
    const method = String(event?.method ?? "");
    const id = boundedString(event?.id, 128);
    if (!id || !dialogMethods.has(method) || handledUiRequestIds.has(id)) return;
    handledUiRequestIds.add(id);
    const request = parseUiRequest(event);
    if (!request || !options.onUiRequest) {
      writeUiResponse(id, deniedUiResponse(method));
      return;
    }
    void Promise.resolve()
      .then(() => options.onUiRequest!(request, uiLifecycle.signal))
      .then(response => {
        if (!uiLifecycle.signal.aborted) writeUiResponse(id, validUiResponse(request, response));
      })
      .catch(() => {
        if (!uiLifecycle.signal.aborted) writeUiResponse(id, deniedUiResponse(method));
      });
  };
  const pushActivity = (item: SpawnActivity) => {
    activity.push(item);
    emitActivity(item);
  };
  const setStreamedText = (text: string) => {
    streamedText = truncateHead(text, TEXT_LIMITS).content;
    emitText(streamedText);
  };

  const handlers: Record<string, (event: any) => void> = {
    extension_ui_request: handleUiRequest,

    response: event => {
      if (event.command === "prompt" && event.success === false)
        stopWithCommandError(`Spawn RPC prompt command failed${event.error ? `: ${event.error}` : ""}`);
      if (
        event.command === "get_state" &&
        (event.id === initialStateCommandId || event.id === settlement.finalStateCommandId)
      ) {
        if (event.success === true) {
          const state = sessionState(event.data);
          if (state) {
            effectiveState = { ...effectiveState, ...state };
            emitState({ ...effectiveState });
          }
        }
        if (event.id === settlement.finalStateCommandId) settlement.completeCommand(event.id);
      }
      if (event.command === "get_session_stats" && event.id === settlement.statsCommandId) {
        if (event.success === true) cumulativeUsage = sessionUsage(event.data);
        settlement.completeCommand(event.id);
      }
    },

    compaction_start: () => {
      contextTokens = null;
      emitContext(null);
      settlement.compactionStarted();
    },
    compaction_end: event => settlement.compactionEnded(!!event.result || event.willRetry === true),
    agent_start: () => settlement.agentStarted(),
    agent_settled: () => settlement.agentSettled(),

    message_start: event => {
      if (event.message?.role !== "assistant") return;
      streamedText = "";
      emitText(streamedText);
    },

    message_update: event => {
      if (event.assistantMessageEvent?.type !== "text_delta" || typeof event.assistantMessageEvent.delta !== "string")
        return;
      setStreamedText(`${streamedText}${event.assistantMessageEvent.delta}`);
    },

    tool_execution_start: event => {
      const startedAtMs = Date.now();
      const startedAt = new Date(startedAtMs).toISOString();
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
      if (toolCallId) {
        activityStarts.set(toolCallId, { startedAt, startedAtMs });
        activityCallIds.add(toolCallId);
      }
      const input = Object.prototype.hasOwnProperty.call(event, "args")
        ? activityInput(event.args)
        : toolCallId
          ? (assistantToolInputs.get(toolCallId) ?? "{}")
          : "{}";
      if (toolCallId) assistantToolInputs.delete(toolCallId);
      pushActivity({
        ...(toolCallId ? { id: toolCallId } : {}),
        kind: "call",
        tool: event.toolName,
        text: input,
        startedAt,
      });
    },

    tool_execution_end: event => {
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
      const timing = toolCallId ? activityStarts.get(toolCallId) : undefined;
      if (toolCallId) activityStarts.delete(toolCallId);
      if (toolCallId && !activityCallIds.has(toolCallId)) {
        activityCallIds.add(toolCallId);
        pushActivity({
          id: toolCallId,
          kind: "call",
          tool: event.toolName,
          text: assistantToolInputs.get(toolCallId) ?? "{}",
        });
      }
      if (toolCallId) assistantToolInputs.delete(toolCallId);
      const durationMs = timing ? Math.max(0, Date.now() - timing.startedAtMs) : undefined;
      pushActivity({
        ...(toolCallId ? { id: toolCallId } : {}),
        kind: "result",
        tool: event.toolName,
        text: truncateHead(textContent(event.result), ACTIVITY_LIMITS).content,
        ...(event.isError ? { isError: true } : {}),
        ...(durationMs === undefined ? {} : { durationMs }),
      });
    },

    message_end: event => {
      if (event.message?.role !== "assistant") return;
      const message = event.message;
      const item = message.usage ?? {};
      messages.push(message);
      setStreamedText(textContent(message));
      if (Array.isArray(message.content))
        for (const part of message.content) {
          if (part?.type !== "toolCall" || typeof part.id !== "string") continue;
          const input = Object.prototype.hasOwnProperty.call(part, "arguments") ? part.arguments : part.args;
          assistantToolInputs.set(part.id, activityInput(input));
        }
      usage.input += validNumber(item.input);
      usage.output += validNumber(item.output);
      usage.cacheRead += validNumber(item.cacheRead);
      usage.cacheWrite += validNumber(item.cacheWrite);
      usage.cost += validNumber(item.cost?.total);
      if (message.stopReason !== "aborted" && message.stopReason !== "error") {
        const latestContextTokens = contextWindowTokensFromUsage(item);
        if (latestContextTokens > 0) {
          contextTokens = latestContextTokens;
          emitContext(contextTokens);
        }
      }
      emitUsage({ ...usage });
    },
  };

  const stdout = lineSplitter(line => {
    if (!line.trim()) return;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    handlers[event.type]?.(event);
  });

  child.stdout!.on("data", chunk => stdout.push(chunk.toString()));
  child.stderr!.on("data", chunk => {
    stderr += chunk.toString();
    if (Buffer.byteLength(stderr) > 8192) stderr = Buffer.from(stderr).subarray(-8192).toString("utf8");
  });
  child.stdin!.on("error", error => {
    if (!settlement.settled && !timedOut && !aborted) stopWithCommandError(`Spawn RPC write failed: ${error.message}`);
  });

  const abort = () => {
    uiLifecycle.abort();
    if (settlement.settled) {
      settlement.finish();
      return;
    }
    aborted = true;
    terminate(child);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timeoutMs = options.timeoutMs ?? spawnTimeoutMs();
  if (timeoutMs !== undefined)
    timeout = setTimeout(() => {
      timedOut = true;
      uiLifecycle.abort();
      terminate(child);
    }, timeoutMs);

  if (!aborted) {
    initialStateCommandId = `spawn-${++commandId}`;
    const promptCommand = { id: `spawn-${++commandId}`, type: "prompt", message: options.prompt };
    child.stdin!.write(`${JSON.stringify({ id: initialStateCommandId, type: "get_state" })}\n`);
    child.stdin!.write(`${JSON.stringify(promptCommand)}\n`);
  }

  const exitCode = await new Promise<number>(resolveExit => {
    child.once("error", () => {
      uiLifecycle.abort();
      resolveExit(1);
    });
    child.once("close", code => {
      uiLifecycle.abort();
      resolveExit(code ?? 1);
    });
  });
  if (timeout) clearTimeout(timeout);
  options.signal?.removeEventListener("abort", abort);
  stdout.flush();
  settlement.finish();

  return buildRun({
    messages,
    activity,
    usage,
    cumulativeUsage,
    contextTokens,
    effectiveState,
    streamedText,
    stderr,
    commandError,
    timedOut,
    aborted,
    settled: settlement.settled,
    exitCode,
    startedAt: started,
  });
}
