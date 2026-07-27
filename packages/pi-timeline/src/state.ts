export const TIMELINE_STATE_VERSION = 3 as const;

export interface TimelineCheckpointChanges {
  fileCount: number;
  additions: number;
  deletions: number;
  binaryCount: number;
}

export interface TimelineCheckpointState {
  id: string;
  title: string;
  createdAt: string;
  branch?: string;
  verified: boolean;
  ownerSessionId: string;
  changes?: TimelineCheckpointChanges;
}

export interface TimelineStateSnapshot {
  version: typeof TIMELINE_STATE_VERSION;
  revision: number;
  sessionId: string;
  available: boolean;
  checkpoints: TimelineCheckpointState[];
  undoPromptEntryIds: string[];
}

export interface TimelineStateRequest {
  version: typeof TIMELINE_STATE_VERSION;
  sessionId: string;
  respond(value: TimelineStateSnapshot): void;
}

export function timelineStateSnapshot(
  sessionId: string,
  revision: number,
  checkpoints: TimelineCheckpointState[],
  available = true,
  undoPromptEntryIds: string[] = [],
): TimelineStateSnapshot {
  return {
    version: TIMELINE_STATE_VERSION,
    revision,
    sessionId,
    available,
    undoPromptEntryIds: undoPromptEntryIds.slice(-10_000).map((id) => id.slice(0, 128)),
    checkpoints: checkpoints.slice(-100).map((item) => ({
      id: item.id.slice(0, 128),
      title: item.title.slice(0, 500),
      createdAt: item.createdAt,
      ...(item.branch ? { branch: item.branch.slice(0, 200) } : {}),
      verified: item.verified,
      ownerSessionId: item.ownerSessionId.slice(0, 128),
      ...(item.changes ? {
        changes: {
          fileCount: Math.max(0, Math.min(10_000, Math.trunc(item.changes.fileCount))),
          additions: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(item.changes.additions))),
          deletions: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(item.changes.deletions))),
          binaryCount: Math.max(0, Math.min(10_000, Math.trunc(item.changes.binaryCount))),
        },
      } : {}),
    })),
  };
}
