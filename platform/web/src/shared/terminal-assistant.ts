import type { MessageReadModel } from "./protocol/events.ts";

export function finalAssistant(value: unknown): MessageReadModel | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (item.role !== "assistant" || typeof item.id !== "string" || !item.id || typeof item.text !== "string") return undefined;
  const message = { ...item, id: item.id.slice(0, 128), role: "assistant", text: item.text.slice(0, 60 * 1024), streaming: false } as MessageReadModel;
  if (typeof item.entryId === "string") message.entryId = item.entryId.slice(0, 128);
  else delete message.entryId;
  return message;
}

export function reconcileFinalAssistant(messages: MessageReadModel[], assistant: MessageReadModel | undefined): MessageReadModel[] {
  if (!assistant) return messages;
  const matches = (message: MessageReadModel) => message.id === assistant.id
    || Boolean(assistant.entryId && message.entryId === assistant.entryId);
  const current = messages.find(matches);
  const reconciled = { ...assistant, id: current?.id ?? assistant.id, streaming: false };
  let inserted = false;
  const next = messages.flatMap((message) => {
    if (!matches(message)) return [message];
    if (inserted) return [];
    inserted = true;
    return [reconciled];
  });
  return inserted ? next : [...next, reconciled];
}
