import type { ConversationReadModel, MessageReadModel } from "./protocol/events.ts";
import type { RuntimeSnapshot } from "./protocol/snapshots.ts";

export type CachedHistory = Pick<ConversationReadModel, "messages" | "historyCursor" | "historyRemaining">;

function historyIndex(message: MessageReadModel): number | undefined {
  const match = /^history-(\d+)$/.exec(message.id);
  const index = match ? Number(match[1]) : undefined;
  return Number.isSafeInteger(index) ? index : undefined;
}

function historyRange(messages: MessageReadModel[]): { start?: number; end?: number } {
  let start: number | undefined;
  let end: number | undefined;
  for (const message of messages) {
    const index = historyIndex(message);
    if (index === undefined) continue;
    start = start === undefined ? index : Math.min(start, index);
    end = end === undefined ? index : Math.max(end, index);
  }
  return { start, end };
}

export function mergeHistoryMessages(previous: MessageReadModel[], fresh: MessageReadModel[]): MessageReadModel[] {
  const order = new Map<string, number>();
  const messages = [...previous, ...fresh];
  messages.forEach((message, index) => {
    const key = message.entryId ? `entry:${message.entryId}` : `message:${message.id}`;
    if (!order.has(key)) order.set(key, index);
  });
  return [...new Map(messages.map((message) => [
    message.entryId ? `entry:${message.entryId}` : `message:${message.id}`,
    message,
  ])).values()]
    .sort((left, right) => {
      const leftIndex = historyIndex(left);
      const rightIndex = historyIndex(right);
      if (leftIndex !== undefined && rightIndex !== undefined) return leftIndex - rightIndex;
      if (leftIndex !== undefined) return -1;
      if (rightIndex !== undefined) return 1;
      const leftKey = left.entryId ? `entry:${left.entryId}` : `message:${left.id}`;
      const rightKey = right.entryId ? `entry:${right.entryId}` : `message:${right.id}`;
      return order.get(leftKey)! - order.get(rightKey)!;
    });
}

export function mergeHistorySegments(segments: MessageReadModel[][]): MessageReadModel[] {
  return segments.reduce<MessageReadModel[]>(mergeHistoryMessages, []);
}

export function hasCompleteHistory(messages: MessageReadModel[]): boolean {
  const indexes = new Set(messages.map(historyIndex).filter((value): value is number => value !== undefined));
  if (!indexes.has(0)) return false;
  let maximum = 0;
  for (const index of indexes) maximum = Math.max(maximum, index);
  return indexes.size === maximum + 1;
}

export function restoreCachedHistory(runtime: RuntimeSnapshot, cached?: CachedHistory): RuntimeSnapshot {
  if (!cached?.messages.length) return runtime;
  const cachedMessages = cached.messages.filter((message) => historyIndex(message) !== undefined);
  if (!cachedMessages.length) return runtime;
  const { start: freshStart, end: freshEnd } = historyRange(runtime.conversation.messages);
  const { end: cachedEnd } = historyRange(cachedMessages);
  if (freshEnd !== undefined && cachedEnd !== undefined && freshEnd < cachedEnd) return runtime;

  const merged = mergeHistoryMessages(cachedMessages, runtime.conversation.messages);
  const hasGap = freshStart !== undefined && cachedEnd !== undefined && cachedEnd + 1 < freshStart;
  const useCachedPaging = !hasGap && (cached.historyCursor !== undefined || hasCompleteHistory(merged));
  return {
    ...runtime,
    conversation: {
      ...runtime.conversation,
      messages: merged,
      historyCursor: useCachedPaging ? cached.historyCursor : runtime.conversation.historyCursor,
      historyRemaining: useCachedPaging ? cached.historyRemaining : runtime.conversation.historyRemaining,
    },
  };
}
