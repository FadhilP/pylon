import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { activeAssistantEntryIds } from "./work-duration.ts";

function git(cwd: string, args: string[], env: Record<string, string> = {}, maxBuffer = 64 * 1024 * 1024) {
  return new Promise<string>((resolve, reject) =>
    execFile(
      "git",
      args,
      { cwd, env: { ...process.env, ...env }, maxBuffer, timeout: 120_000, windowsHide: true },
      (error, stdout, stderr) =>
        error
          ? reject(Error(String(stderr || error.message).slice(0, 8192)))
          : resolve(String(stdout).replace(/\r?\n$/, "")),
    ),
  );
}

const ident = {
  GIT_AUTHOR_NAME: "Pylon",
  GIT_AUTHOR_EMAIL: "pylon@local",
  GIT_COMMITTER_NAME: "Pylon",
  GIT_COMMITTER_EMAIL: "pylon@local",
};
const objectId = /^[0-9a-f]{40,64}$/i;
const worktreeId = /^[A-Za-z0-9._-]{8,80}$/;
const ownedBranch = /^refs\/heads\/(?:pylon\/sessions\/[A-Za-z0-9._-]{1,80}|pylon-session-[A-Za-z0-9._-]{8,80})$/;
const canonical = (path: string) => (process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path));
const rootCache = new Map<string, string>();
const revisionCache = new Map<string, { head: string; tree: string }>();
const snapshotRetryDelaysMs = [25, 50, 100, 200] as const;
async function repositoryRoot(cwd: string): Promise<string> {
  const key = canonical(cwd);
  const cached = rootCache.get(key);
  if (
    cached &&
    (await stat(join(cached, ".git"))
      .then(() => true)
      .catch(() => false))
  )
    return cached;
  rootCache.delete(key);
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (canonical(root) === key) rootCache.set(key, root);
  return root;
}
const outside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === ".." || path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(path);
};
const splitNul = (value: string) => value.split("\0").filter(Boolean);

function fieldTail(record: string, fieldCount: number): string | undefined {
  let offset = 0;
  for (let field = 0; field < fieldCount; field++) {
    offset = record.indexOf(" ", offset);
    if (offset < 0) return undefined;
    offset++;
  }
  return record.slice(offset) || undefined;
}

function parseWorktreeStatus(status: string): { head: string; dirty: boolean; paths: string[] } {
  const records = splitNul(status);
  const head = records.find(record => record.startsWith("# branch.oid "))?.slice(13) ?? "";
  const paths = new Set<string>();
  let dirty = false;
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if (record.startsWith("# ")) continue;
    dirty = true;
    const path = record.startsWith("1 ")
      ? fieldTail(record, 8)
      : record.startsWith("2 ")
        ? fieldTail(record, 9)
        : record.startsWith("u ")
          ? fieldTail(record, 10)
          : record.startsWith("? ")
            ? record.slice(2)
            : undefined;
    if (path) paths.add(path);
    if (record.startsWith("2 ") && records[index + 1]) paths.add(records[++index]!);
  }
  return { head, dirty, paths: [...paths] };
}

async function temporaryIndex<T>(run: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "pylon-worktree-"));
  try {
    return await run({ GIT_INDEX_FILE: join(directory, "index") });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function currentIndexTree(root: string): Promise<string> {
  const source = await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  return temporaryIndex(async env => {
    const target = env.GIT_INDEX_FILE!;
    try {
      await copyFile(source, target);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      await git(root, ["read-tree", "--empty"], env);
    }
    return git(root, ["write-tree"], env);
  });
}

async function currentTree(root: string, head?: string, changedPaths?: string[]): Promise<string> {
  return temporaryIndex(async env => {
    await git(root, head ? ["read-tree", head] : ["read-tree", "--empty"], env);
    const boundedPaths =
      changedPaths?.length &&
      changedPaths.length <= 500 &&
      changedPaths.reduce((size, path) => size + path.length + 1, 0) <= 24_000
        ? changedPaths.map(path => `:(literal)${path}`)
        : ["."];
    await git(root, ["add", "-A", "--", ...boundedPaths], env);
    return git(root, ["write-tree"], env);
  });
}

async function head(root: string): Promise<string | undefined> {
  return git(root, ["rev-parse", "--verify", "HEAD"]).catch(() => undefined);
}

async function headRef(root: string): Promise<string | undefined> {
  return git(root, ["symbolic-ref", "-q", "HEAD"]).catch(() => undefined);
}

async function commonDirectory(root: string): Promise<string> {
  const value = await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return realpath(value);
}

function safeRelativePath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (!validSummaryPath(normalized)) throw Error("Unsafe workspace path.");
  return normalized;
}

async function confinedFile(root: string, path: string): Promise<string> {
  const normalized = safeRelativePath(path);
  const absolute = resolve(root, normalized);
  if (outside(root, absolute)) throw Error("Unsafe workspace path.");
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink()) throw Error("Only regular workspace files can be read.");
  const physical = await realpath(absolute);
  if (outside(await realpath(root), physical)) throw Error("Workspace file escapes its checkout.");
  return physical;
}

async function assertSafeCheckout(workspace: GitWorkspace): Promise<void> {
  if ((await git(workspace.root, ["rev-parse", "--is-bare-repository"])) === "true") {
    throw Error("Bare repositories are unsupported.");
  }
  if ((await git(workspace.root, ["ls-files", "-u"])).trim()) {
    throw Error("Unmerged Git index is unsupported.");
  }
  const gitDir = await git(workspace.root, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"]) {
    if (
      await stat(join(gitDir, name))
        .then(() => true)
        .catch(() => false)
    ) {
      throw Error("A Git operation is already in progress.");
    }
  }
  const paths = splitNul(await git(workspace.root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]));
  const physicalRoot = await realpath(workspace.root);
  for (const path of paths.slice(0, 100_000)) {
    const safe = safeRelativePath(path);
    const absolute = resolve(workspace.root, safe);
    const info = await lstat(absolute).catch(() => undefined);
    if (!info?.isSymbolicLink()) continue;
    const target = await realpath(absolute);
    if (outside(physicalRoot, target)) throw Error(`External symlink is unsupported: ${safe}`);
  }
}

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
  /** Registered submodule folders without inventoried files; clients render them as non-selectable folders. */
  kind?: "submodule";
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

export const WORKTREE_SUMMARY_ENTRY_TYPE = "pylon-worktree-summary";
const MAX_SUMMARY_BYTES = 64 * 1024;
const MAX_SUMMARY_FILES = 100;
const MAX_TURN_REPOSITORIES = 64;
const MAX_SUBMODULE_DEPTH = 16;
const MAX_WORKSPACE_FILES = 10_000;

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

function validSummaryPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 500 &&
    !path.startsWith("/") &&
    !/^[A-Za-z]:\//.test(path) &&
    !path.includes("\\") &&
    !path.split("/").some(part => !part || part === "." || part === "..")
  );
}

function validatedTurnRepositories(value: unknown): TurnRepositoryAnchor[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TURN_REPOSITORIES) return undefined;
  const seen = new Set<string>();
  const repositories: TurnRepositoryAnchor[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const raw = item as Record<string, unknown>;
    if (
      typeof raw.path !== "string" ||
      !validSummaryPath(raw.path) ||
      seen.has(raw.path) ||
      typeof raw.beforeTree !== "string" ||
      !objectId.test(raw.beforeTree) ||
      typeof raw.afterTree !== "string" ||
      !objectId.test(raw.afterTree)
    )
      return undefined;
    seen.add(raw.path);
    repositories.push({ path: raw.path, beforeTree: raw.beforeTree, afterTree: raw.afterTree });
  }
  return repositories;
}

