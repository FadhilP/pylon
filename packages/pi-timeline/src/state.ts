export const TIMELINE_STATE_VERSION = 2 as const;

export interface TimelineCheckpointState {
  id: string;
  title: string;
  createdAt: string;
  branch?: string;
  verified: boolean;
  ownerSessionId: string;
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
    })),
  };
}
