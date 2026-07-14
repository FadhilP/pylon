import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, symbolicHead } from "./git.ts";
import { preflight } from "./safety.ts";
export type Snapshot = {
  snapshotId: string;
  gitRoot: string;
  head: string;
  headRef?: string | null;
  worktreeRef: string;
  indexRef: string;
  worktreeTree: string;
  indexTree: string;
};
const ident = {
  GIT_AUTHOR_NAME: "pi-timeline",
  GIT_AUTHOR_EMAIL: "pi-timeline@local",
  GIT_COMMITTER_NAME: "pi-timeline",
  GIT_COMMITTER_EMAIL: "pi-timeline@local",
};

export async function worktreeFingerprint(cwd: string): Promise<string | undefined> {
  try {
    const { root, head } = await preflight(cwd),
      status = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (!status) return `${root}\n${head}\nclean`;

    const indexTree = await git(root, ["write-tree"]),
      dir = await mkdtemp(join(tmpdir(), "pi-timeline-fingerprint-")),
      index = join(dir, "index"),
      env = { GIT_INDEX_FILE: index };
    try {
      await git(root, ["read-tree", "HEAD"], env);
      await git(root, ["add", "-A", "--", "."], env);
      const worktreeTree = await git(root, ["write-tree"], env);
      return `${root}\n${head}\n${indexTree}\n${worktreeTree}`;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } catch {
    return undefined;
  }
}

export async function capture(
  cwd: string,
  sessionId: string,
): Promise<Snapshot> {
  const { root, head } = await preflight(cwd),
    headRef = await symbolicHead(root),
    id = randomBytes(6).toString("hex"),
    dir = await mkdtemp(join(tmpdir(), "pi-timeline-")),
    index = join(dir, "index");
  try {
    const indexTree = await git(root, ["write-tree"]);
    const env = { GIT_INDEX_FILE: index };
    await git(root, ["read-tree", "HEAD"], env);
    await git(root, ["add", "-A", "--", "."], env);
    const worktreeTree = await git(root, ["write-tree"], env),
      wc = await git(root, [
        "commit-tree",
        worktreeTree,
        "-p",
        head,
        "-m",
        "pi-timeline worktree checkpoint",
      ], ident),
      ic = await git(root, [
        "commit-tree",
        indexTree,
        "-p",
        head,
        "-m",
        "pi-timeline index checkpoint",
      ], ident),
      owner = createHash("sha256").update(sessionId).digest("hex").slice(0, 16),
      base = `refs/pi-timeline/${owner}/${id}`,
      worktreeRef = `${base}/worktree`,
      indexRef = `${base}/index`;
    await git(root, ["update-ref", worktreeRef, wc]);
    try {
      await git(root, ["update-ref", indexRef, ic]);
      if (await git(root, ["rev-parse", "HEAD"]) !== head)
        throw Error("HEAD changed during checkpoint.");
    } catch (error) {
      await git(root, ["update-ref", "-d", worktreeRef]).catch(() => {});
      await git(root, ["update-ref", "-d", indexRef]).catch(() => {});
      throw error;
    }
    return {
      snapshotId: id,
      gitRoot: root,
      head,
      headRef,
      worktreeRef,
      indexRef,
      worktreeTree,
      indexTree,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