export function createWorktreeSummary(
  assistantEntryId: string,
  values: WorktreeFileChange[],
  anchor?: TurnAnchor,
): PersistedWorktreeSummary | undefined {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(assistantEntryId)) return undefined;
  const repositories = validatedTurnRepositories(anchor?.repositories);
  const anchored =
    anchor &&
    repositories &&
    typeof anchor.root === "string" &&
    anchor.root.length > 0 &&
    anchor.root.length <= 1024 &&
    objectId.test(anchor.beforeTree) &&
    objectId.test(anchor.afterTree)
      ? {
          root: anchor.root,
          beforeTree: anchor.beforeTree,
          afterTree: anchor.afterTree,
          ...(repositories.length ? { repositories } : {}),
        }
      : {};
  const summary: PersistedWorktreeSummary = { version: 1, assistantEntryId, files: [], ...anchored };
  for (const value of values.slice(0, MAX_SUMMARY_FILES)) {
    const path = value.path.replaceAll("\\", "/").slice(0, 500);
    if (!validSummaryPath(path)) continue;
    const file =
      value.binary === true
        ? { path, binary: true as const }
        : Number.isSafeInteger(value.additions) && Number.isSafeInteger(value.deletions)
          ? {
              path,
              additions: Math.min(1_000_000, Math.max(0, value.additions!)),
              deletions: Math.min(1_000_000, Math.max(0, value.deletions!)),
            }
          : undefined;
    if (!file) continue;
    const candidate = { ...summary, files: [...summary.files, file] };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_SUMMARY_BYTES) break;
    summary.files.push(file);
  }
  return summary;
}

export function parseWorktreeSummary(value: unknown): PersistedWorktreeSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_SUMMARY_BYTES) return undefined;
  } catch {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== 1 ||
    typeof raw.assistantEntryId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(raw.assistantEntryId) ||
    !Array.isArray(raw.files) ||
    raw.files.length === 0 ||
    raw.files.length > MAX_SUMMARY_FILES
  )
    return undefined;

  let anchor: TurnAnchor | undefined;
  if (
    raw.root !== undefined ||
    raw.beforeTree !== undefined ||
    raw.afterTree !== undefined ||
    raw.repositories !== undefined
  ) {
    const repositories = validatedTurnRepositories(raw.repositories);
    if (
      typeof raw.root !== "string" ||
      raw.root.length === 0 ||
      raw.root.length > 1024 ||
      typeof raw.beforeTree !== "string" ||
      !objectId.test(raw.beforeTree) ||
      typeof raw.afterTree !== "string" ||
      !objectId.test(raw.afterTree) ||
      !repositories
    )
      return undefined;
    anchor = {
      root: raw.root,
      beforeTree: raw.beforeTree,
      afterTree: raw.afterTree,
      ...(repositories.length ? { repositories } : {}),
    };
  }

  const files: WorktreeFileChange[] = [];
  for (const value of raw.files) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const file = value as Record<string, unknown>;
    if (typeof file.path !== "string" || !validSummaryPath(file.path)) return undefined;
    if (file.binary === true) {
      files.push({ path: file.path, binary: true });
      continue;
    }
    if (
      !Number.isSafeInteger(file.additions) ||
      !Number.isSafeInteger(file.deletions) ||
      Number(file.additions) < 0 ||
      Number(file.additions) > 1_000_000 ||
      Number(file.deletions) < 0 ||
      Number(file.deletions) > 1_000_000
    )
      return undefined;
    files.push({ path: file.path, additions: Number(file.additions), deletions: Number(file.deletions) });
  }
  return { version: 1, assistantEntryId: raw.assistantEntryId, files, ...anchor };
}

export function readPersistedWorktreeSummaries(session: {
  getBranch(): unknown[];
  getEntries(): unknown[];
}): Map<string, WorktreeFileChange[]> {
  const activeAssistants = activeAssistantEntryIds(session.getBranch());
  const summaries = new Map<string, WorktreeFileChange[]>();
  for (const value of session.getEntries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (entry.type !== "custom" || entry.customType !== WORKTREE_SUMMARY_ENTRY_TYPE) continue;
    const summary = parseWorktreeSummary(entry.data);
    if (!summary || !activeAssistants.has(summary.assistantEntryId)) continue;
    summaries.set(summary.assistantEntryId, summary.files);
  }
  return summaries;
}

