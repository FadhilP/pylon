/** Shapes shared by the worktree modules and their callers. */

export interface WorktreeRepositorySnapshot {
  /** Workspace-relative path; empty only for the top repository. */
  path: string;
  root: string;
  commonDir: string;
  tree: string;
  fingerprint: string;
}

export interface WorktreeSnapshot {
  root: string;
  tree: string;
  fingerprint: string;
  repositories?: WorktreeRepositorySnapshot[];
}

export interface WorktreeFileChange {
  path: string;
  additions?: number;
  deletions?: number;
  binary?: boolean;
}

export interface GitWorkspace {
  root: string;
  commonDir: string;
  head?: string;
  headRef?: string;
}

export interface CheckoutState extends GitWorkspace {
  indexTree: string;
  worktreeTree: string;
}

export interface SessionWorktree {
  root: string;
  commonDir: string;
  branch: string;
  baseline: string;
  baselineTree: string;
}

export interface SessionCheckout extends SessionWorktree {
  parked: CheckoutState;
}

export interface WorkspaceFile {
  path: string;
  status?: "added" | "modified" | "deleted";
  additions?: number;
  deletions?: number;
  binary?: boolean;
  /** Explicit directories, including empty folders and registered submodules. */
  kind?: "submodule" | "directory";
}

export interface WorkspaceFilePage {
  revision: string;
  files: WorkspaceFile[];
  totalCount: number;
  truncated: boolean;
  nextCursor?: string;
}

export type WorkspaceFileInventory = Omit<WorkspaceFilePage, "nextCursor">;

export interface WorkspaceFileDelta {
  revision: string;
  upserted: WorkspaceFile[];
  removed: string[];
  reconcileRequired: boolean;
}

export interface WorkspaceChangeList {
  revision: string;
  files: WorkspaceFile[];
  /** Nested checkout content that cannot be represented by the parent repository's gitlink tree. */
  unapplicableSubmoduleChanges?: boolean;
}

export interface WorkspaceApplyConflict {
  path: string;
  context?: string;
}

export type WorkspaceApplyResult =
  | { state: "applied" | "unchanged"; checkout: CheckoutState }
  | { state: "conflict"; conflicts: WorkspaceApplyConflict[] };

export interface WorkspaceFileContent {
  revision: string;
  path: string;
  state: "available" | "deleted" | "binary" | "oversized";
  text?: string;
  truncated?: boolean;
}

export interface WorkspaceFileDiff {
  revision: string;
  path: string;
  state: "available" | "binary" | "oversized";
  text?: string;
  truncated?: boolean;
}

export interface TurnRepositoryAnchor {
  path: string;
  beforeTree: string;
  afterTree: string;
}

export interface TurnAnchor {
  root: string;
  beforeTree: string;
  afterTree: string;
  /** Changed initialized submodules. The top repository remains in the legacy fields above. */
  repositories?: TurnRepositoryAnchor[];
}

export interface PersistedWorktreeSummary {
  version: 1;
  assistantEntryId: string;
  files: WorktreeFileChange[];
  root?: string;
  beforeTree?: string;
  afterTree?: string;
  repositories?: TurnRepositoryAnchor[];
}

export interface LocalGitBranch {
  name: string;
  lastCommitAt: string;
  current: boolean;
  checkoutAvailable: boolean;
  checkoutUnavailableReason?: string;
}

export interface LocalGitBranchList {
  branches: LocalGitBranch[];
  currentBranch?: string;
  truncated: boolean;
}

export type TurnTreeDiff =
  { state: "binary" } | { state: "available" | "oversized"; text: string; truncated?: boolean };
