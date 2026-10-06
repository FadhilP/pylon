import { git } from "./git.ts";
import { assertSafeCheckout, canonical, headRef, ownedWorktreeBranch, revisionCache } from "./worktree-internal.ts";
import { type LocalGitBranchList } from "./worktree-types.ts";
import { inspectGitWorkspace } from "./worktree-checkout.ts";

/** Listing and switching local branches. */

export function branchWorktrees(raw: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    const branch = block.match(/^branch (refs\/heads\/.+)$/m)?.[1];
    if (path && branch) result.set(branch, path);
  }
  return result;
}

/** Lists bounded local branch refs by newest tip commit, with deterministic ties. */
export async function listLocalGitBranches(cwd: string, limit = 500): Promise<LocalGitBranchList> {
  const workspace = await inspectGitWorkspace(cwd);
  if (!workspace) throw Error("Git branches are unavailable for this workspace.");
  if ((await git(workspace.root, ["rev-parse", "--is-bare-repository"])) === "true") {
    throw Error("Bare repositories are unsupported.");
  }
  const currentRef = workspace.headRef;
  const checkedOut = branchWorktrees(await git(workspace.root, ["worktree", "list", "--porcelain"]));
  const rows = (
    await git(workspace.root, ["for-each-ref", "--format=%(refname:lstrip=2)%00%(committerdate:unix)", "refs/heads"])
  )
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap(row => {
      const [name, rawTimestamp] = row.split("\0", 2);
      const timestamp = Number(rawTimestamp);
      if (!name || !Number.isSafeInteger(timestamp) || timestamp < 0) return [];
      const ref = `refs/heads/${name}`;
      if (ownedWorktreeBranch.test(ref)) return [];
      const otherWorktree = checkedOut.get(ref);
      const current = ref === currentRef;
      return [
        {
          name,
          timestamp,
          current,
          checkoutAvailable: !current && (!otherWorktree || canonical(otherWorktree) === canonical(workspace.root)),
          ...(otherWorktree && !current && canonical(otherWorktree) !== canonical(workspace.root)
            ? { checkoutUnavailableReason: "Checked out in another worktree." }
            : {}),
        },
      ];
    })
    .sort((left, right) => right.timestamp - left.timestamp || left.name.localeCompare(right.name));
  const boundedLimit = Math.min(500, Math.max(1, limit));
  return {
    branches: rows
      .slice(0, boundedLimit)
      .map(({ timestamp, ...branch }) => ({ ...branch, lastCommitAt: new Date(timestamp * 1_000).toISOString() })),
    ...(currentRef?.startsWith("refs/heads/") ? { currentBranch: currentRef.slice("refs/heads/".length) } : {}),
    truncated: rows.length > boundedLimit,
  };
}

/** Switches to an existing local branch while preserving changes Git considers safe to carry. */
export async function switchLocalGitBranch(cwd: string, branch: string): Promise<string> {
  if (!branch || branch.length > 200 || /[\u0000-\u001f\u007f]/.test(branch)) throw Error("Invalid branch name.");
  const workspace = await inspectGitWorkspace(cwd);
  if (!workspace) throw Error("Git branches are unavailable for this workspace.");
  await assertSafeCheckout(workspace);
  const checked = await git(workspace.root, ["check-ref-format", "--branch", branch]);
  if (checked !== branch) throw Error("Invalid branch name.");
  const targetRef = `refs/heads/${branch}`;
  await git(workspace.root, ["rev-parse", "--verify", `${targetRef}^{commit}`]);
  const listed = await listLocalGitBranches(workspace.root);
  const target = listed.branches.find(candidate => candidate.name === branch);
  if (!target) throw Error("Local branch is unavailable.");
  if (!target.checkoutAvailable && !target.current) {
    throw Error(target.checkoutUnavailableReason ?? "Branch checkout is unavailable.");
  }
  if (target.current) return branch;
  let failure: unknown;
  try {
    await git(workspace.root, ["switch", "--no-guess", branch]);
  } catch (error) {
    failure = error;
  }
  const actualRef = await headRef(workspace.root);
  revisionCache.delete(canonical(workspace.root));
  if (actualRef !== targetRef) {
    if (failure) throw failure;
    throw Error("Git did not switch to the requested branch.");
  }
  return branch;
}
