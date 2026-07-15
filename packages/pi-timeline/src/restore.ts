import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { git } from "./git.ts";
import { preflight } from "./safety.ts";
import type { Snapshot } from "./snapshot.ts";
const objectId = /^[0-9a-f]{40,64}$/i;
const paths = (value: string) => value.split("\0").filter(Boolean);

export async function restore(
  target: Snapshot,
  cwd = target.gitRoot,
) {
  if (
    !objectId.test(target.head) ||
    !objectId.test(target.worktreeTree) ||
    !objectId.test(target.indexTree)
  )
    throw Error("Invalid checkpoint object ID.");
  const current = await preflight(cwd),
    canonical = (path: string) =>
      process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  if (canonical(current.root) !== canonical(target.gitRoot))
    throw Error("Checkpoint belongs to a different repository.");
  if (current.head !== target.head)
    throw Error("HEAD changed since checkpoint.");
  const dir = await mkdtemp(join(tmpdir(), "pi-timeline-")),
    index = join(dir, "worktree-index"),
    stagedIndex = join(dir, "staged-index"),
    env = { GIT_INDEX_FILE: index };
  try {
    // Validate both trees before deleting or overwriting user files.
    await git(target.gitRoot, ["read-tree", target.worktreeTree], env);
    await git(target.gitRoot, ["read-tree", target.indexTree], {
      GIT_INDEX_FILE: stagedIndex,
    });
    const currentPaths = paths(
        await git(target.gitRoot, [
          "ls-files",
          "-z",
          "-co",
          "--exclude-standard",
        ]),
      ),
      targetPaths = paths(
        await git(target.gitRoot, [
          "ls-tree",
          "-rz",
          "--name-only",
          target.worktreeTree,
        ]),
      ),
      keep = new Set(targetPaths);
    for (const path of currentPaths)
      if (!keep.has(path)) {
        const absolute = resolve(target.gitRoot, path),
          outside = relative(target.gitRoot, absolute);
        if (
          outside === ".." ||
          outside.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
          path === ".git" ||
          path.startsWith(".git/")
        )
          throw Error("Unsafe restore path.");
        await rm(absolute, { recursive: true, force: true });
      }
    await git(target.gitRoot, ["checkout-index", "--all", "--force"], env);
    await git(target.gitRoot, ["read-tree", target.indexTree]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
