import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { git } from "./git.ts";
import {
  assertSafeCheckout,
  canonical,
  ident,
  objectId,
  outside,
  ownedWorktreeBranch,
  safeRelativePath,
  splitNul,
  temporaryIndex,
} from "./worktree-internal.ts";
import {
  type CheckoutState,
  type GitWorkspace,
  type SessionCheckout,
  type SessionWorktree,
  type WorkspaceApplyConflict,
  type WorkspaceApplyResult,
} from "./worktree-types.ts";
import { captureCheckoutState, inspectGitWorkspace } from "./worktree-checkout.ts";
import { sessionCheckoutBranch, sessionWorktreeBranch } from "./worktree-turns.ts";

/** Session worktrees and checkouts: creation, removal, restore, and merging changes back. */

async function createSessionBaseline(
  repositoryCwd: string,
  source: CheckoutState,
  opaqueId: string,
  kind: "worktree" | "checkout",
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
  const branch = kind === "worktree" ? sessionWorktreeBranch(opaqueId) : sessionCheckoutBranch(opaqueId);
  const baseline = await git(
    repository.root,
    ["commit-tree", source.worktreeTree, ...(source.head ? ["-p", source.head] : []), "-m", "Pylon session baseline"],
    ident,
  );
  if (!objectId.test(baseline)) throw Error("Git returned an invalid baseline commit.");
  await git(repository.root, ["update-ref", branch, baseline, ""]);
  return { repository, branch, baseline };
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
  const { repository, branch, baseline } = await createSessionBaseline(repositoryCwd, source, opaqueId, "worktree");
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
  const { repository, branch, baseline } = await createSessionBaseline(cwd, parked, opaqueId, "checkout");
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
  if (!ownedWorktreeBranch.test(worktree.branch)) throw Error("Refusing to remove a non-Pylon branch.");
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
  if (!ownedWorktreeBranch.test(branch)) throw Error("Refusing to use a non-Pylon branch.");
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
  if (!ownedWorktreeBranch.test(branch)) throw Error("Refusing to remove a non-Pylon branch.");
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
      if (!ownedWorktreeBranch.test(target.headRef) && target.headRef !== current.headRef) {
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
  if (!ownedWorktreeBranch.test(branch) || !objectId.test(tree)) {
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
