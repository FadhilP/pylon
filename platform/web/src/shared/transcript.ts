import type {
  ConversationReadModel,
  DelegatedAgentRunReadModel,
  MessageReadModel,
  ToolActivityReadModel,
} from "./protocol/events.ts";
import type { ConversationTurnIndexItem, ConversationTurnIndexPage } from "./protocol/snapshots.ts";

export type ConversationBlock = MessageReadModel | { id: string; tools: MessageReadModel[] };

export function groupConversationMessages(messages: MessageReadModel[]): ConversationBlock[] {
  const blocks: ConversationBlock[] = [];
  let tools: MessageReadModel[] = [];

  const flushTools = () => {
    if (!tools.length) return;
    blocks.push({ id: `tools-${tools[0]!.tool?.id ?? tools[0]!.id}`, tools });
    tools = [];
  };

  for (const message of messages) {
    if (message.role === "tool") {
      tools.push(message);
    } else {
      flushTools();
      blocks.push(message);
    }
  }
  flushTools();
  return blocks;
}

export function latestUniqueToolNames(tools: MessageReadModel[], limit = 3): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (let index = tools.length - 1; index >= 0 && names.length < Math.max(0, limit); index--) {
    const name = tools[index]!.tool?.name || "Tool";
    if (seen.has(name)) continue;
    seen.add(name);
    names.unshift(name);
  }
  return names;
}

export function toolElapsedDuration(tool: MessageReadModel, now = Date.now()): number | undefined {
  const activity = tool.tool;
  if (!activity) return undefined;
  if (activity.status !== "running") return activity.durationMs;
  const startedAt = activity.startedAt ? Date.parse(activity.startedAt) : Number.NaN;
  return Number.isNaN(startedAt) ? activity.durationMs : Math.max(0, now - startedAt);
}

export function aggregateToolTiming(
  tools: MessageReadModel[],
  now = Date.now(),
): { durationMs: number; status: "running" | "completed" | "failed" } | undefined {
  const running = tools.flatMap(tool => {
    if (tool.tool?.status !== "running") return [];
    const durationMs = toolElapsedDuration(tool, now);
    return durationMs === undefined ? [] : [{ durationMs, status: "running" as const }];
  });
  if (running.length) return running.reduce((longest, item) => (item.durationMs > longest.durationMs ? item : longest));
  for (let index = tools.length - 1; index >= 0; index--) {
    const tool = tools[index]!;
    const durationMs = toolElapsedDuration(tool, now);
    if (durationMs !== undefined && tool.tool?.status && tool.tool.status !== "running") {
      return { durationMs, status: tool.tool.status };
    }
  }
  return undefined;
}

export function terminalActivityStatus(
  kind: "end" | "error",
  info: { stopped?: boolean; willRetry?: boolean },
): "completed" | "failed" {
  if (info.stopped === true) return "completed";
  return kind === "error" || info.willRetry === true ? "failed" : "completed";
}

function settledTool<T extends { status: "running" | "completed" | "failed"; startedAt?: string; durationMs?: number }>(
  tool: T,
  status: "completed" | "failed",
): T {
  if (tool.status !== "running") return tool;
  const startedAt = tool.startedAt ? Date.parse(tool.startedAt) : Number.NaN;
  return {
    ...tool,
    status,
    ...(tool.durationMs === undefined && !Number.isNaN(startedAt)
      ? { durationMs: Math.max(0, Date.now() - startedAt) }
      : {}),
  };
}

export function settleRunningActivities(
  conversation: Pick<ConversationReadModel, "messages" | "tools" | "delegatedRuns">,
  status: "completed" | "failed",
): Pick<ConversationReadModel, "messages" | "tools" | "delegatedRuns"> {
  return {
    messages: conversation.messages.map(message =>
      message.tool?.status === "running"
        ? { ...message, streaming: false, tool: settledTool(message.tool, status) }
        : message,
    ),
    tools: conversation.tools.map(tool => settledTool(tool, status)),
    delegatedRuns: conversation.delegatedRuns.map(run => (run.status === "running" ? { ...run, status } : run)),
  };
}

