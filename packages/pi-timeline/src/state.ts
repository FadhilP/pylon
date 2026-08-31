export const TIMELINE_STATE_VERSION = 4 as const;
export type TimelineVerificationState = "passed" | "failed" | "unverified";
export type TimelineCheckpointSource = "pi-guard";

export interface TimelineCheckpointChanges {
  fileCount: number;
  additions: number;
  deletions: number;
  binaryCount: number;
}

export interface TimelineCheckpointState {
  id: string;
  promptEntryId: string;
  title: string;
  createdAt: string;
  branch?: string;
  verified: boolean;
  verificationState: TimelineVerificationState;
  ownerSessionId: string;
  source?: TimelineCheckpointSource;
  changes?: TimelineCheckpointChanges;
}

export interface TimelineCheckpointFailureState {
  id: string;
  promptEntryId: string;
  title: string;
  createdAt: string;
  reason: string;
}

export interface TimelineStateSnapshot {
  version: typeof TIMELINE_STATE_VERSION;
  revision: number;
  sessionId: string;
  available: boolean;
  checkpoints: TimelineCheckpointState[];
  failures: TimelineCheckpointFailureState[];
  undoPromptEntryIds: string[];
  forkPromptEntryIds: string[];
  forkPromptCheckpoints: Array<{ promptEntryId: string; checkpointId: string }>;
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
  forkPromptEntryIds: string[] = [],
  forkPromptCheckpoints: Array<{ promptEntryId: string; checkpointId: string }> = [],
  failures: TimelineCheckpointFailureState[] = [],
): TimelineStateSnapshot {
  return {
    version: TIMELINE_STATE_VERSION,
    revision,
    sessionId,
    available,
    undoPromptEntryIds: undoPromptEntryIds.slice(-10_000).map(id => id.slice(0, 128)),
    forkPromptEntryIds: forkPromptEntryIds.slice(-10_000).map(id => id.slice(0, 128)),
    forkPromptCheckpoints: forkPromptCheckpoints
      .slice(-10_000)
      .map(item => ({
        promptEntryId: item.promptEntryId.slice(0, 128),
        checkpointId: item.checkpointId.slice(0, 128),
      })),
    failures: failures
      .slice(-20)
      .map(item => ({
        id: item.id.slice(0, 128),
        promptEntryId: item.promptEntryId.slice(0, 128),
        title: item.title.slice(0, 500),
        createdAt: item.createdAt,
        reason: item.reason.slice(0, 500),
      })),
    checkpoints: checkpoints
      .slice(-100)
      .map(item => ({
        id: item.id.slice(0, 128),
        promptEntryId: item.promptEntryId.slice(0, 128),
        title: item.title.slice(0, 500),
        createdAt: item.createdAt,
        ...(item.branch ? { branch: item.branch.slice(0, 200) } : {}),
        verified: item.verified,
        verificationState: item.verificationState,
        ...(item.source === "pi-guard" ? { source: item.source } : {}),
        ownerSessionId: item.ownerSessionId.slice(0, 128),
        ...(item.changes
          ? {
              changes: {
                fileCount: Math.max(0, Math.min(10_000, Math.trunc(item.changes.fileCount))),
                additions: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(item.changes.additions))),
                deletions: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(item.changes.deletions))),
                binaryCount: Math.max(0, Math.min(10_000, Math.trunc(item.changes.binaryCount))),
              },
            }
          : {}),
      })),
  };
}
