import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { git } from "./git.ts";
import {
  assertSafeCheckout,
  canonical,
  commonDirectory,
  currentIndexTree,
  currentTree,
  head,
  headRef,
  MAX_SUBMODULE_DEPTH,
  MAX_TURN_REPOSITORIES,
  objectId,
  outside,
  parseWorktreeStatus,
  safeRelativePath,
  snapshotRetryDelaysMs,
  splitNul,
  temporaryIndex,
} from "./worktree-internal.ts";
import { type CheckoutState, type GitWorkspace } from "./worktree-types.ts";

/** Inspection of a checkout: its repository, HEAD, trees, and registered submodules. */

export async function inspectGitWorkspace(cwd: string): Promise<GitWorkspace | undefined> {
  try {
    const root = await realpath(await git(cwd, ["rev-parse", "--show-toplevel"]));
    return { root, commonDir: await commonDirectory(root), head: await head(root), headRef: await headRef(root) };
  } catch {
    return undefined;
  }
}

export async function captureCheckoutState(cwd: string, validateForMutation = false): Promise<CheckoutState> {
  const workspace = await inspectGitWorkspace(cwd);
  if (!workspace) throw Error("Workspace is not a Git checkout.");
  if (validateForMutation) await assertSafeCheckout(workspace);
  return { ...workspace, ...(await captureCheckoutTrees(workspace.root, workspace.head)) };
}

/** Capture with the caller's Git runner so its timeout policy also covers tree construction. */
export async function captureCheckoutTrees(root: string, expectedHead: string | undefined, runGit = git) {
  const readHead = () => {
    const pending = runGit(root, ["rev-parse", "--verify", "HEAD"]);
    return expectedHead ? pending : pending.catch(() => undefined);
  };
  // Recheck status/HEAD after construction, including the cheap clean path.
  for (let attempt = 0; attempt <= snapshotRetryDelaysMs.length; attempt++) {
    const rawStatus = await runGit(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
    const status = parseWorktreeStatus(rawStatus);
    const observedHead = await readHead();
    if (status.head !== (observedHead ?? "(initial)") || observedHead !== expectedHead) {
      if (attempt === snapshotRetryDelaysMs.length) break;
      await new Promise(resolve => setTimeout(resolve, snapshotRetryDelaysMs[attempt]));
      continue;
    }

    let indexTree: string;
    let worktreeTree: string;
    if (!status.dirty && expectedHead) {
      worktreeTree = indexTree = await runGit(root, ["rev-parse", `${expectedHead}^{tree}`]);
    } else if (!status.dirty) {
      worktreeTree = indexTree = await currentIndexTree(root, runGit);
    } else {
      // Drain both temporary indexes before reporting failure to the caller.
      const [index, worktree] = await Promise.allSettled([
        currentIndexTree(root, runGit),
        currentTree(root, expectedHead, status.paths, runGit),
      ]);
      if (index.status === "rejected") throw index.reason;
      if (worktree.status === "rejected") throw worktree.reason;
      indexTree = index.value;
      worktreeTree = worktree.value;
    }

    const [latestStatus, latestHead] = await Promise.all([
      runGit(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]),
      readHead(),
    ]);
    if (latestStatus === rawStatus && latestHead === expectedHead) return { indexTree, worktreeTree };
    if (attempt < snapshotRetryDelaysMs.length)
      await new Promise(resolve => setTimeout(resolve, snapshotRetryDelaysMs[attempt]));
  }
  throw Error("Git checkout changed during capture.");
}

export async function emptyTreeOf(cwd: string): Promise<string> {
  return temporaryIndex(async env => {
    await git(cwd, ["read-tree", "--empty"], env);
    return git(cwd, ["write-tree"], env);
  });
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

export interface SubmoduleNode {
  /** Flat workspace-relative prefix of the submodule checkout. */
  path: string;
  /** Physical root of the initialized submodule checkout. */
  root: string;
  /** Comparison tree: the parent's recorded gitlink for history, or this repository's HEAD for live Files views. */
  baselineTree: string;
  current: CheckoutState;
}

/** Recursively discovers initialized registered submodules whose checkouts stay confined under the canonical top workspace root. */
export async function discoverSubmodules(
  topRoot: string,
  baselineTree: string,
  baselineMode: "recorded" | "head" = "recorded",
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
      const nestedBaseline = (baselineMode === "head" ? current.head : recorded) || (await emptyTreeOf(current.root));
      nodes.push({ path: full, root: current.root, baselineTree: nestedBaseline, current });
      await walk(full, current.root, nestedBaseline, depth + 1);
    }
  }
  await walk("", physicalTop, baselineTree);
  markers.sort((left, right) => left.localeCompare(right));
  nodes.sort((left, right) => left.path.localeCompare(right.path));
  return { nodes, markers, levels };
}
