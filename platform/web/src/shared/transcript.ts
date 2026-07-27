import type { MessageReadModel } from "./protocol/events.ts";

export type ConversationBlock = MessageReadModel | { id: string; tools: MessageReadModel[] };

export function groupConversationMessages(messages: MessageReadModel[], activeTurn: boolean): ConversationBlock[] {
  const blocks: ConversationBlock[] = [];
  let turn: MessageReadModel[] = [];

  const flush = (current: boolean) => {
    if (!turn.length) return;
    const tools = turn.filter((message) => message.role === "tool");
    let grouped = false;

    for (const message of turn) {
      if (message.role !== "tool" || current) {
        blocks.push(message);
      } else if (!grouped) {
        blocks.push({ id: `tools-${tools[0]!.id}`, tools });
        grouped = true;
      }
    }
    turn = [];
  };

  for (const message of messages) {
    if (message.role === "user" && turn.length) flush(false);
    turn.push(message);
  }
  flush(activeTurn);
  return blocks;
}

export function latestTimedAssistant(messages: MessageReadModel[]): MessageReadModel | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "user") return;
    if (message.role === "assistant" && message.workDurationMs !== undefined) return message;
  }
  return undefined;
}

export function activeTurnAtMarker(turns: Array<{ id: string; top: number }>, marker: number): string {
  let active = turns[0]?.id ?? "";
  for (const turn of turns) {
    if (turn.top > marker) break;
    active = turn.id;
  }
  return active;
}
