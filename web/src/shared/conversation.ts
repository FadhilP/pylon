import type { MessageReadModel } from "./protocol/events.ts";

export type ConversationBlock = MessageReadModel | { id: string; tools: MessageReadModel[] };

export function groupConversationMessages(messages: MessageReadModel[], streaming: boolean): ConversationBlock[] {
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
  flush(streaming);
  return blocks;
}
