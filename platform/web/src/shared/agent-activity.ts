import type { DelegatedAgentActivityReadModel } from "./protocol/events.js";

export type PairedAgentActivity = {
  id?: string;
  tool: string;
  input?: string;
  output?: string;
  completed?: boolean;
  failed?: boolean;
  startedAt?: string;
  durationMs?: number;
};

export function pairAgentActivity(
  activity: DelegatedAgentActivityReadModel[],
): PairedAgentActivity[] {
  const tools: PairedAgentActivity[] = [];
  for (const item of activity) {
    if (item.kind === "call") {
      tools.push({
        ...(item.id ? { id: item.id } : {}),
        tool: item.tool,
        input: item.text,
        ...(item.startedAt ? { startedAt: item.startedAt } : {}),
      });
      continue;
    }
    const target = item.id
      ? [...tools]
          .reverse()
          .find((tool) => tool.id === item.id && tool.output === undefined)
      : [...tools]
          .reverse()
          .find(
            (tool) =>
              !tool.id && tool.tool === item.tool && tool.output === undefined,
          );
    if (target) {
      target.output = item.text;
      target.completed = true;
      target.failed = item.isError;
      if (item.startedAt) target.startedAt = item.startedAt;
      if (item.durationMs !== undefined) target.durationMs = item.durationMs;
    } else {
      tools.push({
        ...(item.id ? { id: item.id } : {}),
        tool: item.tool,
        output: item.text,
        completed: true,
        failed: item.isError,
        ...(item.startedAt ? { startedAt: item.startedAt } : {}),
        ...(item.durationMs === undefined
          ? {}
          : { durationMs: item.durationMs }),
      });
    }
  }
  return tools;
}

export type AgentToolStatus = "running" | "completed" | "failed";

export function pairedAgentToolStatus(
  tool: PairedAgentActivity,
  runRunning: boolean,
): AgentToolStatus {
  if (tool.failed) return "failed";
  return tool.completed || !runRunning ? "completed" : "running";
}

export function pairedAgentToolDuration(
  tool: PairedAgentActivity,
  runRunning: boolean,
  now = Date.now(),
): number | undefined {
  if (pairedAgentToolStatus(tool, runRunning) !== "running")
    return tool.durationMs;
  const startedAt = tool.startedAt ? Date.parse(tool.startedAt) : Number.NaN;
  return Number.isNaN(startedAt)
    ? tool.durationMs
    : Math.max(0, now - startedAt);
}

export function aggregatePairedAgentTiming(
  tools: PairedAgentActivity[],
  runRunning: boolean,
  now = Date.now(),
): { durationMs: number; status: AgentToolStatus } | undefined {
  const running = tools.flatMap((tool) => {
    if (pairedAgentToolStatus(tool, runRunning) !== "running") return [];
    const durationMs = pairedAgentToolDuration(tool, runRunning, now);
    return durationMs === undefined
      ? []
      : [{ durationMs, status: "running" as const }];
  });
  if (running.length)
    return running.reduce((longest, item) =>
      item.durationMs > longest.durationMs ? item : longest,
    );
  for (let index = tools.length - 1; index >= 0; index--) {
    const tool = tools[index]!;
    const durationMs = pairedAgentToolDuration(tool, runRunning, now);
    if (durationMs !== undefined)
      return { durationMs, status: pairedAgentToolStatus(tool, runRunning) };
  }
  return undefined;
}
