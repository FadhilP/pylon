import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { git } from "./git.ts";
import { preflight } from "./safety.ts";
import type { RepositorySnapshot, Snapshot } from "./snapshot.ts";
const objectId = /^[0-9a-f]{40,64}$/i;
const paths = (value: string) => value.split("\0").filter(Boolean);
const canonical = (path: string) =>
  process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

function repositories(target: Snapshot): RepositorySnapshot[] {
  return [{
    prefix: "",
    gitRoot: target.gitRoot,
    head: target.head,
    headRef: target.headRef,
    worktreeRef: target.worktreeRef,
    indexRef: target.indexRef,
    worktreeTree: target.worktreeTree,
    indexTree: target.indexTree,
  }, ...(target.nested ?? [])];
}

async function apply(repository: RepositorySnapshot, worktreeIndex: string) {
  const env = { GIT_INDEX_FILE: worktreeIndex },
    currentPaths = paths(await git(repository.gitRoot, [
      "ls-files", "-z", "-co", "--exclude-standard",
    ])),
    targetPaths = paths(await git(repository.gitRoot, [
      "ls-tree", "-rz", "--name-only", repository.worktreeTree,
    ])),
    keep = new Set(targetPaths);
  for (const path of currentPaths)
    if (!keep.has(path)) {
      const absolute = resolve(repository.gitRoot, path),
        outside = relative(repository.gitRoot, absolute);
      if (
        outside === ".." ||
        outside.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
        path === ".git" ||
        path.startsWith(".git/")
      ) throw Error("Unsafe restore path.");
      await rm(absolute, { recursive: true, force: true });
    }
  await git(repository.gitRoot, ["checkout-index", "--all", "--force"], env);
  await git(repository.gitRoot, ["read-tree", repository.indexTree]);
}

export async function restore(target: Snapshot, cwd = target.gitRoot) {
  const targets = repositories(target);
  if (targets.some((repository) =>
    !objectId.test(repository.head) ||
    !objectId.test(repository.worktreeTree) ||
    !objectId.test(repository.indexTree)))
    throw Error("Invalid checkpoint object ID.");
  const current = await preflight(cwd);
  if (current.repositories.length !== targets.length)
    throw Error("Nested repository graph changed since checkpoint.");
  for (let index = 0; index < targets.length; index++) {
    const actual = current.repositories[index], expected = targets[index];
    if (actual.prefix !== expected.prefix || canonical(actual.root) !== canonical(expected.gitRoot))
      throw Error("Checkpoint belongs to a different repository graph.");
    if (actual.head !== expected.head)
      throw Error(`HEAD changed since checkpoint: ${expected.prefix || "."}`);
  }

  const dir = await mkdtemp(join(tmpdir(), "pi-timeline-")), indexes: string[] = [];
  try {
    // Validate every repository before deleting or overwriting any user files.
    for (let index = 0; index < targets.length; index++) {
      const worktreeIndex = join(dir, `worktree-${index}`),
        stagedIndex = join(dir, `staged-${index}`);
      await git(targets[index].gitRoot, [
        "fsck", "--no-dangling", "--no-reflogs", "--connectivity-only",
        targets[index].worktreeTree, targets[index].indexTree,
      ]);
      await git(targets[index].gitRoot, ["read-tree", targets[index].worktreeTree], {
        GIT_INDEX_FILE: worktreeIndex,
      });
      await git(targets[index].gitRoot, ["read-tree", targets[index].indexTree], {
        GIT_INDEX_FILE: stagedIndex,
      });
      indexes.push(worktreeIndex);
    }
    // Children first; outer gitlink checkout must not replace initialized child worktrees.
    for (let index = targets.length - 1; index >= 0; index--)
      await apply(targets[index], indexes[index]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
