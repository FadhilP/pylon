import type { MessageReadModel, ToolActivityReadModel } from "./protocol/events.ts";
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

export function liveToolMessage(tool: ToolActivityReadModel): MessageReadModel {
  return {
    id: `live-tool-${tool.id}`,
    role: "tool",
    text: tool.summary ?? "",
    streaming: tool.status === "running",
    tool: { id: tool.id, name: tool.name || "Tool", input: tool.input, status: tool.status },
  };
}

export function replaceConversationMessage(messages: MessageReadModel[], item: MessageReadModel): MessageReadModel[] {
  const matches = (message: MessageReadModel) => message.id === item.id || Boolean(item.tool?.id && message.tool?.id === item.tool.id);
  const index = messages.findIndex(matches);
  if (index < 0) return [...messages, item];
  const existing = messages[index]!;
  const synthetic = item.tool && item.id === `live-tool-${item.tool.id}`;
  if (synthetic && (existing.id !== item.id || existing.tool?.status !== "running" && item.tool!.status === "running")) return messages;
  return messages.flatMap((message, messageIndex) => messageIndex === index ? [item] : matches(message) ? [] : [message]);
}

export function replaceToolActivity(tools: ToolActivityReadModel[], item: ToolActivityReadModel): ToolActivityReadModel[] {
  const index = tools.findIndex((tool) => tool.id === item.id);
  if (index < 0) return [...tools, item].slice(-100);
  if (tools[index]!.status !== "running" && item.status === "running") return tools;
  const next = tools.slice();
  next[index] = item;
  return next;
}

export function includeLatestLoadedTurn(
  page: ConversationTurnIndexPage,
  turn: Omit<ConversationTurnIndexItem, "cursor"> | undefined,
  atLatest: boolean,
): ConversationTurnIndexPage {
  if (!turn || !atLatest || page.turns.some((item) => item.promptId === turn.promptId)) return page;
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
  const visible = turns.filter((turn) => turn.bottom > viewport.top && turn.top < viewport.bottom).map((turn) => turn.id);
  if (visible.length) return visible;
  const active = activeTurnAtMarker(turns, viewport.bottom - 1);
  return active ? [active] : [];
}