async function repositorySnapshot(cwd: string, path = ""): Promise<WorktreeRepositorySnapshot | undefined> {
  for (let attempt = 0; attempt <= snapshotRetryDelaysMs.length; attempt++) {
    let raced = false;
    try {
      const root = await repositoryRoot(cwd);
      const key = canonical(root);
      let revision = revisionCache.get(key);
      let rawStatus: string;
      if (revision) {
        rawStatus = await git(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
      } else {
        const [value, status] = await Promise.all([
          git(root, ["rev-parse", "HEAD", "HEAD^{tree}"]),
          git(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]),
        ]);
        const [head, tree] = value.split(/\r?\n/, 2);
        if (!head || !tree) throw Error("Git returned an invalid HEAD revision.");
        revision = { head, tree };
        rawStatus = status;
      }
      const status = parseWorktreeStatus(rawStatus);
      if (status.head !== revision.head) {
        const [head, tree] = (await git(root, ["rev-parse", "HEAD", "HEAD^{tree}"])).split(/\r?\n/, 2);
        if (!head || !tree || head !== status.head) {
          raced = true;
          throw Error("Git HEAD changed during observation.");
        }
        revision = { head, tree };
      }
      revisionCache.set(key, revision);
      const commonDir = await commonDirectory(root);
      if (!status.dirty) {
        return { path, root, commonDir, tree: revision.tree, fingerprint: `${root}\n${revision.head}\nclean` };
      }

      const [indexTree, candidateTree] = await Promise.all([
        git(root, ["write-tree"]),
        currentTree(root, revision.head, status.paths),
      ]);
      const latestStatus = await git(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
      if (latestStatus !== rawStatus) {
        raced = true;
        throw Error("Git worktree changed during observation.");
      }
      return {
        path,
        root,
        commonDir,
        tree: candidateTree,
        fingerprint: `${root}\n${revision.head}\n${indexTree}\n${candidateTree}`,
      };
    } catch {
      if (!raced || attempt === snapshotRetryDelaysMs.length) return undefined;
      await new Promise(resolve => setTimeout(resolve, snapshotRetryDelaysMs[attempt]));
    }
  }
  return undefined;
}

export async function worktreeSnapshot(cwd: string): Promise<WorktreeSnapshot | undefined> {
  const top = await repositorySnapshot(cwd);
  if (!top) return undefined;
  try {
    const { nodes } = await discoverSubmodules(top.root, top.tree);
    const repositories: WorktreeRepositorySnapshot[] = [];
    // Serialize captures because nested repositories may share object-store locks on Windows.
    for (const node of nodes.slice(0, MAX_TURN_REPOSITORIES)) {
      const snapshot = await repositorySnapshot(node.root, node.path);
      if (
        !snapshot ||
        canonical(snapshot.root) !== canonical(node.root) ||
        canonical(snapshot.commonDir) !== canonical(node.current.commonDir)
      )
        return undefined;
      repositories.push(snapshot);
    }
    const fingerprint = createHash("sha256").update(top.fingerprint);
    for (const repository of repositories) fingerprint.update(`\n${repository.path}\n${repository.fingerprint}`);
    return {
      root: top.root,
      tree: top.tree,
      fingerprint: fingerprint.digest("base64url"),
      ...(repositories.length ? { repositories } : {}),
    };
  } catch {
    return undefined;
  }
}

export async function worktreeFingerprint(cwd: string): Promise<string | undefined> {
  return (await worktreeSnapshot(cwd))?.fingerprint;
}

interface MatchedRepositorySnapshots {
  path: string;
  before: WorktreeRepositorySnapshot;
  after: WorktreeRepositorySnapshot;
}

function matchedRepositorySnapshots(before: WorktreeSnapshot, after: WorktreeSnapshot): MatchedRepositorySnapshots[] {
  const matches: MatchedRepositorySnapshots[] = [
    {
      path: "",
      before: { path: "", root: before.root, commonDir: "", tree: before.tree, fingerprint: before.fingerprint },
      after: { path: "", root: after.root, commonDir: "", tree: after.tree, fingerprint: after.fingerprint },
    },
  ];
  const afterByPath = new Map((after.repositories ?? []).map(repository => [repository.path, repository]));
  for (const repository of before.repositories ?? []) {
    const candidate = afterByPath.get(repository.path);
    if (
      candidate &&
      canonical(candidate.root) === canonical(repository.root) &&
      canonical(candidate.commonDir) === canonical(repository.commonDir)
    ) {
      matches.push({ path: repository.path, before: repository, after: candidate });
    }
  }
  return matches;
}

async function repositoryTreeChanges(match: MatchedRepositorySnapshots): Promise<WorktreeFileChange[]> {
  const output = await git(match.before.root, [
    "diff",
    "--numstat",
    "-z",
    "--no-renames",
    match.before.tree,
    match.after.tree,
  ]);
  const files: WorktreeFileChange[] = [];
  for (const record of output.split("\0").filter(Boolean).slice(0, 500)) {
    const first = record.indexOf("\t");
    const second = record.indexOf("\t", first + 1);
    if (first < 0 || second < 0) continue;
    const added = record.slice(0, first);
    const deleted = record.slice(first + 1, second);
    const path = record.slice(second + 1);
    if (!path || path.length > 1_000) continue;
    if (added === "-" || deleted === "-") files.push({ path, binary: true });
    else {
      const additions = Number(added);
      const deletions = Number(deleted);
      if (Number.isSafeInteger(additions) && Number.isSafeInteger(deletions)) {
        files.push({ path, additions, deletions });
      }
    }
  }
  return files;
}

function directChildPath(parent: string, child: string, paths: Set<string>): string | undefined {
  let owner = "";
  for (const path of paths) {
    if (path !== child && child.startsWith(`${path}/`) && path.length > owner.length) owner = path;
  }
  if (owner !== parent) return undefined;
  return parent ? child.slice(parent.length + 1) : child;
}

export async function worktreeDiff(
  before: WorktreeSnapshot,
  after: WorktreeSnapshot,
): Promise<WorktreeFileChange[] | undefined> {
  if (canonical(before.root) !== canonical(after.root)) return undefined;
  try {
    const matches = matchedRepositorySnapshots(before, after);
    const paths = new Set(matches.map(match => match.path));
    const changes = new Map<string, WorktreeFileChange[]>();
    for (const match of matches) changes.set(match.path, await repositoryTreeChanges(match));

    for (const child of matches.slice(1)) {
      if (!changes.get(child.path)?.length) continue;
      for (const parent of matches) {
        const localPath = directChildPath(parent.path, child.path, paths);
        if (!localPath) continue;
        changes.set(
          parent.path,
          (changes.get(parent.path) ?? []).filter(file => file.path !== localPath),
        );
        break;
      }
    }

    return matches
      .flatMap(match =>
        (changes.get(match.path) ?? []).map(file => ({
          ...file,
          path: match.path ? `${match.path}/${file.path}` : file.path,
        })),
      )
      .sort((left, right) => left.path.localeCompare(right.path))
      .slice(0, 500);
  } catch {
    return undefined;
  }
}

export async function inspectGitWorkspace(cwd: string): Promise<GitWorkspace | undefined> {
  try {
    const root = await realpath(await git(cwd, ["rev-parse", "--show-toplevel"]));
    return { root, commonDir: await commonDirectory(root), head: await head(root), headRef: await headRef(root) };
  } catch {
    return undefined;
  }
}

export function sessionWorktreeBranch(opaqueId: string): string {
  if (!worktreeId.test(opaqueId)) throw Error("Invalid worktree identifier.");
  return `refs/heads/pylon-session-${opaqueId}`;
}

/** Turn-snapshot branch for one agent session. Shares the pylon-session-* namespace with workspace branches; only the opaque identifier distinguishes them. */
export function turnsBranchForSession(sessionId: string): string | undefined {
  return worktreeId.test(sessionId) ? `refs/heads/pylon-session-${sessionId}` : undefined;
}

export async function appendTurnCommit(
  repositoryRootPath: string,
  branch: string,
  tree: string,
): Promise<string | undefined> {
  if (!ownedBranch.test(branch) || !objectId.test(tree)) return undefined;
  try {
    const root = await realpath(repositoryRootPath);
    const previous = await git(root, ["rev-parse", "--verify", `${branch}^{commit}`]).catch(() => undefined);
    if (previous !== undefined && !objectId.test(previous)) return undefined;
    if (previous) {
      // Already anchored: an identical tip tree needs no duplicate commit.
      const tipTree = await git(root, ["rev-parse", "--verify", `${previous}^{tree}`]).catch(() => undefined);
      if (tipTree === tree) return previous;
    }
    const commit = await git(
      root,
      ["commit-tree", tree, ...(previous ? ["-p", previous] : []), "-m", "Pylon turn snapshot"],
      ident,
    );
    if (!objectId.test(commit)) return undefined;
    await git(root, ["update-ref", branch, commit, ...(previous ? [previous] : [""])], ident);
    return commit;
  } catch {
    return undefined;
  }
}

/** Anchors every repository needed to reconstruct a complete turn diff. */
export async function anchorWorktreeTurn(
  before: WorktreeSnapshot,
  after: WorktreeSnapshot,
  branch: string,
): Promise<TurnAnchor | undefined> {
  if (canonical(before.root) !== canonical(after.root)) return undefined;
  const matches = matchedRepositorySnapshots(before, after);

  if (!(await appendTurnCommit(before.root, branch, before.tree))) return undefined;
  if (!(await appendTurnCommit(after.root, branch, after.tree))) return undefined;
  const repositories: TurnRepositoryAnchor[] = [];
  for (const match of matches.slice(1)) {
    if (match.before.tree === match.after.tree) continue;
    if (!(await appendTurnCommit(match.before.root, branch, match.before.tree))) return undefined;
    if (!(await appendTurnCommit(match.after.root, branch, match.after.tree))) return undefined;
    repositories.push({ path: match.path, beforeTree: match.before.tree, afterTree: match.after.tree });
  }
  return {
    root: before.root,
    beforeTree: before.tree,
    afterTree: after.tree,
    ...(repositories.length ? { repositories } : {}),
  };
}

export async function removeSessionRef(repositoryRootPath: string, branch: string): Promise<void> {
  if (!ownedBranch.test(branch)) throw Error("Refusing to remove a non-Pylon branch.");
  try {
    await git(await realpath(repositoryRootPath), ["update-ref", "-d", branch]);
  } catch {
    // Best-effort cleanup: a missing checkout or stale ref must not fail session deletion.
  }
}

/** Best-effort cleanup of turn refs in the top checkout and currently initialized submodules. */
export async function removeWorktreeTurnRefs(cwd: string, branch: string): Promise<void> {
  if (!ownedBranch.test(branch)) throw Error("Refusing to remove a non-Pylon branch.");
  const top = await repositorySnapshot(cwd);
  if (!top) {
    await removeSessionRef(cwd, branch);
    return;
  }
  let roots = [top.root];
  try {
    const { nodes } = await discoverSubmodules(top.root, top.tree);
    roots = [...roots, ...nodes.map(node => node.root)];
  } catch {
    // The top ref can still be removed when nested checkout discovery is unavailable.
  }
  await Promise.all(roots.map(root => removeSessionRef(root, branch)));
}

export type TurnTreeDiff =
  { state: "binary" } | { state: "available" | "oversized"; text: string; truncated?: boolean };

const MAX_TURN_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_TURN_DIFF_LINES = 20_000;

async function turnTreeDiffText(
  cwd: string,
  beforeTree: string,
  afterTree: string,
  path = "",
  excludedPaths: string[] = [],
): Promise<string> {
  if (!objectId.test(beforeTree) || !objectId.test(afterTree)) throw Error("Invalid turn snapshot trees.");
  const root = await realpath(cwd);
  return git(
    root,
    [
      "diff",
      "--no-ext-diff",
      "--no-renames",
      "--unified=3",
      ...(path ? [`--src-prefix=a/${path}/`, `--dst-prefix=b/${path}/`] : []),
      beforeTree,
      afterTree,
      ...(excludedPaths.length ? ["--", ".", ...excludedPaths.map(excluded => `:(exclude,literal)${excluded}`)] : []),
    ],
    {},
    MAX_TURN_DIFF_BYTES + 1,
  );
}

function boundedTurnTreeDiff(output: string): TurnTreeDiff {
  if (output.includes("Binary files ") || output.includes("GIT binary patch")) return { state: "binary" };
  const lines = output.split(/\r?\n/);
  if (Buffer.byteLength(output, "utf8") > MAX_TURN_DIFF_BYTES || lines.length > MAX_TURN_DIFF_LINES) {
    const bounded = lines.slice(0, MAX_TURN_DIFF_LINES).join("\n");
    return {
      state: "oversized",
      text: Buffer.from(bounded).subarray(0, MAX_TURN_DIFF_BYTES).toString("utf8"),
      truncated: true,
    };
  }
  return { state: "available", text: output };
}

export async function turnTreeDiff(cwd: string, beforeTree: string, afterTree: string): Promise<TurnTreeDiff> {
  return boundedTurnTreeDiff(await turnTreeDiffText(cwd, beforeTree, afterTree));
}

/** Builds one complete, path-prefixed patch from a trusted top checkout and persisted tree IDs. */
export async function turnWorktreeDiff(cwd: string, anchor: TurnAnchor): Promise<TurnTreeDiff> {
  const repositories = validatedTurnRepositories(anchor.repositories);
  if (!repositories) throw Error("Invalid turn repository anchors.");
  if (!repositories.length) return turnTreeDiff(cwd, anchor.beforeTree, anchor.afterTree);

  const root = await realpath(cwd);
  const { nodes } = await discoverSubmodules(root, anchor.afterTree);
  const nodesByPath = new Map(nodes.map(node => [node.path, node]));
  const sources = [
    { path: "", root, beforeTree: anchor.beforeTree, afterTree: anchor.afterTree },
    ...repositories.map(repository => {
      const node = nodesByPath.get(repository.path);
      if (!node) throw Error("turn diff submodule is unavailable");
      return { ...repository, root: node.root };
    }),
  ];
  const sourcePaths = new Set(sources.map(source => source.path));
  const initial = new Map<string, string>();
  for (const source of sources) {
    initial.set(source.path, await turnTreeDiffText(source.root, source.beforeTree, source.afterTree, source.path));
  }
  const hasSubtreeDiff = (path: string) =>
    [...initial].some(
      ([candidate, text]) => text.length > 0 && (candidate === path || candidate.startsWith(`${path}/`)),
    );
  const outputs: string[] = [];
  for (const source of sources) {
    const excluded = sources
      .slice(1)
      .map(child => directChildPath(source.path, child.path, sourcePaths))
      .filter((path): path is string => Boolean(path))
      .filter(path => {
        const full = source.path ? `${source.path}/${path}` : path;
        return hasSubtreeDiff(full);
      });
    outputs.push(
      excluded.length
        ? await turnTreeDiffText(source.root, source.beforeTree, source.afterTree, source.path, excluded)
        : initial.get(source.path)!,
    );
  }
  return boundedTurnTreeDiff(outputs.filter(Boolean).join("\n"));
}

async function createSessionBaseline(
  repositoryCwd: string,
  source: CheckoutState,
  opaqueId: string,
): Promise<{ repository: GitWorkspace; branch: string; baseline: string }> {
  if (
    !objectId.test(source.indexTree) ||
    !objectId.test(source.worktreeTree) ||
    (source.head && !objectId.test(source.head))
  )
    throw Error("Invalid checkout state.");
  const repository = await inspectGitWorkspace(repositoryCwd);
  if (!repository || canonical(repository.commonDir) !== canonical(source.commonDir)) {
    throw Error("Session baseline belongs to a different repository.");
  }
  await assertSafeCheckout(repository);
  const branch = sessionWorktreeBranch(opaqueId);
  const baseline = await git(
    repository.root,
    ["commit-tree", source.worktreeTree, ...(source.head ? ["-p", source.head] : []), "-m", "Pylon session baseline"],
    ident,
  );
  if (!objectId.test(baseline)) throw Error("Git returned an invalid baseline commit.");
  await git(repository.root, ["update-ref", branch, baseline, ""]);
  return { repository, branch, baseline };
}

export async function captureCheckoutState(cwd: string, validateForMutation = false): Promise<CheckoutState> {
  const workspace = await inspectGitWorkspace(cwd);
  if (!workspace) throw Error("Workspace is not a Git checkout.");
  if (validateForMutation) await assertSafeCheckout(workspace);
  const indexTree = validateForMutation
    ? await git(workspace.root, ["write-tree"])
    : await currentIndexTree(workspace.root);
  const worktreeTree = await currentTree(workspace.root, workspace.head);
  return { ...workspace, indexTree, worktreeTree };
}

export async function createSessionWorktree(
  sourceCwd: string,
  targetPath: string,
  ownedRoot: string,
  opaqueId = randomBytes(12).toString("base64url"),
): Promise<SessionWorktree> {
  const source = await captureCheckoutState(sourceCwd, true);
  return createSessionWorktreeFromState(sourceCwd, source, targetPath, ownedRoot, opaqueId);
}

export async function createSessionWorktreeFromState(
  repositoryCwd: string,
  source: CheckoutState,
  targetPath: string,
  ownedRoot: string,
  opaqueId = randomBytes(12).toString("base64url"),
): Promise<SessionWorktree> {
  const { repository, branch, baseline } = await createSessionBaseline(repositoryCwd, source, opaqueId);
  const target = resolve(targetPath);
  const root = resolve(ownedRoot);
  if (outside(root, target) || canonical(root) === canonical(target)) throw Error("Unsafe Pylon worktree path.");
  if (!outside(repository.root, target)) throw Error("Pylon worktrees must be stored outside the project checkout.");
  await mkdir(dirname(target), { recursive: true });
  try {
    await git(repository.root, ["worktree", "add", "--detach", target, baseline]);
    await git(target, ["symbolic-ref", "HEAD", branch]);
    await git(target, ["reset", "--mixed", baseline]);
    return {
      root: await realpath(target),
      commonDir: source.commonDir,
      branch,
      baseline,
      baselineTree: source.worktreeTree,
    };
  } catch (error) {
    await git(repository.root, ["worktree", "remove", "--force", target]).catch(() => {});
    await git(repository.root, ["update-ref", "-d", branch, baseline]).catch(() => {});
    await rm(target, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function claimSessionCheckout(
  cwd: string,
  opaqueId = randomBytes(12).toString("base64url"),
): Promise<SessionCheckout> {
  const parked = await captureCheckoutState(cwd, true);
  const { repository, branch, baseline } = await createSessionBaseline(cwd, parked, opaqueId);
  try {
    await restoreCheckoutState(repository.root, {
      ...parked,
      head: baseline,
      headRef: branch,
      indexTree: parked.worktreeTree,
    });
    return {
      root: repository.root,
      commonDir: repository.commonDir,
      branch,
      baseline,
      baselineTree: parked.worktreeTree,
      parked,
    };
  } catch (error) {
    await restoreCheckoutState(repository.root, parked).catch(() => {});
    await git(repository.root, ["update-ref", "-d", branch, baseline]).catch(() => {});
    throw error;
  }
}

export async function removeSessionWorktree(
  repositoryCwd: string,
  worktree: Pick<SessionWorktree, "root" | "commonDir" | "branch">,
  ownedRoot: string,
  deleteBranch = true,
): Promise<void> {
  if (!ownedBranch.test(worktree.branch)) throw Error("Refusing to remove a non-Pylon branch.");
  const target = resolve(worktree.root);
  const root = resolve(ownedRoot);
  if (outside(root, target) || canonical(root) === canonical(target))
    throw Error("Refusing to remove an external worktree.");
  const repository = await inspectGitWorkspace(repositoryCwd);
  if (!repository || canonical(repository.commonDir) !== canonical(worktree.commonDir)) {
    throw Error("Worktree metadata belongs to a different repository.");
  }
  const listed = await git(repository.root, ["worktree", "list", "--porcelain"]);
  const registered = listed.split(/\r?\n\r?\n/).some(record => {
    const line = record.split(/\r?\n/).find(value => value.startsWith("worktree "));
    return line && canonical(line.slice("worktree ".length)) === canonical(target);
  });
  if (!registered) throw Error("Pylon worktree is not registered by Git.");
  await git(repository.root, ["worktree", "remove", "--force", target]);
  if (deleteBranch) await git(repository.root, ["update-ref", "-d", worktree.branch]);
}

export async function recreateSessionWorktree(
  repositoryCwd: string,
  targetPath: string,
  ownedRoot: string,
  branch: string,
  expectedCommonDir: string,
): Promise<string> {
  if (!ownedBranch.test(branch)) throw Error("Refusing to use a non-Pylon branch.");
  const repository = await inspectGitWorkspace(repositoryCwd);
  if (!repository || canonical(repository.commonDir) !== canonical(expectedCommonDir)) {
    throw Error("Session branch belongs to a different repository.");
  }
  const target = resolve(targetPath);
  const root = resolve(ownedRoot);
  if (outside(root, target) || canonical(root) === canonical(target)) throw Error("Unsafe Pylon worktree path.");
  await mkdir(dirname(target), { recursive: true });
  const listed = await git(repository.root, ["worktree", "list", "--porcelain"]);
  const registered = listed.split(/\r?\n\r?\n/).some(record => {
    const line = record.split(/\r?\n/).find(value => value.startsWith("worktree "));
    return line && canonical(line.slice("worktree ".length)) === canonical(target);
  });
  if (registered) await git(repository.root, ["worktree", "remove", "--force", target]);
  else await rm(target, { recursive: true, force: true });
  await git(repository.root, ["worktree", "add", target, branch]);
  return realpath(target);
}

export async function removeSessionBranch(
  repositoryCwd: string,
  branch: string,
  expectedCommonDir: string,
): Promise<void> {
  if (!ownedBranch.test(branch)) throw Error("Refusing to remove a non-Pylon branch.");
  const repository = await inspectGitWorkspace(repositoryCwd);
  if (!repository || canonical(repository.commonDir) !== canonical(expectedCommonDir)) {
    throw Error("Session branch belongs to a different repository.");
  }
  if (repository.headRef === branch) throw Error("Refusing to remove the checked-out session branch.");
  await git(repository.root, ["update-ref", "-d", branch]);
}

export async function restoreCheckoutState(cwd: string, target: CheckoutState): Promise<void> {
  if (
    !objectId.test(target.indexTree) ||
    !objectId.test(target.worktreeTree) ||
    (target.head && !objectId.test(target.head))
  )
    throw Error("Invalid checkout state.");
  const current = await inspectGitWorkspace(cwd);
  if (!current || canonical(current.commonDir) !== canonical(target.commonDir)) {
    throw Error("Checkout state belongs to a different repository.");
  }
  await temporaryIndex(async env => {
    await git(current.root, ["read-tree", target.worktreeTree], env);
    const currentPaths = splitNul(await git(current.root, ["ls-files", "-z", "-co", "--exclude-standard"]));
    const targetPaths = new Set(
      splitNul(await git(current.root, ["ls-tree", "-rz", "--name-only", target.worktreeTree])),
    );
    for (const path of currentPaths) {
      if (targetPaths.has(path)) continue;
      const safe = safeRelativePath(path);
      await rm(resolve(current.root, safe), { recursive: true, force: true });
    }
    if (target.headRef) {
      if (!ownedBranch.test(target.headRef) && target.headRef !== current.headRef) {
        const refValue = await git(current.root, ["rev-parse", "--verify", target.headRef]);
        if (target.head && refValue !== target.head) throw Error("Target branch moved.");
      }
      await git(current.root, ["symbolic-ref", "HEAD", target.headRef]);
    } else if (target.head) {
      await git(current.root, ["update-ref", "--no-deref", "HEAD", target.head]);
    }
    await git(current.root, ["checkout-index", "--all", "--force"], env);
    await git(current.root, ["read-tree", target.indexTree]);
  });
}

const MAX_CONFLICT_PATHS = 100;
const MAX_CONFLICT_CONTEXT_BYTES = 32 * 1024;
const MAX_CONFLICT_CONTEXT_PER_FILE = 4_096;

type ConflictBlob = { mode: string; object: string };

/** Groups `ls-files -u` output by path, keyed by merge stage (1 base, 2 target, 3 source). */
function unmergedStages(entries: string[]): Map<string, Map<number, ConflictBlob>> {
  const conflicts = new Map<string, Map<number, ConflictBlob>>();
  for (const entry of entries) {
    const match = /^(\d+) ([0-9a-f]+) ([123])\t(.+)$/i.exec(entry);
    if (!match) continue;
    const [, mode, object, stage, path] = match;
    const stages = conflicts.get(path) ?? new Map<number, ConflictBlob>();
    stages.set(Number(stage), { mode, object });
    conflicts.set(path, stages);
  }
  return conflicts;
}

/** When one side's text wholly contains the other, that side is a superset and wins outright. */
function pickContainedSide(
  target: { text?: string; blob: ConflictBlob },
  source: { text?: string; blob: ConflictBlob },
): ConflictBlob | undefined {
  if (target.text === undefined || source.text === undefined) return;
  if (source.text.includes(target.text)) return source.blob;
  if (target.text.includes(source.text)) return target.blob;
}

/**
 * Resolves the conflicts `git merge-index` could not, by taking whichever side is a strict superset
 * of the other. Returns true when nothing unmerged is left.
 */
async function autoResolveConflicts(root: string, env: Record<string, string>): Promise<boolean> {
  const conflicts = unmergedStages(splitNul(await git(root, ["ls-files", "-u", "-z"], env)));
  for (const [path, stages] of conflicts) {
    const targetBlob = stages.get(2);
    const sourceBlob = stages.get(3);
    if (!targetBlob || !sourceBlob) continue;
    const safe = safeRelativePath(path);
    const [targetText, sourceText] = await Promise.all([
      git(root, ["show", `:2:${safe}`], env).catch(() => undefined),
      git(root, ["show", `:3:${safe}`], env).catch(() => undefined),
    ]);
    const selected = pickContainedSide({ text: targetText, blob: targetBlob }, { text: sourceText, blob: sourceBlob });
    if (!selected) continue;
    await git(root, ["update-index", "--add", "--cacheinfo", `${selected.mode},${selected.object},${safe}`], env);
  }
  return !(await git(root, ["ls-files", "-u"], env)).trim();
}

/** Reports the still-conflicting paths with a bounded excerpt of each merged file. */
async function describeConflicts(
  root: string,
  env: Record<string, string>,
  workTree: string,
): Promise<WorkspaceApplyConflict[]> {
  const paths = [
    ...new Set(
      splitNul(await git(root, ["ls-files", "-u", "-z"], env))
        .map(entry => entry.slice(entry.indexOf("\t") + 1))
        .filter(Boolean),
    ),
  ].slice(0, MAX_CONFLICT_PATHS);
  const conflicts: WorkspaceApplyConflict[] = [];
  let contextBytes = 0;
  for (const path of paths) {
    const safe = safeRelativePath(path);
    let context: string | undefined;
    if (contextBytes < MAX_CONFLICT_CONTEXT_BYTES) {
      const value = await readFile(resolve(workTree, safe)).catch(() => undefined);
      if (value && !value.includes(0)) {
        context = value
          .toString("utf8")
          .slice(0, Math.min(MAX_CONFLICT_CONTEXT_PER_FILE, MAX_CONFLICT_CONTEXT_BYTES - contextBytes));
        contextBytes += Buffer.byteLength(context);
      }
    }
    conflicts.push({ path: safe, ...(context ? { context } : {}) });
  }
  return conflicts;
}

/**
 * Three-way merges a session's workspace tree into the target checkout, in a scratch index and work
 * tree so the real worktree is never touched. Returns the merged checkout, or the conflicting paths.
 */
export async function mergeWorkspaceChanges(
  repositoryCwd: string,
  baselineTree: string,
  target: CheckoutState,
  source: CheckoutState,
): Promise<WorkspaceApplyResult> {
  if (
    !objectId.test(baselineTree) ||
    !objectId.test(target.indexTree) ||
    !objectId.test(target.worktreeTree) ||
    !objectId.test(source.indexTree) ||
    !objectId.test(source.worktreeTree)
  ) {
    throw Error("Invalid workspace state.");
  }
  const repository = await inspectGitWorkspace(repositoryCwd);
  if (
    !repository ||
    canonical(repository.commonDir) !== canonical(target.commonDir) ||
    canonical(repository.commonDir) !== canonical(source.commonDir)
  ) {
    throw Error("Workspace states belong to different repositories.");
  }
  if (source.worktreeTree === baselineTree) return { state: "unchanged", checkout: target };

  const directory = await mkdtemp(join(tmpdir(), "pylon-apply-"));
  const workTree = join(directory, "worktree");
  const env = { GIT_INDEX_FILE: join(directory, "index"), GIT_WORK_TREE: workTree };
  await mkdir(workTree);
  try {
    await git(repository.root, ["read-tree", "-m", baselineTree, target.worktreeTree, source.worktreeTree], env);
    const merged =
      (await git(repository.root, ["merge-index", "git-merge-one-file", "-a"], env).then(
        () => true,
        () => false,
      )) || (await autoResolveConflicts(repository.root, env));
    if (!merged) return { state: "conflict", conflicts: await describeConflicts(repository.root, env, workTree) };

    const worktreeTree = await git(repository.root, ["write-tree"], env);
    if (!objectId.test(worktreeTree)) throw Error("Git returned an invalid merged tree.");
    return {
      state: worktreeTree === target.worktreeTree ? "unchanged" : "applied",
      checkout: { ...target, worktreeTree },
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function snapshotSessionBranch(
  repositoryCwd: string,
  branch: string,
  expectedCommonDir: string,
  tree: string,
): Promise<string> {
  if (!ownedBranch.test(branch) || !objectId.test(tree)) {
    throw Error("Invalid Pylon session snapshot.");
  }
  const repository = await inspectGitWorkspace(repositoryCwd);
  if (!repository || canonical(repository.commonDir) !== canonical(expectedCommonDir)) {
    throw Error("Session branch belongs to a different repository.");
  }
  const previous = await git(repository.root, ["rev-parse", "--verify", branch]);
  const snapshot = await git(
    repository.root,
    ["commit-tree", tree, "-p", previous, "-m", "Pylon session apply snapshot"],
    ident,
  );
  if (!objectId.test(snapshot)) throw Error("Git returned an invalid session snapshot.");
  await git(repository.root, ["update-ref", branch, snapshot, previous]);
  return snapshot;
}

async function emptyTreeOf(cwd: string): Promise<string> {
  return temporaryIndex(async env => {
    await git(cwd, ["read-tree", "--empty"], env);
    return git(cwd, ["write-tree"], env);
  });
}

async function workspaceBaseline(cwd: string, baselineTree?: string): Promise<string> {
  if (baselineTree) return baselineTree;
  try {
    return await git(cwd, ["rev-parse", "--verify", "HEAD^{tree}"]);
  } catch (error) {
    if (!(await headRef(cwd))) throw error;
    return emptyTreeOf(cwd);
  }
}

const GITLINK_MODE = "160000";

/** Registered submodule gitlinks (mode 160000) taken only from index and baseline tree metadata; never .gitmodules URLs or arbitrary embedded repositories. */
async function registeredGitlinks(cwd: string, baselineTree?: string): Promise<Map<string, string>> {
  const links = new Map<string, string>();
  const stage = splitNul(await git(cwd, ["ls-files", "-z", "-s"]).catch(() => ""));
  for (const record of stage) {
    const tab = record.indexOf("\t");
    if (tab < 0 || record.slice(0, record.indexOf(" ")) !== GITLINK_MODE) continue;
    links.set(record.slice(tab + 1), "");
  }
  if (!baselineTree) return links;
  const tree = splitNul(await git(cwd, ["ls-tree", "-rz", baselineTree]).catch(() => ""));
  for (const record of tree) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, , object] = record.slice(0, tab).split(" ");
    if (mode !== GITLINK_MODE || !object || !objectId.test(object)) continue;
    links.set(record.slice(tab + 1), object);
  }
  return links;
}

interface SubmoduleNode {
  /** Flat workspace-relative prefix of the submodule checkout. */
  path: string;
  /** Physical root of the initialized submodule checkout. */
  root: string;
  /** Nested baseline tree/commit recorded by the parent's gitlink, or the nested repo's empty tree when absent. */
  baselineTree: string;
  current: CheckoutState;
}

/** Recursively discovers initialized registered submodules whose checkouts stay confined under the canonical top workspace root. */
async function discoverSubmodules(
  topRoot: string,
  baselineTree: string,
): Promise<{
  nodes: SubmoduleNode[];
  markers: string[];
  /** Per repository level (prefix "" = superproject) the relative gitlink names registered in its index/baseline tree. */
  levels: Map<string, Set<string>>;
}> {
  const physicalTop = await realpath(topRoot);
  const nodes: SubmoduleNode[] = [];
  const markers: string[] = [];
  const levels = new Map<string, Set<string>>();
  const visited = new Set<string>();
  async function walk(prefix: string, cwd: string, baseline?: string, depth = 0): Promise<void> {
    if (depth > MAX_SUBMODULE_DEPTH || nodes.length >= MAX_TURN_REPOSITORIES) return;
    const links = await registeredGitlinks(cwd, baseline);
    levels.set(
      prefix,
      new Set(
        [...links.keys()].filter(name => {
          try {
            safeRelativePath(name);
            return true;
          } catch {
            return false;
          }
        }),
      ),
    );
    for (const name of [...links.keys()].sort((left, right) => left.localeCompare(right))) {
      let safe: string;
      try {
        safe = safeRelativePath(name);
      } catch {
        continue;
      }
      const full = prefix ? `${prefix}/${safe}` : safe;
      markers.push(full);
      const absolute = resolve(cwd, safe);
      const info = await lstat(absolute).catch(() => undefined);
      if (!info?.isDirectory() || info.isSymbolicLink()) continue;
      // Confinement: the submodule checkout must physically stay beneath the top workspace root.
      const physical = await realpath(absolute);
      if (outside(physicalTop, physical)) continue;
      // Only an initialized submodule rooted here qualifies; never follow arbitrary nested repositories.
      const topLevel = await git(absolute, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
      if (!topLevel || canonical(await realpath(topLevel)) !== canonical(physical)) continue;
      const current = await captureCheckoutState(absolute).catch(() => undefined);
      if (!current) continue;
      const identity = canonical(current.commonDir);
      if (visited.has(identity) || nodes.length >= MAX_TURN_REPOSITORIES) continue;
      visited.add(identity);
      const recorded = links.get(name)!;
      nodes.push({
        path: full,
        root: current.root,
        baselineTree: recorded || (await emptyTreeOf(current.root)),
        current,
      });
      await walk(full, current.root, recorded || undefined, depth + 1);
    }
  }
  await walk("", physicalTop, baselineTree);
  markers.sort((left, right) => left.localeCompare(right));
  nodes.sort((left, right) => left.path.localeCompare(right.path));
  return { nodes, markers, levels };
}

const underAnyMarker = (markers: string[]) => (path: string) =>
  markers.some(marker => path === marker || path.startsWith(`${marker}/`));

function owningSubmodule(nodes: SubmoduleNode[], path: string): SubmoduleNode | undefined {
  let owner: SubmoduleNode | undefined;
  for (const node of nodes) {
    if (path.startsWith(`${node.path}/`) && (!owner || node.path.length > owner.path.length)) owner = node;
  }
  return owner;
}

interface WorkspaceScope {
  current: CheckoutState;
  baseline: string;
  submodules: SubmoduleNode[];
  markers: string[];
  /** Per repository level (prefix "" = superproject) the relative registered gitlink names. */
  levels: Map<string, Set<string>>;
  underSubmodule(path: string): boolean;
  ownerOf(path: string): SubmoduleNode | undefined;
  revision: string;
  unapplicableSubmoduleChanges: boolean;
}

async function workspaceScope(cwd: string, baselineTree?: string): Promise<WorkspaceScope> {
  const baseline = await workspaceBaseline(cwd, baselineTree);
  const current = await captureCheckoutState(cwd);
  const { nodes, markers, levels } = await discoverSubmodules(current.root, baseline);
  // Nested state aggregates into the revision so nested-only changes refresh the Files views.
  const hash = createHash("sha256").update(`${baseline}\n${current.worktreeTree}\n${current.indexTree}`);
  let unapplicableSubmoduleChanges = false;
  for (const node of nodes) {
    hash.update(`\n${node.path}\n${node.current.worktreeTree}\n${node.current.indexTree}`);
    const headTree = await git(node.root, ["rev-parse", "--verify", "HEAD^{tree}"]).catch(() => emptyTreeOf(node.root));
    if (node.current.worktreeTree !== headTree || node.current.indexTree !== headTree) {
      unapplicableSubmoduleChanges = true;
    }
  }
  return {
    current,
    baseline,
    submodules: nodes,
    markers,
    levels,
    underSubmodule: underAnyMarker(markers),
    ownerOf: path => owningSubmodule(nodes, path),
    revision: hash.digest("base64url").slice(0, 24),
    unapplicableSubmoduleChanges,
  };
}

async function scopeChanges(scope: WorkspaceScope): Promise<WorkspaceFile[]> {
  const files = (await changesBetween(scope.current.root, scope.baseline, scope.current.worktreeTree)).filter(
    file => !scope.underSubmodule(file.path),
  );
  for (const node of scope.submodules) {
    try {
      const nested = await changesBetween(node.root, node.baselineTree, node.current.worktreeTree);
      for (const file of nested) {
        const path = `${node.path}/${file.path}`;
        if (!scope.underSubmodule(path) || scope.ownerOf(path)?.path === node.path) files.push({ ...file, path });
      }
    } catch {
      // A missing nested baseline commit degrades to no nested change entries rather than misreading through the parent.
    }
  }
  return files;
}

async function scopeListings(scope: WorkspaceScope): Promise<{ present: string[]; base: string[] }> {
  const gitlinksAt = (prefix: string) => scope.levels.get(prefix) ?? new Set<string>();
  // Each repository level only strips its own direct gitlink entries; nested submodule contents stay inventoried flat.
  const present = splitNul(
    await git(scope.current.root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
  ).filter(path => !gitlinksAt("").has(path));
  const base = splitNul(await git(scope.current.root, ["ls-tree", "-rz", "--name-only", scope.baseline])).filter(
    path => !gitlinksAt("").has(path),
  );
  for (const node of scope.submodules) {
    const prefix = `${node.path}/`;
    const links = gitlinksAt(node.path);
    present.push(
      ...splitNul(await git(node.root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]))
        .filter(path => !links.has(path))
        .map(path => `${prefix}${path}`),
    );
    const nestedBase = await git(node.root, ["ls-tree", "-rz", "--name-only", node.baselineTree]).catch(() => "");
    base.push(
      ...splitNul(nestedBase)
        .filter(path => !links.has(path))
        .map(path => `${prefix}${path}`),
    );
  }
  return { present, base };
}

async function changesBetween(cwd: string, baselineTree: string, tree: string): Promise<WorkspaceFile[]> {
  const [numstat, names] = await Promise.all([
    git(cwd, ["diff", "--numstat", "-z", "--no-renames", baselineTree, tree]),
    git(cwd, ["diff", "--name-status", "-z", "--no-renames", baselineTree, tree]),
  ]);
  const status = new Map<string, "added" | "modified" | "deleted">();
  const nameParts = splitNul(names);
  for (let index = 0; index + 1 < nameParts.length; index += 2) {
    const kind = nameParts[index].slice(0, 1);
    const path = nameParts[index + 1];
    if (!path) continue;
    status.set(path, kind === "A" ? "added" : kind === "D" ? "deleted" : "modified");
  }
  const files: WorkspaceFile[] = [];
  for (const record of splitNul(numstat).slice(0, 5_000)) {
    const [added, deleted, ...pathParts] = record.split("\t");
    const path = pathParts.join("\t");
    if (!path) continue;
    const safe = safeRelativePath(path);
    files.push(
      added === "-" || deleted === "-"
        ? { path: safe, status: status.get(path), binary: true }
        : { path: safe, status: status.get(path), additions: Number(added), deletions: Number(deleted) },
    );
  }
  return files;
}

export async function inspectWorkspaceChanges(cwd: string, baselineTree?: string): Promise<WorkspaceChangeList> {
  const scope = await workspaceScope(cwd, baselineTree);
  return {
    revision: scope.revision,
    files: (await scopeChanges(scope)).slice(0, 5_000),
    ...(scope.unapplicableSubmoduleChanges ? { unapplicableSubmoduleChanges: true } : {}),
  };
}

export async function inspectTreeChanges(cwd: string, baselineTree: string, tree: string): Promise<WorkspaceFile[]> {
  if (!objectId.test(baselineTree) || !objectId.test(tree)) throw Error("Invalid workspace tree.");
  return changesBetween(cwd, baselineTree, tree);
}

export async function collectWorkspaceFiles(options: {
  cwd: string;
  baselineTree?: string;
  query?: string;
}): Promise<WorkspaceFileInventory> {
  const query = (options.query ?? "").trim().toLocaleLowerCase().slice(0, 200);
  const scope = await workspaceScope(options.cwd, options.baselineTree);
  const { present, base } = await scopeListings(scope);
  const changed = new Map((await scopeChanges(scope)).map(file => [file.path, file]));
  const files = [...new Set([...present, ...base])].map(safeRelativePath);
  // Registered-but-empty submodules stay visible as non-selectable folders instead of disappearing.
  const folders = new Set(
    scope.markers.filter(marker => !files.some(path => path === marker || path.startsWith(`${marker}/`))),
  );
  const allPaths = [...new Set([...files, ...folders])]
    .filter(path => !query || path.toLocaleLowerCase().includes(query))
    .sort((left, right) => Number(changed.has(right)) - Number(changed.has(left)) || left.localeCompare(right));
  const truncated = allPaths.length > MAX_WORKSPACE_FILES;
  const paths = allPaths.slice(0, MAX_WORKSPACE_FILES);
  return {
    revision: scope.revision,
    files: paths.map(
      path => changed.get(path) ?? (folders.has(path) ? { path, kind: "submodule" as const } : { path }),
    ),
    totalCount: paths.length,
    truncated,
  };
}

/** Authoritatively refreshes exact file paths without rebuilding the full workspace listing. */
export async function collectWorkspaceFileDelta(options: {
  cwd: string;
  baselineTree?: string;
  paths: string[];
}): Promise<WorkspaceFileDelta> {
  const paths = [...new Set(options.paths.slice(0, 100).map(safeRelativePath))];
  const scope = await workspaceScope(options.cwd, options.baselineTree);
  const changed = new Map((await scopeChanges(scope)).map(file => [file.path, file]));
  const upserted: WorkspaceFile[] = [];
  const removed: string[] = [];
  let reconcileRequired = options.paths.length > 100;
  for (const path of paths) {
    const owner = scope.ownerOf(path);
    if (!owner && scope.underSubmodule(path)) {
      reconcileRequired = true;
      continue;
    }
    const inner = owner ? path.slice(owner.path.length + 1) : path;
    const root = owner ? owner.root : scope.current.root;
    const baseline = owner ? owner.baselineTree : scope.baseline;
    const absolute = resolve(root, inner);
    if (outside(root, absolute)) {
      reconcileRequired = true;
      continue;
    }
    const current = await lstat(absolute).catch(() => undefined);
    if (current?.isDirectory()) {
      reconcileRequired = true;
      continue;
    }
    const baseType = await git(root, ["cat-file", "-t", `${baseline}:${inner}`]).catch(() => undefined);
    if (baseType && baseType !== "blob") {
      reconcileRequired = true;
      continue;
    }
    const change = changed.get(path);
    if (change) {
      upserted.push(change);
    } else if (current && baseType === "blob") {
      upserted.push({ path });
    } else if (!current && !baseType) {
      removed.push(path);
    } else {
      // A one-sided path without a bounded change record may have fallen outside Git's change cap.
      reconcileRequired = true;
    }
  }
  return { revision: scope.revision, upserted, removed, reconcileRequired };
}

function pageWorkspaceFiles(
  inventory: WorkspaceFileInventory,
  cursor?: string,
  requestedLimit?: number,
): WorkspaceFilePage {
  const limit = Math.min(200, Math.max(1, requestedLimit ?? 200));
  const paths = inventory.files;
  const offset = cursor ? Number(Buffer.from(cursor, "base64url").toString("utf8")) : 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > paths.length) throw Error("Invalid file cursor.");
  const files = paths.slice(offset, offset + limit);
  const next = offset + files.length;
  return {
    ...inventory,
    files,
    ...(next < paths.length ? { nextCursor: Buffer.from(String(next)).toString("base64url") } : {}),
  };
}

export async function listWorkspaceFiles(options: {
  cwd: string;
  baselineTree?: string;
  query?: string;
  cursor?: string;
  limit?: number;
}): Promise<WorkspaceFilePage> {
  return pageWorkspaceFiles(await collectWorkspaceFiles(options), options.cursor, options.limit);
}

function binary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8_192).includes(0);
}

export async function readWorkspaceFile(options: {
  cwd: string;
  path: string;
  baselineTree?: string;
  view?: "current" | "base";
  maxBytes?: number;
}): Promise<WorkspaceFileContent> {
  const maxBytes = Math.min(1024 * 1024, Math.max(1, options.maxBytes ?? 1024 * 1024));
  const path = safeRelativePath(options.path);
  const scope = await workspaceScope(options.cwd, options.baselineTree);
  const owner = scope.ownerOf(path);
  // Descendant paths route through the deepest owning initialized submodule; everything else stays in the superproject.
  if (!owner && scope.underSubmodule(path)) {
    return { revision: scope.revision, path, state: "deleted" };
  }
  const inner = owner ? path.slice(owner.path.length + 1) : path;
  const root = owner ? owner.root : scope.current.root;
  let content: Buffer;
  if (options.view === "base") {
    const object = `${owner ? owner.baselineTree : scope.baseline}:${inner}`;
    const rawSize = await git(root, ["cat-file", "-s", object]).catch(() => undefined);
    if (rawSize === undefined) return { revision: scope.revision, path, state: "deleted" };
    const size = Number(rawSize);
    if (!Number.isSafeInteger(size) || size > maxBytes) return { revision: scope.revision, path, state: "oversized" };
    content = Buffer.from(await git(root, ["show", object], {}, maxBytes + 1));
  } else {
    try {
      const file = await confinedFile(root, inner);
      const size = (await stat(file)).size;
      if (size > maxBytes) return { revision: scope.revision, path, state: "oversized" };
      content = await readFile(file);
    } catch (error: any) {
      if (error?.code === "ENOENT") return { revision: scope.revision, path, state: "deleted" };
      throw error;
    }
  }
  if (binary(content)) return { revision: scope.revision, path, state: "binary" };
  if (content.byteLength > maxBytes) return { revision: scope.revision, path, state: "oversized" };
  return { revision: scope.revision, path, state: "available", text: content.toString("utf8") };
}

export async function diffWorkspaceFile(options: {
  cwd: string;
  baselineTree?: string;
  path: string;
  maxBytes?: number;
  maxLines?: number;
}): Promise<WorkspaceFileDiff> {
  const maxBytes = Math.min(2 * 1024 * 1024, Math.max(1, options.maxBytes ?? 2 * 1024 * 1024));
  const maxLines = Math.min(20_000, Math.max(1, options.maxLines ?? 20_000));
  const path = safeRelativePath(options.path);
  const scope = await workspaceScope(options.cwd, options.baselineTree);
  const owner = scope.ownerOf(path);
  // Uninitialized registered submodules degrade to an empty diff instead of misreading gitlink output through the parent.
  if (!owner && scope.underSubmodule(path)) {
    return { revision: scope.revision, path, state: "available" };
  }
  const inner = owner ? path.slice(owner.path.length + 1) : path;
  const output = await git(
    owner ? owner.root : scope.current.root,
    [
      "diff",
      "--no-ext-diff",
      "--no-renames",
      "--unified=3",
      owner ? owner.baselineTree : scope.baseline,
      owner ? owner.current.worktreeTree : scope.current.worktreeTree,
      "--",
      inner,
    ],
    {},
    maxBytes + 1,
  );
  if (output.includes("Binary files ") || output.includes("GIT binary patch")) {
    return { revision: scope.revision, path, state: "binary" };
  }
  const lines = output.split(/\r?\n/);
  if (Buffer.byteLength(output, "utf8") > maxBytes || lines.length > maxLines) {
    const bounded = lines.slice(0, maxLines).join("\n");
    return {
      revision: scope.revision,
      path,
      state: "oversized",
      text: Buffer.from(bounded).subarray(0, maxBytes).toString("utf8"),
      truncated: true,
    };
  }
  return { revision: scope.revision, path, state: "available", text: output };
}

export async function collectPlainWorkspaceFiles(options: {
  cwd: string;
  query?: string;
}): Promise<WorkspaceFileInventory> {
  const root = await realpath(options.cwd);
  const query = (options.query ?? "").trim().toLocaleLowerCase().slice(0, 200);
  const paths: string[] = [];
  const pending = [root];
  let scanned = 0;
  while (pending.length && scanned <= MAX_WORKSPACE_FILES) {
    const directory = pending.shift()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const absolute = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      scanned++;
      const path = relative(root, absolute).replaceAll("\\", "/");
      if (!query || path.toLocaleLowerCase().includes(query)) paths.push(safeRelativePath(path));
      if (scanned > MAX_WORKSPACE_FILES) break;
    }
  }
  paths.sort((left, right) => left.localeCompare(right));
  const truncated = scanned > MAX_WORKSPACE_FILES || pending.length > 0;
  paths.length = Math.min(paths.length, MAX_WORKSPACE_FILES);
  const revision = createHash("sha256").update(paths.join("\0")).digest("base64url").slice(0, 24);
  return { revision, files: paths.map(path => ({ path })), totalCount: paths.length, truncated };
}

export async function listPlainWorkspaceFiles(options: {
  cwd: string;
  query?: string;
  cursor?: string;
  limit?: number;
}): Promise<WorkspaceFilePage> {
  return pageWorkspaceFiles(await collectPlainWorkspaceFiles(options), options.cursor, options.limit);
}

export async function readPlainWorkspaceFile(cwd: string, path: string): Promise<WorkspaceFileContent> {
  const root = await realpath(cwd);
  const safe = safeRelativePath(path);
  try {
    const file = await confinedFile(root, safe);
    const info = await stat(file);
    if (info.size > 1024 * 1024) return { revision: "non-git", path: safe, state: "oversized" };
    const content = await readFile(file);
    if (binary(content)) return { revision: "non-git", path: safe, state: "binary" };
    return { revision: "non-git", path: safe, state: "available", text: content.toString("utf8") };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { revision: "non-git", path: safe, state: "deleted" };
    throw error;
  }
}
