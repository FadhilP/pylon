import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<string>((resolve, reject) =>
    execFile("git", args, {
      cwd,
      env: { ...process.env, ...env },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
      windowsHide: true,
    }, (error, stdout, stderr) =>
      error
        ? reject(Error(String(stderr || error.message).slice(0, 8192)))
        : resolve(String(stdout).replace(/\r?\n$/, "")),
    ),
  );
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

export async function worktreeSnapshot(cwd: string): Promise<WorktreeSnapshot | undefined> {
  try {
    const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
    const [head, status] = await Promise.all([
      git(root, ["rev-parse", "HEAD"]),
      git(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
    ]);
    if (!status) {
      const tree = await git(root, ["rev-parse", "HEAD^{tree}"]);
      return { root, tree, fingerprint: `${root}\n${head}\nclean` };
    }

    const indexTree = await git(root, ["write-tree"]);
    const dir = await mkdtemp(join(tmpdir(), "pylon-worktree-"));
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    try {
      await git(root, ["read-tree", "HEAD"], env);
      await git(root, ["add", "-A", "--", "."], env);
      const tree = await git(root, ["write-tree"], env);
      return { root, tree, fingerprint: `${root}\n${head}\n${indexTree}\n${tree}` };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
