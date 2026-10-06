import { createHash } from "node:crypto";
import { git } from "./git.ts";
import {
  canonical,
  commonDirectory,
  currentTree,
  MAX_TURN_REPOSITORIES,
  parseWorktreeStatus,
  repositoryRoot,
  revisionCache,
  snapshotRetryDelaysMs,
} from "./worktree-internal.ts";
import { type WorktreeFileChange, type WorktreeRepositorySnapshot, type WorktreeSnapshot } from "./worktree-types.ts";
import { discoverSubmodules } from "./worktree-checkout.ts";

/** Fingerprints of the working tree across nested repositories, and diffs between two of them. */

export async function repositorySnapshot(cwd: string, path = ""): Promise<WorktreeRepositorySnapshot | undefined> {
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

export function matchedRepositorySnapshots(
  before: WorktreeSnapshot,
  after: WorktreeSnapshot,
): MatchedRepositorySnapshots[] {
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

export function directChildPath(parent: string, child: string, paths: Set<string>): string | undefined {
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
