import type { Snapshot } from "./snapshot.ts";
import type { TimelineChangeSet } from "./changes.ts";

/** A checkpoint as persisted in the session log, alongside the snapshot it captured. */
export type CheckpointRecord = Snapshot & {
  version: 3 | 4 | 5;
  kind: "pi-prompt-checkpoint";
  promptEntryId: string;
  ownerSessionId: string;
  continuationEntryId: string;
  createdAt: string;
  changes?: Pick<TimelineChangeSet, "fileCount" | "additions" | "deletions" | "binaryCount">;
  verification?: {
    runId: string;
    state: "passed" | "failed";
    scope: "changed" | "project";
    worktreeId: string;
    checks: string[];
  };
};

/** A checkpoint record paired with the prompt and session it belongs to. */
export type Bound = {
  record: CheckpointRecord;
  checkpointEntryId: string;
  preview: string;
  sessionId: string;
  sessionPath?: string;
};

export type ClearV1 = { version: 1; ownerSessionId: string; checkpointEntryIds: string[] };

export const CHECKPOINT_VERSIONS = [3, 4, 5] as const;
/** Versions that already carry a repository-independent snapshot. */
export const PORTABLE_CHECKPOINT_VERSIONS = [4, 5] as const;

/** Returns a custom entry's data when it matches `customType` and, optionally, a known version. */
export const customEntryData = (entry: any, customType: string, versions?: readonly number[]): any | undefined => {
  if (entry?.type !== "custom" || entry.customType !== customType) return undefined;
  const data = entry.data;
  if (!data) return undefined;
  return !versions || versions.includes(data.version) ? data : undefined;
};
