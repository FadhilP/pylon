import { realpath } from "node:fs/promises";
import { git } from "./git.ts";
import { canonical, ident, objectId, ownedTurnRef, worktreeId } from "./worktree-internal.ts";
import {
  type TurnAnchor,
  type TurnRepositoryAnchor,
  type TurnTreeDiff,
  type WorktreeSnapshot,
} from "./worktree-types.ts";
import { validatedTurnRepositories } from "./worktree-summary.ts";
import { discoverSubmodules, inspectGitWorkspace } from "./worktree-checkout.ts";
import { directChildPath, matchedRepositorySnapshots, repositorySnapshot } from "./worktree-snapshot.ts";
import { branchWorktrees } from "./worktree-branches.ts";

/** Per-session turn refs: anchoring, migration, cleanup, and turn diffs. */

export function sessionWorktreeBranch(opaqueId: string): string {
  if (!worktreeId.test(opaqueId)) throw Error("Invalid worktree identifier.");
  return `refs/heads/pylon-worktree-${opaqueId}`;
}

export function sessionCheckoutBranch(opaqueId: string): string {
  if (!worktreeId.test(opaqueId)) throw Error("Invalid checkout identifier.");
  return `refs/heads/pylon-checkout-${opaqueId}`;
}

export function turnsBranchForSession(sessionId: string): string | undefined {
  return worktreeId.test(sessionId) ? `refs/pylon/turns/${sessionId}` : undefined;
}

function legacyTurnRef(branch: string): string {
  return `refs/heads/pylon-session-${branch.slice("refs/pylon/turns/".length)}`;
}

async function readCommitRef(root: string, ref: string): Promise<string | undefined> {
  const value = await git(root, ["rev-parse", "--verify", `${ref}^{commit}`]).catch(() => undefined);
  return value && objectId.test(value) ? value : undefined;
}

// TODO: Remove this single-session legacy fallback after the bulk migration compatibility window closes.
/** Copies a compatible legacy tip exactly, then removes the obsolete head with compare-and-swap. */
async function prepareTurnRef(root: string, branch: string): Promise<{ previous?: string } | undefined> {
  const legacy = legacyTurnRef(branch);
  let current = await readCommitRef(root, branch);
  const legacyTip = await readCommitRef(root, legacy);
  if (!current && legacyTip) {
    await git(root, ["update-ref", branch, legacyTip, ""]).catch(() => undefined);
    current = await readCommitRef(root, branch);
    if (!current) return undefined;
  }
  if (current && legacyTip) {
    if (current !== legacyTip) {
      const legacyIsAncestor = await git(root, ["merge-base", "--is-ancestor", legacyTip, current]).then(
        () => true,
        () => false,
      );
      if (!legacyIsAncestor) return undefined;
    }
    const checkedOut = branchWorktrees(await git(root, ["worktree", "list", "--porcelain"]));
    if (checkedOut.has(legacy)) return undefined;
    const removed = await git(root, ["update-ref", "-d", legacy, legacyTip]).then(
      () => true,
      () => false,
    );
    if (!removed || (await readCommitRef(root, legacy))) return undefined;
  }
  return current ? { previous: current } : {};
}

export async function legacyTurnRefSessionIds(cwd: string): Promise<string[]> {
  const workspace = await inspectGitWorkspace(cwd);
  if (!workspace) return [];
  const refs = await git(workspace.root, [
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname)",
    "refs/heads/pylon-session-*",
  ]);
  const prefix = "refs/heads/pylon-session-";
  return refs
    .split(/\r?\n/)
    .filter(ref => ref.startsWith(prefix) && worktreeId.test(ref.slice(prefix.length)))
    .map(ref => ref.slice(prefix.length))
    .slice(0, 500);
}

export async function migrateLegacyTurnRefs(
  cwd: string,
  sessionIds: Iterable<string>,
  protectedBranches: Iterable<string> = [],
): Promise<{ migrated: number; skipped: number }> {
  const workspace = await inspectGitWorkspace(cwd);
  if (!workspace) return { migrated: 0, skipped: 0 };
  const protectedRefs = new Set(protectedBranches);
  let migrated = 0;
  let skipped = 0;
  for (const sessionId of [...new Set(sessionIds)].slice(0, 500)) {
    const hidden = turnsBranchForSession(sessionId);
    if (!hidden) {
      skipped++;
      continue;
    }
    const legacy = legacyTurnRef(hidden);
    if (protectedRefs.has(legacy) || !(await readCommitRef(workspace.root, legacy))) {
      skipped++;
      continue;
    }
    const prepared = await prepareTurnRef(workspace.root, hidden);
    if (prepared && !(await readCommitRef(workspace.root, legacy))) migrated++;
    else skipped++;
  }
  return { migrated, skipped };
}

export async function appendTurnCommit(
  repositoryRootPath: string,
  branch: string,
  tree: string,
): Promise<string | undefined> {
  if (!ownedTurnRef.test(branch) || !objectId.test(tree)) return undefined;
  try {
    const root = await realpath(repositoryRootPath);
    const prepared = await prepareTurnRef(root, branch);
    if (!prepared) return undefined;
    const previous = prepared.previous;
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
  if (!ownedTurnRef.test(branch)) throw Error("Refusing to remove a non-Pylon turn ref.");
  try {
    const root = await realpath(repositoryRootPath);
    const current = await readCommitRef(root, branch);
    if (current) await git(root, ["update-ref", "-d", branch, current]);
  } catch {
    // Best-effort cleanup: a missing checkout or concurrently advanced ref is retained.
  }
}

/** Best-effort cleanup of turn refs in the top checkout and currently initialized submodules. */
export async function removeWorktreeTurnRefs(cwd: string, branch: string): Promise<void> {
  if (!ownedTurnRef.test(branch)) throw Error("Refusing to remove a non-Pylon turn ref.");
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
