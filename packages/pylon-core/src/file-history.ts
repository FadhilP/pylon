/** Internal, owner-bound Timeline snapshot descriptors. Never accept these from HTTP. */
export interface HistoryRepository {
  path: string;
  commonDir?: string;
  tree: string;
  head: string;
}
export interface HistoryTree extends HistoryRepository {
  repositories?: HistoryRepository[];
}
export interface HistoryCheckpoint {
  id: string;
  title: string;
  createdAt: string;
  verification: "passed" | "failed" | "unverified";
  snapshot: HistoryTree;
}
export interface FileHistoryContext {
  sessionId: string;
  baseline?: HistoryTree;
  /** State immediately preceding a bounded window; its line owners are unknown. */
  seed?: HistoryTree;
  checkpoints: HistoryCheckpoint[];
  partial: boolean;
}

export interface FileHistoryQuery {
  path: string;
  scope: "session" | "all";
  /** Git prefix length, not an unbounded offset. Maximum 200. */
  limit?: number;
  /** Only IDs in the returned history may be selected. */
  selected?: string;
  view?: "file" | "diff" | "change";
}
export interface FileHistoryOwner {
  id: string;
  title: string;
  kind: "checkpoint" | "commit";
  author?: string;
}
export interface FileHistoryStop extends FileHistoryOwner {
  kind: "checkpoint" | "commit";
  createdAt: string;
  verification?: "passed" | "failed" | "unverified";
  /** Path at this revision; renames in committed history are followed. */
  path: string;
  /** Unchanged session snapshots omitted before this checkpoint; null is a known Git gap of unknown size. */
  skippedBefore?: number | null;
}
export interface FileHistoryContent {
  state: "available" | "deleted" | "binary" | "oversized" | "unavailable";
  /** Source text in file mode, a Git patch in diff/change mode. */
  text?: string;
  before?: string;
  after?: string;
  oldOwners?: (string | null)[];
  newOwners?: (string | null)[];
  owners: FileHistoryOwner[];
  /** Line counts for this version's individual change, when its bounded textual patch is available. */
  changes?: { added: number; removed: number };
  attributionComplete: boolean;
}
export interface FileHistoryResult {
  path: string;
  revision: string;
  /** Chronological Git history followed by active-branch session checkpoints. */
  stops: FileHistoryStop[];
  sessionAvailable: boolean;
  baselineAvailable: boolean;
  baselineLabel?: "Session baseline" | "HEAD";
  partial: boolean;
  /** Verified unchanged session checkpoints omitted after the final emitted checkpoint. */
  skippedSessionTail?: number;
  hasMore: boolean;
  notice?: string;
  selected?: string;
  view?: "file" | "diff" | "change";
  content?: FileHistoryContent;
}
