import type { QueuedPromptReadModel } from "./protocol/events.ts";

export interface PendingMessageReadModel {
  id: string;
  commandId: string;
  sessionId: string;
  sessionGeneration: number;
  text: string;
  attachmentCount: number;
  fileAttachmentCount: number;
  planMode: boolean;
  state: "queued" | "sending";
}

export function pendingMessageId(id: string): string {
  return `pending-${id}`.slice(0, 128);
}

export function reconcilePendingQueue(
  pending: PendingMessageReadModel[],
  previousQueue: QueuedPromptReadModel[],
  nextQueue: QueuedPromptReadModel[],
  sessionId: string,
  sessionGeneration: number,
): PendingMessageReadModel[] {
  const previousByCommand = new Map(previousQueue.map((item) => [item.commandId, item]));
  const nextByCommand = new Map(nextQueue.map((item) => [item.commandId, item]));
  const reconciled = pending.flatMap((item) => {
    if (item.sessionId !== sessionId || item.sessionGeneration !== sessionGeneration) return [item];
    const queued = nextByCommand.get(item.commandId);
    if (queued) return [{ ...item, state: queued.state === "queued" ? "queued" as const : "sending" as const }];
    if (previousByCommand.get(item.commandId)?.state === "queued") return [];
    return [item];
  });
  for (const queued of nextQueue) {
    if (reconciled.some((item) => item.commandId === queued.commandId)) continue;
    reconciled.push({
      id: pendingMessageId(queued.commandId),
      commandId: queued.commandId,
      sessionId,
      sessionGeneration,
      text: queued.preview,
      attachmentCount: queued.attachmentCount,
      fileAttachmentCount: queued.fileAttachmentCount,
      planMode: queued.planMode,
      state: queued.state === "queued" ? "queued" : "sending",
    });
  }
  return reconciled;
}
