import type { ConversationReadModel, MessageReadModel } from "../../shared/protocol/events.ts";
import type { RuntimeSnapshot } from "../../shared/protocol/snapshots.ts";

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

function historyMessageKey(message: MessageReadModel): string {
  if (message.tool?.id) return `tool:${message.tool.id}`;
  return message.entryId ? `entry:${message.entryId}` : `message:${message.id}`;
}

export function mergeHistoryMessages(previous: MessageReadModel[], fresh: MessageReadModel[]): MessageReadModel[] {
  const order = new Map<string, number>();
  const merged = new Map<string, MessageReadModel>();
  const messages = [...previous, ...fresh];
  messages.forEach((message, index) => {
    const key = historyMessageKey(message);
    if (!order.has(key)) order.set(key, index);
    const existing = merged.get(key);
    // Saved tool results retain their full output and transcript position over live summaries.
    if (existing?.tool && historyIndex(existing) !== undefined && historyIndex(message) === undefined) return;
    merged.set(key, message);
  });
  return [...merged.values()].sort((left, right) => {
    const leftIndex = historyIndex(left);
    const rightIndex = historyIndex(right);
    if (leftIndex !== undefined && rightIndex !== undefined) return leftIndex - rightIndex;
    if (leftIndex !== undefined) return -1;
    if (rightIndex !== undefined) return 1;
    return order.get(historyMessageKey(left))! - order.get(historyMessageKey(right))!;
  });
}

export function mergeHistorySegments(segments: MessageReadModel[][]): MessageReadModel[] {
  // Deduplicate and sort once; folding pages repeatedly reprocesses all earlier history.
  return mergeHistoryMessages([], segments.flat());
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
  const cachedMessages = cached.messages.filter(message => historyIndex(message) !== undefined);
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