export function liveToolMessage(tool: ToolActivityReadModel): MessageReadModel {
  return {
    id: `live-tool-${tool.id}`,
    role: "tool",
    text: tool.summary ?? "",
    streaming: tool.status === "running",
    tool: {
      id: tool.id,
      name: tool.name || "Tool",
      input: tool.input,
      status: tool.status,
      ...(tool.startedAt ? { startedAt: tool.startedAt } : {}),
      ...(tool.durationMs === undefined ? {} : { durationMs: tool.durationMs }),
    },
  };
}

export function reconcileToolActivity(message: MessageReadModel, activity: ToolActivityReadModel): MessageReadModel {
  if (!message.tool || message.tool.id !== activity.id) return message;
  const startedAt = activity.startedAt ?? message.tool.startedAt;
  const durationMs = activity.durationMs ?? message.tool.durationMs;
  return {
    ...message,
    text: activity.summary ?? message.text,
    streaming: activity.status === "running",
    tool: {
      ...message.tool,
      name: activity.name || message.tool.name,
      input: activity.input ?? message.tool.input,
      status: activity.status,
      ...(startedAt ? { startedAt } : {}),
      ...(durationMs === undefined ? {} : { durationMs }),
    },
  };
}

export function replaceConversationMessage(messages: MessageReadModel[], item: MessageReadModel): MessageReadModel[] {
  const matches = (message: MessageReadModel) =>
    message.id === item.id || Boolean(item.tool?.id && message.tool?.id === item.tool.id);
  const index = messages.findIndex(matches);
  if (index < 0) return [...messages, item];
  const existing = messages[index]!;
  const synthetic = item.tool && item.id === `live-tool-${item.tool.id}`;
  if (
    synthetic &&
    (existing.id !== item.id || (existing.tool?.status !== "running" && item.tool!.status === "running"))
  )
    return messages;
  return messages.flatMap((message, messageIndex) =>
    messageIndex === index ? [item] : matches(message) ? [] : [message],
  );
}

export function replaceToolActivity(
  tools: ToolActivityReadModel[],
  item: ToolActivityReadModel,
): ToolActivityReadModel[] {
  const index = tools.findIndex(tool => tool.id === item.id);
  if (index < 0) return [...tools, item].slice(-100);
  if (tools[index]!.status !== "running" && item.status === "running") return tools;
  const next = tools.slice();
  next[index] = item;
  return next;
}

export function replaceDelegatedRun(
  runs: DelegatedAgentRunReadModel[],
  item: DelegatedAgentRunReadModel,
): DelegatedAgentRunReadModel[] {
  const index = runs.findIndex(run => run.id === item.id);
  if (index < 0) return [...runs, item].slice(-100);
  const next = runs.slice();
  next[index] = item;
  return next;
}

export function includeLatestLoadedTurn(
  page: ConversationTurnIndexPage,
  turn: Omit<ConversationTurnIndexItem, "cursor"> | undefined,
  atLatest: boolean,
): ConversationTurnIndexPage {
  if (!turn || !atLatest || page.turns.some(item => item.promptId === turn.promptId)) return page;
  return {
    ...page,
    turns: [{ ...turn, cursor: `loaded:${turn.promptId}` }, ...page.turns],
    totalCount: Math.max(page.totalCount, page.turns.length + 1),
  };
}

export function activeTurnAtMarker(turns: Array<{ id: string; top: number }>, marker: number): string {
  let active = turns[0]?.id ?? "";
  for (const turn of turns) {
    if (turn.top > marker) break;
    active = turn.id;
  }
  return active;
}

export function turnIdsInViewport(
  turns: Array<{ id: string; top: number; bottom: number }>,
  viewport: { top: number; bottom: number },
): string[] {
  const visible = turns.filter(turn => turn.bottom > viewport.top && turn.top < viewport.bottom).map(turn => turn.id);
  if (visible.length) return visible;
  const active = activeTurnAtMarker(turns, viewport.bottom - 1);
  return active ? [active] : [];
}
