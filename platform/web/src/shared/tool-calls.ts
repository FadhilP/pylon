import type { MessageReadModel } from "./protocol/events.ts";
import { pairedAgentToolDuration, pairedAgentToolStatus, type PairedAgentActivity } from "./agent-activity.ts";
import { toolElapsedDuration } from "./transcript.ts";

export type ToolCallStatus = "running" | "completed" | "failed" | "attention";

/** One tool call as the UI shows it, whoever ran it. Durations are already
    elapsed-resolved, so a running call needs no clock to render. */
export type ToolCallView = {
  key: string;
  name: string;
  input?: string;
  output?: string;
  status: ToolCallStatus;
  durationMs?: number;
};

export type ToolCallTrackTick = {
  key: string;
  status: ToolCallStatus;
  height: number;
};

const TRACK_FLOOR = 3;
const TRACK_FULL = 14;
const TRACK_ERROR_FLOOR = 9;
const TRACK_UNIT_MS = 200;

/** Relative log-scaled activity ticks. A limit keeps only the newest calls. */
export function toolCallTrackTicks(calls: ToolCallView[], limit?: number): ToolCallTrackTick[] {
  const visible = limit === undefined ? calls : limit <= 0 ? [] : calls.slice(-Math.floor(limit));
  const slowest = Math.max(TRACK_UNIT_MS, ...visible.map(call => Math.max(0, call.durationMs ?? 0)));
  const ceiling = Math.log1p(slowest / TRACK_UNIT_MS);
  return visible.map(call => {
    const duration = Math.max(0, call.durationMs ?? 0);
    const scaled = TRACK_FLOOR + (Math.log1p(duration / TRACK_UNIT_MS) / ceiling) * (TRACK_FULL - TRACK_FLOOR);
    return {
      key: call.key,
      status: call.status,
      height: call.status === "failed" ? Math.max(TRACK_ERROR_FLOOR, scaled) : scaled,
    };
  });
}

/** Transcript adapter: tool messages carry their activity inline. */
export function messageToolCallViews(messages: MessageReadModel[], now = Date.now()): ToolCallView[] {
  return messages.map(message => ({
    key: message.tool?.id ?? message.id,
    name: message.tool?.name || "Tool",
    input: message.tool?.input,
    output: message.text,
    status: message.tool?.status ?? "completed",
    durationMs: toolElapsedDuration(message, now),
  }));
}

/** Delegated-agent adapter: calls and results are paired first by
    pairAgentActivity, and a call only counts as running while its run is. */
export function pairedToolCallViews(
  tools: PairedAgentActivity[],
  runRunning: boolean,
  now = Date.now(),
): ToolCallView[] {
  return tools.map((tool, index) => ({
    key: tool.id ?? `${tool.tool}-${index}`,
    name: tool.tool,
    input: tool.input,
    output: tool.output,
    status: pairedAgentToolStatus(tool, runRunning),
    durationMs: pairedAgentToolDuration(tool, runRunning, now),
  }));
}

/** The last few distinct tool names, oldest first — the group's subtitle. */
export function toolCallNames(calls: ToolCallView[], limit = 3): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (let index = calls.length - 1; index >= 0 && names.length < Math.max(0, limit); index--) {
    const name = calls[index]!.name;
    if (seen.has(name)) continue;
    seen.add(name);
    names.unshift(name);
  }
  return names;
}

/** The duration worth showing on the group: the longest call still running,
    otherwise the most recent one that settled. */
export function aggregateToolCallTiming(
  calls: ToolCallView[],
): { durationMs: number; status: ToolCallStatus } | undefined {
  const running = calls.flatMap(call =>
    call.status === "running" && call.durationMs !== undefined
      ? [{ durationMs: call.durationMs, status: "running" as const }]
      : [],
  );
  if (running.length) return running.reduce((longest, item) => (item.durationMs > longest.durationMs ? item : longest));
  for (let index = calls.length - 1; index >= 0; index--) {
    const call = calls[index]!;
    if (call.status !== "running" && call.durationMs !== undefined) {
      return { durationMs: call.durationMs, status: call.status };
    }
  }
  return undefined;
}

/** A non-success only reaches the group orb when it is the outcome: the latest
    call carries it. A problem the agent recovered from mid-run stays on its row. */
export function toolCallGroupStatus(calls: ToolCallView[], running = false): ToolCallStatus {
  if (running) return "running";
  const status = calls.at(-1)?.status;
  return status === "failed" || status === "attention" ? status : "completed";
}
