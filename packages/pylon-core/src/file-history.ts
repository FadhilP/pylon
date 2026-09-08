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
  hasMore: boolean;
  notice?: string;
  selected?: string;
  view?: "file" | "diff" | "change";
  content?: FileHistoryContent;
}
