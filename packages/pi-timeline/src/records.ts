import type { Snapshot } from "./snapshot.ts";
import type { TimelineChangeSet } from "./changes.ts";

/** A checkpoint as persisted in the session log, alongside the snapshot it captured. */
export type TimelineCheckpointSource = "pi-guard";

export type CheckpointRecord = Snapshot & {
  version: 3 | 4 | 5 | 6;
  kind: "pi-prompt-checkpoint";
  promptEntryId: string;
  ownerSessionId: string;
  continuationEntryId: string;
  createdAt: string;
  /** Bounded operational origin; absent on checkpoints created before source tracking. */
  source?: TimelineCheckpointSource;
  changes?: Pick<TimelineChangeSet, "fileCount" | "additions" | "deletions" | "binaryCount">;
  /** Session-start state used only to attribute the first checkpoint's displayed changes. */
  baseline?: Snapshot;
  baselineEntryId?: string;
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

export type CheckpointTitleV1 = {
  version: 1;
  kind: "pi-checkpoint-title";
  checkpointEntryId: string;
  ownerSessionId: string;
  title: string;
};

export type TimelineBaselineV1 = Snapshot & {
  version: 1;
  kind: "pi-timeline-baseline";
  ownerSessionId: string;
  createdAt: string;
};

export type TimelineBaselineRetiredV1 = {
  version: 1;
  kind: "pi-timeline-baseline-retired";
  baselineEntryId: string;
  ownerSessionId: string;
};

export const CHECKPOINT_VERSIONS = [3, 4, 5, 6] as const;
/** Versions that already carry a repository-independent snapshot. */
export const PORTABLE_CHECKPOINT_VERSIONS = [4, 5, 6] as const;

/** Returns a custom entry's data when it matches `customType` and, optionally, a known version. */
export const customEntryData = (entry: any, customType: string, versions?: readonly number[]): any | undefined => {
  if (entry?.type !== "custom" || entry.customType !== customType) return undefined;
  const data = entry.data;
  if (!data) return undefined;
  return !versions || versions.includes(data.version) ? data : undefined;
};
