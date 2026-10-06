export {
  type WorktreeRepositorySnapshot,
  type WorktreeSnapshot,
  type WorktreeFileChange,
  type GitWorkspace,
  type CheckoutState,
  type SessionWorktree,
  type SessionCheckout,
  type WorkspaceFile,
  type WorkspaceFilePage,
  type WorkspaceFileInventory,
  type WorkspaceFileDelta,
  type WorkspaceChangeList,
  type WorkspaceApplyConflict,
  type WorkspaceApplyResult,
  type WorkspaceFileContent,
  type WorkspaceFileDiff,
  type TurnRepositoryAnchor,
  type TurnAnchor,
  type PersistedWorktreeSummary,
  type LocalGitBranch,
  type LocalGitBranchList,
  type TurnTreeDiff,
} from "./worktree-types.ts";
export {
  WORKTREE_SUMMARY_ENTRY_TYPE,
  createWorktreeSummary,
  parseWorktreeSummary,
  readPersistedWorktreeSummaries,
} from "./worktree-summary.ts";
export { inspectGitWorkspace, captureCheckoutState, captureCheckoutTrees } from "./worktree-checkout.ts";
export { worktreeSnapshot, worktreeFingerprint, worktreeDiff } from "./worktree-snapshot.ts";
export { listLocalGitBranches, switchLocalGitBranch } from "./worktree-branches.ts";
export {
  sessionWorktreeBranch,
  sessionCheckoutBranch,
  turnsBranchForSession,
  legacyTurnRefSessionIds,
  migrateLegacyTurnRefs,
  appendTurnCommit,
  anchorWorktreeTurn,
  removeSessionRef,
  removeWorktreeTurnRefs,
  turnTreeDiff,
  turnWorktreeDiff,
} from "./worktree-turns.ts";
export {
  createSessionWorktree,
  createSessionWorktreeFromState,
  claimSessionCheckout,
  removeSessionWorktree,
  recreateSessionWorktree,
  removeSessionBranch,
  restoreCheckoutState,
  mergeWorkspaceChanges,
  snapshotSessionBranch,
} from "./worktree-sessions.ts";
export {
  inspectWorkspaceChanges,
  inspectTreeChanges,
  collectWorkspaceFiles,
  collectWorkspaceFileDelta,
  listWorkspaceFiles,
  readWorkspaceFile,
  diffWorkspaceFile,
  collectPlainWorkspaceFiles,
  listPlainWorkspaceFiles,
  readPlainWorkspaceFile,
} from "./worktree-files.ts";
