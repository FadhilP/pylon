import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { activeAssistantEntryIds } from "./work-duration.ts";

function git(cwd: string, args: string[], env: Record<string, string> = {}, maxBuffer = 64 * 1024 * 1024) {
  return new Promise<string>((resolve, reject) =>
    execFile("git", args, {
      cwd,
      env: { ...process.env, ...env },
      maxBuffer,
      timeout: 120_000,
      windowsHide: true,
    }, (error, stdout, stderr) =>
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
const canonical = (path: string) => process.platform === "win32"
  ? resolve(path).toLowerCase()
  : resolve(path);
const outside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === ".." || path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(path);
};
const splitNul = (value: string) => value.split("\0").filter(Boolean);

function changedWorktreePaths(status: string): string[] {
  const records = splitNul(status);
  const paths = new Set<string>();
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if (record.length < 4) continue;
    paths.add(record.slice(3));
    if (/[RC]/.test(record.slice(0, 2)) && records[index + 1]) paths.add(records[++index]!);
  }
  return [...paths];
}

async function temporaryIndex<T>(run: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "pylon-worktree-"));
  try {
    return await run({ GIT_INDEX_FILE: join(directory, "index") });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function currentTree(root: string, head?: string, changedPaths?: string[]): Promise<string> {
  return temporaryIndex(async (env) => {
    await git(root, head ? ["read-tree", head] : ["read-tree", "--empty"], env);
    const boundedPaths = changedPaths?.length && changedPaths.length <= 500
      && changedPaths.reduce((size, path) => size + path.length + 1, 0) <= 24_000
      ? changedPaths.map((path) => `:(literal)${path}`)
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
  if (await git(workspace.root, ["rev-parse", "--is-bare-repository"]) === "true") {
    throw Error("Bare repositories are unsupported.");
  }
  if ((await git(workspace.root, ["ls-files", "-u"])).trim()) {
    throw Error("Unmerged Git index is unsupported.");
  }
  const gitDir = await git(workspace.root, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"]) {
    if (await stat(join(gitDir, name)).then(() => true).catch(() => false)) {
      throw Error("A Git operation is already in progress.");
    }
  }
  const paths = splitNul(await git(workspace.root, [
    "ls-files", "-z", "--cached", "--others", "--exclude-standard",
  ]));
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

export interface WorktreeSnapshot {
  root: string;
  tree: string;
  fingerprint: string;
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
}

export interface WorkspaceFilePage {
  revision: string;
  files: WorkspaceFile[];
  totalCount: number;
  truncated: boolean;
  nextCursor?: string;
}

export type WorkspaceFileInventory = Omit<WorkspaceFilePage, "nextCursor">;

export interface WorkspaceChangeList {
  revision: string;
  files: WorkspaceFile[];
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
const MAX_WORKSPACE_FILES = 10_000;

export interface PersistedWorktreeSummary {
  version: 1;
  assistantEntryId: string;
  files: WorktreeFileChange[];
}

function validSummaryPath(path: string): boolean {
  return path.length > 0
    && path.length <= 500
    && !path.startsWith("/")
    && !/^[A-Za-z]:\//.test(path)
    && !path.includes("\\")
    && !path.split("/").some((part) => !part || part === "." || part === "..");
}

export function createWorktreeSummary(
  assistantEntryId: string,
  values: WorktreeFileChange[],
): PersistedWorktreeSummary | undefined {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(assistantEntryId)) return undefined;
  const summary: PersistedWorktreeSummary = { version: 1, assistantEntryId, files: [] };
  for (const value of values.slice(0, MAX_SUMMARY_FILES)) {
    const path = value.path.replaceAll("\\", "/").slice(0, 500);
    if (!validSummaryPath(path)) continue;
    const file = value.binary === true
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
  if (raw.version !== 1
    || typeof raw.assistantEntryId !== "string"
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(raw.assistantEntryId)
    || !Array.isArray(raw.files)
    || raw.files.length === 0
    || raw.files.length > MAX_SUMMARY_FILES) return undefined;

  const files: WorktreeFileChange[] = [];
  for (const value of raw.files) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const file = value as Record<string, unknown>;
    if (typeof file.path !== "string" || !validSummaryPath(file.path)) return undefined;
    if (file.binary === true) {
      files.push({ path: file.path, binary: true });
      continue;
    }
    if (!Number.isSafeInteger(file.additions) || !Number.isSafeInteger(file.deletions)
      || Number(file.additions) < 0 || Number(file.additions) > 1_000_000
      || Number(file.deletions) < 0 || Number(file.deletions) > 1_000_000) return undefined;
    files.push({
      path: file.path,
      additions: Number(file.additions),
      deletions: Number(file.deletions),
    });
  }
  return { version: 1, assistantEntryId: raw.assistantEntryId, files };
}

export function readPersistedWorktreeSummaries(
  session: { getBranch(): unknown[]; getEntries(): unknown[] },
): Map<string, WorktreeFileChange[]> {
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

export async function worktreeSnapshot(cwd: string): Promise<WorktreeSnapshot | undefined> {
  try {
    const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
    const [revision, status] = await Promise.all([
      git(root, ["rev-parse", "HEAD", "HEAD^{tree}"]),
      git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    ]);
    const [head, headTree] = revision.split(/\r?\n/, 2);
    if (!head || !headTree) throw Error("Git returned an invalid HEAD revision.");
    if (!status) {
      return { root, tree: headTree, fingerprint: `${root}\n${head}\nclean` };
    }

    const [indexTree, candidateTree] = await Promise.all([
      git(root, ["write-tree"]),
      currentTree(root, "HEAD", changedWorktreePaths(status)),
    ]);
    const latestStatus = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const tree = latestStatus === status ? candidateTree : await currentTree(root, "HEAD");
    return { root, tree, fingerprint: `${root}\n${head}\n${indexTree}\n${tree}` };
  } catch {
    return undefined;
  }
}

export async function worktreeFingerprint(cwd: string): Promise<string | undefined> {
  return (await worktreeSnapshot(cwd))?.fingerprint;
}

export async function worktreeDiff(before: WorktreeSnapshot, after: WorktreeSnapshot): Promise<WorktreeFileChange[] | undefined> {
  if (before.root !== after.root) return undefined;
  try {
    const output = await git(before.root, ["diff", "--numstat", "-z", "--no-renames", before.tree, after.tree]);
    const files: WorktreeFileChange[] = [];
    for (const record of output.split("\0").filter(Boolean).slice(0, 500)) {
      const first = record.indexOf("\t");
      const second = record.indexOf("\t", first + 1);
      if (first < 0 || second < 0) continue;
      const added = record.slice(0, first);
      const deleted = record.slice(first + 1, second);
      const path = record.slice(second + 1);
      if (!path || path.length > 1_000) continue;
      if (added === "-" || deleted === "-") {
        files.push({ path, binary: true });
        continue;
      }
      const additions = Number(added);
      const deletions = Number(deleted);
      if (Number.isSafeInteger(additions) && Number.isSafeInteger(deletions)) {
        files.push({ path, additions, deletions });
      }
    }
    return files;
  } catch {
    return undefined;
  }
}

export async function inspectGitWorkspace(cwd: string): Promise<GitWorkspace | undefined> {
  try {
    const root = await realpath(await git(cwd, ["rev-parse", "--show-toplevel"]));
    return {
      root,
      commonDir: await commonDirectory(root),
      head: await head(root),
      headRef: await headRef(root),
    };
  } catch {
    return undefined;
  }
}

export function sessionWorktreeBranch(opaqueId: string): string {
  if (!worktreeId.test(opaqueId)) throw Error("Invalid worktree identifier.");
  return `refs/heads/pylon-session-${opaqueId}`;
}

async function createSessionBaseline(
  repositoryCwd: string,
  source: CheckoutState,
  opaqueId: string,
): Promise<{ repository: GitWorkspace; branch: string; baseline: string }> {
  if (!objectId.test(source.indexTree) || !objectId.test(source.worktreeTree)
    || (source.head && !objectId.test(source.head))) throw Error("Invalid checkout state.");
  const repository = await inspectGitWorkspace(repositoryCwd);
  if (!repository || canonical(repository.commonDir) !== canonical(source.commonDir)) {
    throw Error("Session baseline belongs to a different repository.");
  }
  await assertSafeCheckout(repository);
  const branch = sessionWorktreeBranch(opaqueId);
  const baseline = await git(repository.root, [
    "commit-tree", source.worktreeTree, ...(source.head ? ["-p", source.head] : []), "-m", "Pylon session baseline",
  ], ident);
  if (!objectId.test(baseline)) throw Error("Git returned an invalid baseline commit.");
  await git(repository.root, ["update-ref", branch, baseline, ""]);
  return { repository, branch, baseline };
}

export async function captureCheckoutState(cwd: string, validateForMutation = false): Promise<CheckoutState> {
  const workspace = await inspectGitWorkspace(cwd);
  if (!workspace) throw Error("Workspace is not a Git checkout.");
  if (validateForMutation) await assertSafeCheckout(workspace);
  const indexTree = await git(workspace.root, ["write-tree"]);
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
  if (outside(root, target) || canonical(root) === canonical(target)) throw Error("Refusing to remove an external worktree.");
  const repository = await inspectGitWorkspace(repositoryCwd);
  if (!repository || canonical(repository.commonDir) !== canonical(worktree.commonDir)) {
    throw Error("Worktree metadata belongs to a different repository.");
  }
  const listed = await git(repository.root, ["worktree", "list", "--porcelain"]);
  const registered = listed.split(/\r?\n\r?\n/).some((record) => {
    const line = record.split(/\r?\n/).find((value) => value.startsWith("worktree "));
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
  const registered = listed.split(/\r?\n\r?\n/).some((record) => {
    const line = record.split(/\r?\n/).find((value) => value.startsWith("worktree "));
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
  if (!objectId.test(target.indexTree) || !objectId.test(target.worktreeTree)
    || (target.head && !objectId.test(target.head))) throw Error("Invalid checkout state.");
  const current = await inspectGitWorkspace(cwd);
  if (!current || canonical(current.commonDir) !== canonical(target.commonDir)) {
    throw Error("Checkout state belongs to a different repository.");
  }
  await temporaryIndex(async (env) => {
    await git(current.root, ["read-tree", target.worktreeTree], env);
    const currentPaths = splitNul(await git(current.root, ["ls-files", "-z", "-co", "--exclude-standard"]));
    const targetPaths = new Set(splitNul(await git(current.root, [
      "ls-tree", "-rz", "--name-only", target.worktreeTree,
    ])));
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

export async function mergeWorkspaceChanges(
  repositoryCwd: string,
  baselineTree: string,
  target: CheckoutState,
  source: CheckoutState,
): Promise<WorkspaceApplyResult> {
  if (!objectId.test(baselineTree)
    || !objectId.test(target.indexTree) || !objectId.test(target.worktreeTree)
    || !objectId.test(source.indexTree) || !objectId.test(source.worktreeTree)) {
    throw Error("Invalid workspace state.");
  }
  const repository = await inspectGitWorkspace(repositoryCwd);
  if (!repository
    || canonical(repository.commonDir) !== canonical(target.commonDir)
    || canonical(repository.commonDir) !== canonical(source.commonDir)) {
    throw Error("Workspace states belong to different repositories.");
  }
  if (source.worktreeTree === baselineTree) {
    return { state: "unchanged", checkout: target };
  }

  const directory = await mkdtemp(join(tmpdir(), "pylon-apply-"));
  const workTree = join(directory, "worktree");
  const env = {
    GIT_INDEX_FILE: join(directory, "index"),
    GIT_WORK_TREE: workTree,
  };
  await mkdir(workTree);
  try {
    await git(repository.root, [
      "read-tree", "-m", baselineTree, target.worktreeTree, source.worktreeTree,
    ], env);
    let merged = await git(repository.root, [
      "merge-index", "git-merge-one-file", "-a",
    ], env).then(() => true, () => false);
    if (!merged) {
      const entries = splitNul(await git(repository.root, ["ls-files", "-u", "-z"], env));
      const conflicts = new Map<string, Map<number, { mode: string; object: string }>>();
      for (const entry of entries) {
        const match = /^(\d+) ([0-9a-f]+) ([123])\t(.+)$/i.exec(entry);
        if (!match) continue;
        const [, mode, object, stage, path] = match;
        const stages = conflicts.get(path) ?? new Map();
        stages.set(Number(stage), { mode, object });
        conflicts.set(path, stages);
      }
      for (const [path, stages] of conflicts) {
        const targetBlob = stages.get(2);
        const sourceBlob = stages.get(3);
        if (!targetBlob || !sourceBlob) continue;
        const [targetText, sourceText] = await Promise.all([
          git(repository.root, ["show", `:2:${safeRelativePath(path)}`], env).catch(() => undefined),
          git(repository.root, ["show", `:3:${safeRelativePath(path)}`], env).catch(() => undefined),
        ]);
        const selected = targetText !== undefined && sourceText !== undefined
          ? sourceText.includes(targetText)
            ? sourceBlob
            : targetText.includes(sourceText)
              ? targetBlob
              : undefined
          : undefined;
        if (selected) {
          await git(repository.root, [
            "update-index", "--add", "--cacheinfo", `${selected.mode},${selected.object},${safeRelativePath(path)}`,
          ], env);
        }
      }
      merged = !(await git(repository.root, ["ls-files", "-u"], env)).trim();
    }
    if (!merged) {
      const paths = [...new Set(splitNul(await git(repository.root, ["ls-files", "-u", "-z"], env))
        .map((entry) => entry.slice(entry.indexOf("\t") + 1))
        .filter(Boolean))]
        .slice(0, 100);
      const conflicts: WorkspaceApplyConflict[] = [];
      let contextBytes = 0;
      for (const path of paths) {
        const safe = safeRelativePath(path);
        let context: string | undefined;
        if (contextBytes < 32 * 1024) {
          const value = await readFile(resolve(workTree, safe)).catch(() => undefined);
          if (value && !value.includes(0)) {
            context = value.toString("utf8").slice(0, Math.min(4_096, 32 * 1024 - contextBytes));
            contextBytes += Buffer.byteLength(context);
          }
        }
        conflicts.push({ path: safe, ...(context ? { context } : {}) });
      }
      return { state: "conflict", conflicts };
    }
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
  const snapshot = await git(repository.root, [
    "commit-tree", tree, "-p", previous, "-m", "Pylon session apply snapshot",
  ], ident);
  if (!objectId.test(snapshot)) throw Error("Git returned an invalid session snapshot.");
  await git(repository.root, ["update-ref", branch, snapshot, previous]);
  return snapshot;
}

async function workspaceBaseline(cwd: string, baselineTree?: string): Promise<string> {
  if (baselineTree) return baselineTree;
  try {
    return await git(cwd, ["rev-parse", "--verify", "HEAD^{tree}"]);
  } catch (error) {
    if (!await headRef(cwd)) throw error;
    return temporaryIndex(async (env) => {
      await git(cwd, ["read-tree", "--empty"], env);
      return git(cwd, ["write-tree"], env);
    });
  }
}

async function workspaceRevision(cwd: string, baselineTree: string) {
  if (!objectId.test(baselineTree)) throw Error("Invalid workspace baseline.");
  const current = await captureCheckoutState(cwd);
  const revision = createHash("sha256")
    .update(`${baselineTree}\n${current.worktreeTree}\n${current.indexTree}`)
    .digest("base64url")
    .slice(0, 24);
  return { current, revision };
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
    files.push(added === "-" || deleted === "-"
      ? { path: safe, status: status.get(path), binary: true }
      : {
          path: safe,
          status: status.get(path),
          additions: Number(added),
          deletions: Number(deleted),
        });
  }
  return files;
}

export async function inspectWorkspaceChanges(cwd: string, baselineTree?: string): Promise<WorkspaceChangeList> {
  const baseline = await workspaceBaseline(cwd, baselineTree);
  const { current, revision } = await workspaceRevision(cwd, baseline);
  return {
    revision,
    files: (await changesBetween(current.root, baseline, current.worktreeTree)).slice(0, 5_000),
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
  const baseline = await workspaceBaseline(options.cwd, options.baselineTree);
  const { current, revision } = await workspaceRevision(options.cwd, baseline);
  const present = splitNul(await git(current.root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]));
  const base = splitNul(await git(current.root, ["ls-tree", "-rz", "--name-only", baseline]));
  const changed = new Map((await changesBetween(current.root, baseline, current.worktreeTree)).map((file) => [file.path, file]));
  const allPaths = [...new Set([...present, ...base])]
    .map(safeRelativePath)
    .filter((path) => !query || path.toLocaleLowerCase().includes(query))
    .sort((left, right) => Number(changed.has(right)) - Number(changed.has(left))
      || left.localeCompare(right));
  const truncated = allPaths.length > MAX_WORKSPACE_FILES;
  const paths = allPaths.slice(0, MAX_WORKSPACE_FILES);
  return {
    revision,
    files: paths.map((path) => changed.get(path) ?? { path }),
    totalCount: paths.length,
    truncated,
  };
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
  const baseline = await workspaceBaseline(options.cwd, options.baselineTree);
  const { current, revision } = await workspaceRevision(options.cwd, baseline);
  const path = safeRelativePath(options.path);
  let content: Buffer;
  if (options.view === "base") {
    const object = `${baseline}:${path}`;
    const rawSize = await git(current.root, ["cat-file", "-s", object]).catch(() => undefined);
    if (rawSize === undefined) return { revision, path, state: "deleted" };
    const size = Number(rawSize);
    if (!Number.isSafeInteger(size) || size > maxBytes) return { revision, path, state: "oversized" };
    content = Buffer.from(await git(current.root, ["show", object], {}, maxBytes + 1));
  } else {
    try {
      const file = await confinedFile(current.root, path);
      const size = (await stat(file)).size;
      if (size > maxBytes) return { revision, path, state: "oversized" };
      content = await readFile(file);
    } catch (error: any) {
      if (error?.code === "ENOENT") return { revision, path, state: "deleted" };
      throw error;
    }
  }
  if (binary(content)) return { revision, path, state: "binary" };
  if (content.byteLength > maxBytes) return { revision, path, state: "oversized" };
  return { revision, path, state: "available", text: content.toString("utf8") };
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
  const baseline = await workspaceBaseline(options.cwd, options.baselineTree);
  const { current, revision } = await workspaceRevision(options.cwd, baseline);
  const output = await git(current.root, [
    "diff", "--no-ext-diff", "--no-renames", "--unified=3",
    baseline, current.worktreeTree, "--", path,
  ], {}, maxBytes + 1);
  if (output.includes("Binary files ") || output.includes("GIT binary patch")) {
    return { revision, path, state: "binary" };
  }
  const lines = output.split(/\r?\n/);
  if (Buffer.byteLength(output, "utf8") > maxBytes || lines.length > maxLines) {
    const bounded = lines.slice(0, maxLines).join("\n");
    return {
      revision,
      path,
      state: "oversized",
      text: Buffer.from(bounded).subarray(0, maxBytes).toString("utf8"),
      truncated: true,
    };
  }
  return { revision, path, state: "available", text: output };
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
  return {
    revision,
    files: paths.map((path) => ({ path })),
    totalCount: paths.length,
    truncated,
  };
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
