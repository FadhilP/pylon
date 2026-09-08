import { validWorkspacePath } from "./workspace-mutations.ts";

export type GitFile = {
  path: string;
  oldPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  additions?: number;
  deletions?: number;
  binary?: boolean;
};
export type GitOperationKind = "merge" | "rebase" | "cherry-pick" | "revert" | "conflict";
export type GitOperation = {
  kind: GitOperationKind;
  step?: number;
  total?: number;
  currentCommit?: string;
  onto?: string;
};
export type GitCommit = { oid: string; parents: string[]; subject: string; author: string; authoredAt: string };
export type GitStash = { oid: string; selector: string; subject: string };
export type GitBranch = { name: string; oid: string; current?: boolean; remote?: boolean };
export type GitRemote = { name: string };

export type GitState = {
  available: boolean;
  /** Present when available is false. It is intentionally suitable for display, not parsing. */
  reason?: string;
  /** Changes exceeded a bounded observation. Never use such a state as an action precondition. */
  truncated?: boolean;
  revision?: string;
  branch?: string;
  head?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  remotes: GitRemote[];
  branches: GitBranch[];
  files: GitFile[];
  operation?: GitOperation;
  history: GitCommit[];
  stashes: GitStash[];
};

export type GitDetailFile = GitFile & { beforeText?: string; afterText?: string; textTruncated?: boolean };
export type GitConflictBlock = {
  /** Character offsets in LF-normalized conflict text, including marker lines. */
  start: number;
  end: number;
  ours: string;
  theirs: string;
  base?: string;
  oursLabel?: string;
  theirsLabel?: string;
  baseLabel?: string;
};
export type GitDetail = {
  revision?: string;
  /** The file whose content and patch are included; defaults to the first changed file. */
  selectedPath?: string;
  files: GitDetailFile[];
  unifiedDiff: string;
  truncated?: boolean;
  commits?: GitCommit[];
  conflict?: { path: string; version: string; text: string; blocks: GitConflictBlock[]; operation?: GitOperation };
};

export type GitDetailQuery =
  | { kind: "file"; path: string; stage: "staged" | "unstaged" }
  | { kind: "commit"; oid: string; path?: string }
  | { kind: "range"; oldest: string; newest: string; path?: string }
  | { kind: "history"; ref: string }
  | { kind: "stash"; oid: string; path?: string }
  | { kind: "conflict"; path: string };

export type GitActionInput =
  | { action: "stage"; expectedRevision: string; paths: string[]; confirmed?: boolean }
  | { action: "unstage"; expectedRevision: string; paths: string[]; confirmed: true }
  | { action: "commit"; expectedRevision: string; message: string; amend?: boolean; confirmed?: boolean }
  | { action: "fetch"; expectedRevision: string; remote?: string; confirmed: true }
  | { action: "pull" | "push"; expectedRevision: string; confirmed: true }
  | { action: "stash"; expectedRevision: string; message?: string; includeUntracked: boolean; confirmed: true }
  | {
      action: "stashApply" | "stashPop" | "stashDrop";
      expectedRevision: string;
      oid: string;
      selector: string;
      confirmed: true;
    }
  | { action: "discard"; expectedRevision: string; paths: string[]; scope: "working" | "all"; confirmed: true }
  | { action: "init"; expectedRevision: string; confirmed: true }
  | { action: "merge" | "rebase"; expectedRevision: string; target: string; confirmed: true }
  | { action: "createBranch"; expectedRevision: string; name: string; confirmed: true }
  | { action: "cherryPick" | "revert"; expectedRevision: string; oids: string[]; confirmed: true }
  | {
      action: "continue" | "skip" | "abort";
      expectedRevision: string;
      operation: Exclude<GitOperationKind, "conflict">;
      confirmed: true;
    }
  | {
      action: "resolve";
      expectedRevision: string;
      path: string;
      expectedVersion: string;
      text: string;
      confirmed: true;
    };

const oid = (value: unknown) => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const revision = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const paths = (value: unknown) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= 2000 &&
  value.every(validWorkspacePath) &&
  new Set(value).size === value.length;

export function validGitDetailQuery(value: unknown): value is GitDetailQuery {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (item.kind === "file")
    return validWorkspacePath(item.path) && (item.stage === "staged" || item.stage === "unstaged");
  if (item.kind === "commit" || item.kind === "stash")
    return oid(item.oid) && (item.path === undefined || validWorkspacePath(item.path));
  if (item.kind === "range")
    return oid(item.oldest) && oid(item.newest) && (item.path === undefined || validWorkspacePath(item.path));
  if (item.kind === "history")
    return typeof item.ref === "string" && item.ref.length > 0 && item.ref.length <= 500 && !item.ref.includes("\0");
  return item.kind === "conflict" && validWorkspacePath(item.path);
}

/** Structural validation only; the server also validates every target against its current repository state. */
export function validGitActionInput(value: unknown): value is GitActionInput {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (!revision(item.expectedRevision) || typeof item.action !== "string") return false;
  if (item.action === "stage") return paths(item.paths) && (item.confirmed === undefined || item.confirmed === true);
  if (item.action === "unstage") return paths(item.paths) && item.confirmed === true;
  if (item.action === "commit")
    return (
      typeof item.message === "string" &&
      item.message.length > 0 &&
      item.message.length <= 100_000 &&
      (item.amend === undefined || typeof item.amend === "boolean") &&
      (item.amend ? item.confirmed === true : item.confirmed === undefined || item.confirmed === true)
    );
  if (item.action === "fetch")
    return (
      item.confirmed === true &&
      (item.remote === undefined || (typeof item.remote === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(item.remote)))
    );
  if (item.action === "pull" || item.action === "push" || item.action === "init") return item.confirmed === true;
  if (item.action === "stash")
    return (
      item.confirmed === true &&
      typeof item.includeUntracked === "boolean" &&
      (item.message === undefined || (typeof item.message === "string" && item.message.length <= 100_000))
    );
  if (item.action === "stashApply" || item.action === "stashPop" || item.action === "stashDrop")
    return (
      item.confirmed === true &&
      oid(item.oid) &&
      typeof item.selector === "string" &&
      /^stash@\{[0-9]+\}$/.test(item.selector)
    );
  if (item.action === "discard")
    return item.confirmed === true && paths(item.paths) && (item.scope === "working" || item.scope === "all");
  if (item.action === "merge" || item.action === "rebase")
    return (
      item.confirmed === true &&
      typeof item.target === "string" &&
      item.target.length > 0 &&
      item.target.length <= 500 &&
      !item.target.includes("\0")
    );
  if (item.action === "createBranch")
    return (
      item.confirmed === true &&
      typeof item.name === "string" &&
      item.name.length > 0 &&
      item.name.length <= 500 &&
      !item.name.includes("\0")
    );
  if (item.action === "cherryPick" || item.action === "revert")
    return (
      item.confirmed === true &&
      Array.isArray(item.oids) &&
      item.oids.length > 0 &&
      item.oids.length <= 100 &&
      item.oids.every(oid)
    );
  if (item.action === "continue" || item.action === "skip" || item.action === "abort")
    return (
      item.confirmed === true &&
      (item.operation === "merge" ||
        item.operation === "rebase" ||
        item.operation === "cherry-pick" ||
        item.operation === "revert")
    );
  return (
    item.action === "resolve" &&
    item.confirmed === true &&
    validWorkspacePath(item.path) &&
    typeof item.expectedVersion === "string" &&
    /^[a-f0-9]{64}$/.test(item.expectedVersion) &&
    typeof item.text === "string" &&
    item.text.length <= 1024 * 1024
  );
}
